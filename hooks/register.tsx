import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import {
  DEFAULT_SKILL_PATH,
  GRAPH,
  PILL,
  PILL_BUSY,
  RESULT_LABEL,
  backlogDigest,
  cardFrom,
  changelogHead,
  checkProposal,
  checkedRows,
  clean,
  detailsFrom,
  entriesOf,
  extractJson,
  isApplyCall,
  isRunFile,
  isStamped,
  lastRunMarkdown,
  nextStepsOf,
  outcomeFrom,
  paneRows,
  parseConfig,
  pillFits,
  prFrom,
  promptFor,
  proposalDocument,
  reminder,
  reportOutcome,
  sha256Hex,
  sourceKey,
  stamp,
  systemPrompt,
  tableLines,
} from './board'
import type { Card, Config, Context, Entry, Outcome, Pr, RepoFile, Row, Sources } from './board'
import type { BoardCounts, BoardPhase, BoardRejected, BoardResult, BoardRow } from '../types'

const PANE = 'board-update'
const PANE_TITLE = 'Board Update'
const NO_COUNTS: BoardCounts = { cards: -1, prs: -1, backlog: -1, unreadable: 0, notices: [] }

const running = atom({ plugin: 'board', key: 'running' } as const, false)
const isTurnRunning = atom({ plugin: 'board', key: 'isTurnRunning' } as const, false)
const startupChecked = atom({ plugin: 'board', key: 'startupChecked' } as const, false)
const phase = atom({ plugin: 'board', key: 'phase' } as const, 'idle' as BoardPhase, { shape: 'phase-1' })
const rows = atom({ plugin: 'board', key: 'rows' } as const, [] as BoardRow[], { shape: 'rows-2' })
const results = atom({ plugin: 'board', key: 'results' } as const, [] as BoardResult[], { shape: 'results-1' })
const startedAt = atom({ plugin: 'board', key: 'startedAt' } as const, 0, { shape: 'startedAt-1' })
const tick = atom({ plugin: 'board', key: 'tick' } as const, 0, { shape: 'tick-1' })
const counts = atom({ plugin: 'board', key: 'counts' } as const, NO_COUNTS, { shape: 'counts-3' })
const rejected = atom({ plugin: 'board', key: 'rejected' } as const, [] as BoardRejected[], { shape: 'rejected-1' })
const note = atom({ plugin: 'board', key: 'note' } as const, '', { shape: 'note-1' })

const AZ_TIMEOUT_MS = 60_000
const GH_TIMEOUT_MS = 60_000
const MODEL_TIMEOUT_MS = 600_000
// apply.py starts no card after 120 s and cuts each az call at 30 s: its slowest
// card ends by 270 s, inside this limit.
const APPLY_TIMEOUT_MS = 330_000
const MAX_TOKENS = 32_000
const DETAILS_AT_ONCE = 6
const TOAST_MS = 8000
const RUN_FILE_REFUSAL =
  'confirm.json und proposals-*.json in ~/.claude/board schreibt nur der board-Mod (nach dem Druck auf Übernehmen), nie ein Werkzeug.'
const GUARD_REFUSAL =
  'apply.py schreibt aufs Planner-Board und läuft nur über den board-Mod nach Bestätigung im Fenster „Board Update“ (Knopf ▦ Board oder /board), nie per Bash.'

// What a run holds between the proposal and the press on Übernehmen; a hot
// reload drops it with the module (the pane then asks for a new run).
type Pending = { cfg: Config; dir: string; at: string; now: number; file: string; hash: string; rows: Row[]; isComplete: boolean }

type Collected = Sources & { unreadable: number; entries: Entry[]; nextSteps: string | null; standText: string | null; skill: string | null }
let pending: Pending | null = null
// The model call of the run in flight, for Abbrechen.
let stop: AbortController | null = null
let isCancelled = false
// Set on the first press on Übernehmen, before any await: one apply per proposal set.
let isApplying = false
let ticker: { cancel: () => void } | null = null

function toast($: EngineInterface, text: string): void {
  $.ui.toast(text, { timeoutMs: TOAST_MS })
}

function log($: EngineInterface, text: string): void {
  $.ui.log(text)
}

// One child process, no shell; its stdout, or an error naming the program.
async function exec($: EngineInterface, argv: string[], timeoutMs: number): Promise<string> {
  const ran = await $.process.run(argv, { timeoutMs })
  if (ran.exitCode !== 0 || ran.isStdoutTruncated) {
    const name = argv[0]?.split('/').pop() ?? '?'
    throw new Error(`${name}: ${clean(ran.stderr, 160) || `Exit ${ran.exitCode}`}`)
  }
  return ran.stdout
}

async function graphGet($: EngineInterface, cfg: Config, path: string): Promise<unknown> {
  return JSON.parse(await exec($, [cfg.azPath, 'rest', '--method', 'get', '--url', GRAPH + path], AZ_TIMEOUT_MS))
}

// Every card of the plan; the details (description, checklist, their etag)
// of the cards not in Done. Ids are checked before they enter a URL.
async function readCards($: EngineInterface, cfg: Config): Promise<{ cards: Card[]; unreadable: number }> {
  const tasks: unknown[] = []
  let path: string | null = `/planner/plans/${cfg.planId}/tasks`
  while (path !== null) {
    const page = (await graphGet($, cfg, path)) as { value?: unknown[]; '@odata.nextLink'?: unknown }
    tasks.push(...(page.value ?? []))
    const following = page['@odata.nextLink']
    path = typeof following === 'string' && following.startsWith(`${GRAPH}/`) ? following.slice(GRAPH.length) : null
  }

  if (tasks.length === 0) throw new Error('keine Karten gelesen (Plan leer, Rechte oder Anmeldung prüfen)')
  const cards = tasks.map(task => cardFrom(task, cfg)).filter((c): c is Card => c !== null)
  const open = cards.filter(c => c.bucket !== 'done')
  for (let i = 0; i < open.length; i += DETAILS_AT_ONCE) {
    await Promise.all(
      open.slice(i, i + DETAILS_AT_ONCE).map(async card => {
        const details = detailsFrom(await graphGet($, cfg, `/planner/tasks/${card.id}/details`))
        if (details !== null) card.details = details
      }),
    )
  }
  return { cards, unreadable: tasks.length - cards.length }
}

async function readPrs($: EngineInterface, cfg: Config, repo: string): Promise<Pr[]> {
  const fields = 'number,title,author,state,isDraft,mergedAt,updatedAt,headRefName'
  const out = await exec($, [cfg.ghPath, 'pr', 'list', '--repo', cfg.repos[repo] ?? '', '--state', 'all', '--limit', '40', '--json', fields], GH_TIMEOUT_MS)
  return (JSON.parse(out) as unknown[]).map(raw => prFrom(repo, raw)).filter((p): p is Pr => p !== null)
}

// A file at the branch head on GitHub: no fetch into a local clone.
async function readRepoFile($: EngineInterface, cfg: Config, file: RepoFile): Promise<string> {
  const slug = cfg.repos[file.repo] ?? ''
  return exec($, [cfg.ghPath, 'api', '-H', 'Accept: application/vnd.github.raw', `repos/${slug}/contents/${file.path}?ref=${file.ref}`], GH_TIMEOUT_MS)
}

// A config path with ~/ read under the home folder.
function local(path: string, homeDir: string): string {
  return path.startsWith('~/') ? `${homeDir}/${path.slice(2)}` : path
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

// The number of entries (## headings) in the backlog files.
function entryCount(texts: string[]): number {
  return texts.reduce((sum, text) => sum + text.split('\n').filter(line => line.startsWith('## ')).length, 0)
}

type Counted = (patch: Partial<BoardCounts>) => Promise<void>

async function collect($: EngineInterface, cfg: Config, today: string, homeDir: string, counted: Counted): Promise<Collected> {
  const [{ cards, unreadable }, prs, backlogs, changelog] = await Promise.all([
    readCards($, cfg).then(async got => {
      await counted({ cards: got.cards.length, unreadable: got.unreadable })
      return got
    }),
    Promise.all(Object.keys(cfg.repos).map(repo => readPrs($, cfg, repo))).then(async lists => {
      await counted({ prs: lists.flat().length })
      return lists
    }),
    Promise.all(cfg.backlogSources.map(file => readRepoFile($, cfg, file))).then(async texts => {
      await counted({ backlog: entryCount(texts) })
      return texts
    }),
    cfg.changelog === undefined ? Promise.resolve(null) : readRepoFile($, cfg, cfg.changelog),
  ])
  const files = cfg.backlogSources.map((file, i) => ({
    name: `${file.repo}/${file.path} (${file.ref}; DONE sections as heading only)`,
    text: backlogDigest(backlogs[i] ?? ''),
  }))
  if (cfg.changelog !== undefined && changelog !== null) {
    files.push({ name: `${cfg.changelog.repo}/${cfg.changelog.path} (${cfg.changelog.ref}; head)`, text: changelogHead(changelog) })
  }
  for (const path of cfg.statusFiles) {
    const text = await $.fs.read(local(path, homeDir)).catch(() => {
      throw new Error(`Standdatei ${baseName(path)} nicht lesbar`)
    })
    files.push({ name: `status file ${baseName(path)}`, text })
  }
  // The stand file's next steps feed the Sprint Backlog; without one, nothing is pulled.
  let nextSteps: string | null = null
  let standText: string | null = null
  if (cfg.standFile !== undefined) {
    const standFile = cfg.standFile
    const text = await $.fs.read(local(standFile, homeDir)).catch(() => {
      throw new Error(`standFile ${baseName(standFile)} nicht lesbar`)
    })
    nextSteps = nextStepsOf(text)
    standText = text
    // Its lines are the proof for In Progress; the model reads it once.
    if (!cfg.statusFiles.includes(standFile)) files.push({ name: `stand file ${baseName(standFile)}`, text })
  }
  // The create-backlog skill, read word for word at each run; without it no card is created.
  const skill = await $.fs.read(local(cfg.skillPath ?? DEFAULT_SKILL_PATH, homeDir)).catch(() => null)
  const entries = cfg.backlogSources.flatMap((file, i) => entriesOf(`${file.repo}/${file.path}`, backlogs[i] ?? ''))
  return { cards, prs: prs.flat(), files, today, unreadable, entries, nextSteps, standText, skill }
}

async function readConfig($: EngineInterface, dir: string): Promise<Config> {
  const text = await $.fs.read(`${dir}/config.json`).catch(() => null)
  if (text === null) throw new Error(`Konfiguration ${dir}/config.json fehlt (Vorlage: config.example.json im Mod-Ordner)`)
  const cfg = parseConfig(text)
  if (typeof cfg === 'string') throw new Error(`Konfiguration ${dir}/config.json: ${cfg}`)
  return cfg
}

async function home($: EngineInterface): Promise<string> {
  const value = (await $.env.get('HOME'))?.replace(/\/+$/, '')
  if (value === undefined || !value.startsWith('/')) throw new Error('HOME ist nicht gesetzt oder nicht absolut')
  return value
}

// A file tool's path into the run folder, by name: confirm.json or a proposals-*.json.
async function isRunFileFor($: EngineInterface, path: unknown): Promise<boolean> {
  return isRunFile(path, await home($))
}

function nearRunFolder(path: unknown): boolean {
  return typeof path === 'string' && path.includes('.claude/board')
}

function isoDate(at: number): string {
  return stamp(at).slice(0, 10)
}

// ---- the pane's phases ---------------------------------------------------------

async function setPhase($: EngineInterface, next: BoardPhase, line = ''): Promise<void> {
  const now = await $.clock.now()
  await update($, startedAt, () => now)
  await update($, tick, () => now)
  await update($, note, () => line)
  await update($, phase, () => next)
}

// The elapsed seconds redraw once a second, only while a phase runs.
function startTicker($: EngineInterface): void {
  if (ticker !== null) return
  ticker = $.clock.every(1000, () => {
    void $.clock
      .now()
      .then(now => update($, tick, () => now))
      .catch(() => undefined)
  })
}

function stopTicker(): void {
  ticker?.cancel()
  ticker = null
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => undefined)
}

async function closePane($: EngineInterface): Promise<void> {
  await $.ui.close({ id: PANE }).catch(() => undefined)
}

// The end of a run: the pill is free again; the pane keeps what it shows.
async function finish($: EngineInterface): Promise<void> {
  stopTicker()
  pending = null
  stop = null
  $.ui.status(undefined)
  await update($, running, () => false)
}

// A look at the board counts as a review only when every card could be read.
async function stampReview($: EngineInterface, isComplete: boolean, now: number): Promise<void> {
  if (isComplete) await $.store.set('lastRunAt', now)
}

// ---- the run ---------------------------------------------------------------------

// The run behind the pill and /board: collect, judge, show in the pane; the
// press on Übernehmen writes. Answers a one-line summary without card
// contents (it may reach Claude). Without a surface (a -p run) it is a dry run
// whose table goes to the transcript log.
async function runBoard($: EngineInterface, hasSurface: boolean, isWorkingAtDraw = false): Promise<string> {
  if (isWorkingAtDraw || (await read($, isTurnRunning))) {
    toast($, 'Claude arbeitet gerade – Board-Abgleich nach der Antwort.')
    return 'Board-Abgleich nicht gestartet: Claude arbeitet gerade.'
  }

  let isMine = false
  await update($, running, isRunning => {
    isMine = !isRunning
    return true
  })
  if (!isMine) {
    toast($, 'Board-Abgleich läuft bereits – Fenster „Board Update“.')
    return 'Board-Abgleich läuft bereits.'
  }

  isCancelled = false
  let isHeld = false
  try {
    const ran = await reconcile($, hasSurface)
    isHeld = ran.isHeld
    return ran.text
  } catch (err) {
    const why = clean(err instanceof Error ? err.message : String(err), 200)
    if (hasSurface) await setPhase($, 'failed', `Abgebrochen – ${why}`)
    else log($, `Board: abgebrochen – ${why}`)
    toast($, 'Board-Abgleich abgebrochen (siehe Fenster „Board Update“).')
    return `Board-Abgleich abgebrochen: ${why}`
  } finally {
    // A proposal waiting in the pane keeps the run until it is applied or cancelled.
    if (!isHeld) await finish($)
  }
}

async function reconcile($: EngineInterface, hasSurface: boolean): Promise<{ text: string; isHeld: boolean }> {
  const homeDir = await home($)
  const dir = `${homeDir}/.claude/board`
  // A confirmation an earlier run left behind (apply.py never started) goes first.
  await $.process.run(['/usr/bin/rm', '-f', `${dir}/confirm.json`], { timeoutMs: 10_000 })
  await update($, rows, () => [])
  await update($, results, () => [])
  await update($, counts, () => NO_COUNTS)
  await update($, rejected, () => [])
  if (hasSurface) {
    await setPhase($, 'collecting')
    startTicker($)
  }
  const cfg = await readConfig($, dir)
  const now = await $.clock.now()
  const at = stamp(now)

  $.ui.status('▦ Board: sammelt …')
  const counted: Counted = async patch => {
    await update($, counts, c => ({ ...c, ...patch }))
  }
  const sources = await collect($, cfg, isoDate(now), homeDir, counted)
  if (isCancelled) {
    // Nothing was judged: no review.
    return { text: 'Board-Abgleich abgebrochen.', isHeld: false }
  }
  await $.fs.write(`${dir}/snapshot-${at}.json`, `${JSON.stringify({ at, cards: sources.cards, prs: sources.prs }, null, 2)}\n`)
  const prompt = promptFor(sources, cfg, sources.nextSteps)
  const notices = [
    ...(sources.skill === null ? [`Neue Karten gesperrt: Skill-Datei ${baseName(cfg.skillPath ?? DEFAULT_SKILL_PATH)} nicht lesbar.`] : []),
    ...(cfg.standFile !== undefined && sources.nextSteps === null ? ['Kein Abschnitt „Nächster Schritt“ in der standFile: keine Sprint-Vorschläge.'] : []),
  ]
  await update($, counts, c => ({ ...c, notices }))
  if (!hasSurface) for (const line of notices) log($, `Board: ${line}`)
  // Cards that could not be read are not judged; such a run is no full review.
  const isComplete = sources.unreadable === 0
  if (!isComplete && !hasSurface) log($, `Board: Achtung – ${sources.unreadable} Karte(n) unlesbar, nicht bewertet.`)

  // Made before the phase shows, so an Abbrechen from here on always has a call to cut.
  stop = new AbortController()
  if (isCancelled) {
    // Cancelled while still collecting: nothing judged, no review, no model call.
    return { text: 'Board-Abgleich abgebrochen.', isHeld: false }
  }
  if (hasSurface) await setPhase($, 'thinking')
  if (isCancelled || stop.signal.aborted) {
    await stampReview($, isComplete, now)
    return { text: 'Board-Abgleich abgebrochen.', isHeld: false }
  }
  $.ui.status('▦ Board: Opus bewertet …')
  const reply = await $.model.complete(
    { model: 'opus', effort: 'medium', system: systemPrompt(cfg, sources.skill, sources.nextSteps !== null), prompt, maxTokens: MAX_TOKENS, timeoutMs: MODEL_TIMEOUT_MS },
    { signal: stop.signal },
  )
  if (isCancelled || (!reply.isAnswered && reply.reason === 'aborted')) {
    // Abbrechen while Opus judged: the board was looked at, as a deliberate no.
    await stampReview($, isComplete, now)
    return { text: 'Board-Abgleich abgebrochen.', isHeld: false }
  }
  if (!reply.isAnswered) {
    throw new Error(`keine Bewertung (${reply.reason}${reply.reason === 'api-error' ? ` ${reply.status ?? ''} ${reply.error}` : ''})`)
  }
  await $.fs.write(`${dir}/reply-${at}.txt`, reply.text)

  const keys = new Map<string, string>()
  for (const entry of sources.entries) keys.set(entry.heading, await sourceKey(entry.heading))
  const ctx: Context = { entries: sources.entries, keys, hasSkill: sources.skill !== null, nextSteps: sources.nextSteps, standText: sources.standText }
  const checked = checkProposal(extractJson(reply.text), sources.cards, sources.prs, cfg, ctx)
  if (typeof checked === 'string') throw new Error(`Bewertung unbrauchbar: ${checked} (Rohantwort reply-${at}.txt)`)
  await update($, rejected, () => checked.rejected.map((x, i) => ({ ...x, i: i + 1, isOpen: false })))
  if (checked.rows.length === 0) {
    await stampReview($, isComplete, now)
    if (hasSurface) await setPhase($, 'done', 'Keine Änderungen vorgeschlagen – Board passt zum Stand.')
    else log($, 'Board: keine Änderungen vorgeschlagen – Board passt zum Stand.')
    return { text: 'Board-Abgleich: keine Änderungen vorgeschlagen.', isHeld: false }
  }

  const file = `${dir}/proposals-${at}.json`
  const document = proposalDocument(checked.rows, new Date(now).toISOString(), cfg.planId)
  await $.fs.write(file, document)
  const hash = await sha256Hex(document)

  if (!hasSurface) {
    log($, `Board: ${sources.cards.length} Karten, ${sources.prs.length} PRs gelesen; Eingabe ${prompt.length} Zeichen = ${reply.usage.input_tokens} Token.`)
    for (const line of checked.dropped) log($, `Board: verworfen – ${clean(line, 200)}`)
    for (const line of tableLines(checked.rows)) log($, line)
    log($, `Board: Datei ${file}, sha256 ${hash}`)
    return { text: `Board-Abgleich: ${checked.rows.length} Vorschläge gezeigt (Trockenlauf ohne Oberfläche), nichts ausgeführt.`, isHeld: false }
  }

  pending = { cfg, dir, at, now, file, hash, rows: checked.rows, isComplete }
  isApplying = false
  await update($, rows, () => paneRows(checked.rows, sources.cards, sources.entries))
  await setPhase($, 'ready')
  stopTicker()
  $.ui.status('▦ Board: wartet auf Bestätigung im Fenster …')
  return { text: `Board-Abgleich: ${checked.rows.length} Vorschläge im Fenster „Board Update“.`, isHeld: true }
}

// Übernehmen (n): the checked rows go to apply.py with the one-time confirmation.
async function applyChecked($: EngineInterface): Promise<void> {
  if (isApplying) return
  isApplying = true
  if ((await read($, phase)) !== 'ready') {
    isApplying = false
    return
  }
  const held = pending
  if (held === null) {
    await setPhase($, 'failed', 'Vorschläge nach dem Neuladen verloren – Lauf neu starten.')
    await finish($)
    return
  }
  const selected = checkedRows(await read($, rows))
  if (selected.length === 0) {
    // Nothing taken over is a deliberate no: a review, nothing written.
    await stampReview($, held.isComplete, held.now)
    await closePane($)
    await setPhase($, 'idle')
    toast($, 'Board: nichts übernommen.')
    await finish($)
    return
  }

  await setPhase($, 'applying')
  startTicker($)
  const { dir, at, file, hash, cfg } = held
  const report = `${dir}/apply-${at}.jsonl`
  // The rows reach the pane as apply.py reports them.
  const poll = $.clock.every(1000, () => {
    void $.fs
      .read(report)
      .then(text => update($, results, () => reportOutcome(text).rows))
      .catch(() => undefined)
  })
  try {
    // The one-time confirmation apply.py insists on; it deletes it on reading.
    await $.fs.write(`${dir}/confirm.json`, JSON.stringify({ sha256: hash, rows: selected, at: await $.clock.now() }))
    $.ui.status('▦ Board: schreibt …')
    const argv = [cfg.pythonPath, '-I', `${$.plugin.root}/apply.py`, '--proposals', file, '--rows', selected.join(','), '--sha256', hash, '--report', report]
    const ran = await $.process.run(argv, { timeoutMs: APPLY_TIMEOUT_MS }).catch(() => null)
    // The report holds every row apply.py got to, flushed line by line; killed at
    // the timeout it lacks its last line and the rows not in it are unknown.
    const text = await $.fs.read(report).catch(() => '')
    const fromReport = reportOutcome(text, selected)
    const outcome: Outcome = text.includes('"final": true') ? fromReport : ((ran === null ? null : outcomeFrom(ran.stdout)) ?? fromReport)
    poll.cancel()
    await update($, results, () => outcome.rows)
    await $.fs.write(`${dir}/last-run.md`, lastRunMarkdown(at, file, held.rows, outcome))
    if (isStamped(outcome)) await $.store.set('lastRunAt', held.now)
    const ok = outcome.rows.filter(r => r.result === 'ok').length
    const head = outcome.status === 'ok' ? `Ausgeführt: ${ok} von ${selected.length} Zeilen ok.` : `ABGEBROCHEN – ${clean(outcome.reason, 200)}`
    await setPhase($, 'done', head)
    toast($, outcome.status === 'ok' ? `Board: ${ok} von ${selected.length} Zeilen ausgeführt.` : 'Board: Lauf abgebrochen (siehe Fenster).')
  } catch (err) {
    await setPhase($, 'failed', `Abgebrochen – ${clean(err instanceof Error ? err.message : String(err), 200)}`)
  } finally {
    poll.cancel()
    await finish($)
  }
}

// Abbrechen, or the pane closed by the person: what it means depends on the phase.
async function cancel($: EngineInterface, isClosing: boolean): Promise<void> {
  const now = await read($, phase)
  if (now === 'collecting' || now === 'thinking') {
    // The run ends itself: after the read (no review), or as the model call returns aborted.
    isCancelled = true
    stop?.abort()
    stopTicker()
    await setPhase($, 'idle')
  } else if (now === 'ready') {
    const held = pending
    if (held !== null) await stampReview($, held.isComplete, held.now)
    await setPhase($, 'idle')
    await finish($)
  } else if (now === 'applying') {
    // apply.py runs to its end; its rows land in the report and last-run.md.
    return
  } else {
    await setPhase($, 'idle')
  }
  if (!isClosing) await closePane($)
}

async function remind($: EngineInterface): Promise<void> {
  let isFirst = false
  await update($, startupChecked, isChecked => {
    isFirst = !isChecked
    return true
  })
  if (!isFirst) return

  const text = reminder(await $.store.get('lastRunAt'), await $.clock.now())
  if (text !== null) toast($, text)
}

// The pill's press: the pane opens as the answer to the press, then the run starts.
async function startFromPress($: EngineInterface, isWorking: boolean): Promise<void> {
  if (isWorking || (await read($, isTurnRunning))) {
    await runBoard($, true, true)
    return
  }
  await openPane($)
  await runBoard($, true)
}

function elapsed(since: number, now: number): string {
  return `${Math.max(0, Math.round((now - since) / 1000))} s`
}

function countLine(c: BoardCounts): string {
  const parts = [c.cards >= 0 ? `${c.cards} Karten` : '', c.prs >= 0 ? `${c.prs} PRs` : '', c.backlog >= 0 ? `${c.backlog} Backlog-Einträge` : '']
  return parts.filter(p => p !== '').join(' · ')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A run in flight is lost with the old environment on a hot reload.
    await update($, running, () => false)
    const was = await read($, phase)
    if (was !== 'done' && was !== 'failed') {
      await update($, rows, () => [])
      await update($, phase, () => 'idle')
    }
    await $.command.register({ name: 'board', description: 'Planner-Board mit Repo-Stand abgleichen (Fenster „Board Update“: Vorschläge an- und abwählen, übernehmen)' })
    const started = await next(e)
    if (e.isInteractive) {
      void remind($).catch(() => undefined)
    }
    return started
  })

  on('command.run', { command: 'board' }, async $ => {
    // No surface (a -p run): no one can confirm, so the run is a dry run whose
    // table goes to the log; it is awaited here.
    if ((await $.session.surfaces()).length === 0) {
      return { text: await runBoard($, false) }
    }
    if (await read($, isTurnRunning)) {
      return { text: await runBoard($, true) }
    }
    await openPane($)
    if (await read($, running)) return { text: 'Board-Abgleich läuft bereits – Fenster „Board Update“.' }
    // The run goes on from a timer: this hook must not wait on it.
    $.clock.after(0, () => {
      void runBoard($, true).catch(() => undefined)
    })
    return { text: 'Board-Abgleich gestartet – Fenster „Board Update“.' }
  }).catch(() => ({ text: 'board: Befehl fehlgeschlagen.' }))

  // The person's close mark or key on the pane counts as Abbrechen.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await cancel($, true)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Second net beside the deny rule: the main model never runs apply.py.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => (isApplyCall(e.command) ? { deny: GUARD_REFUSAL } : next(e))).catch(
    ($, e, next) => (next.called ? next(e) : { deny: GUARD_REFUSAL }),
  )

  // The run files are the mod's alone: no Write, Edit or NotebookEdit of the
  // confirmation or a proposal file. Fail-closed for paths into the run folder.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => ((await isRunFileFor($, e.file_path)) ? { deny: RUN_FILE_REFUSAL } : next(e))).catch(
    ($, e, next) => (next.called || !nearRunFolder(e.file_path) ? next(e) : { deny: RUN_FILE_REFUSAL }),
  )
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => ((await isRunFileFor($, e.file_path)) ? { deny: RUN_FILE_REFUSAL } : next(e))).catch(
    ($, e, next) => (next.called || !nearRunFolder(e.file_path) ? next(e) : { deny: RUN_FILE_REFUSAL }),
  )
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => ((await isRunFileFor($, e.notebook_path)) ? { deny: RUN_FILE_REFUSAL } : next(e))).catch(
    ($, e, next) => (next.called || !nearRunFolder(e.notebook_path) ? next(e) : { deny: RUN_FILE_REFUSAL }),
  )

  on('turn.start', async ($, e, next) => {
    // A subagent's turn ends without a main-thread turn.complete; it never blocks the pill.
    if (e.agentId != null) return next(e)
    await update($, isTurnRunning, () => true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId == null) {
      await update($, isTurnRunning, () => false)
    }
    return completed
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, startupChecked, () => false)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await read($, phase)
    const list = await read($, rows)
    const done = await read($, results)
    const since = await read($, startedAt)
    const clock = await read($, tick)
    const c = await read($, counts)
    const line = await read($, note)
    const gone = await read($, rejected)
    const toggle = (n: number, field: 'isChecked' | 'isOpen') => update($, rows, l => l.map(r => (r.n === n ? { ...r, [field]: !r[field] } : r)))
    const close = (
      <Button key="close" role="dismiss" onPress={() => void cancel($, false).catch(() => undefined)}>
        Schließen
      </Button>
    )
    const counted = countLine(c)
    const unreadable = (
      <Box flexDirection="column">
        {c.unreadable > 0 && <Text color="warning">Achtung – {c.unreadable} Karte(n) unlesbar, nicht bewertet.</Text>}
        {c.notices.map(n => (
          <Text color="warning">{n}</Text>
        ))}
      </Box>
    )

    if (now === 'idle') {
      return (
        <Box flexDirection="column">
          <Text dimColor>Kein Lauf. Knopf ▦ Board oder /board startet einen.</Text>
          {close}
        </Box>
      )
    }
    if (now === 'collecting' || now === 'thinking') {
      return (
        <Box flexDirection="column">
          <Text>
            {now === 'collecting' ? 'Sammelt …' : 'Opus denkt …'} {elapsed(since, clock)}
          </Text>
          {counted !== '' && <Text dimColor>{counted}</Text>}
          {unreadable}
          <Button key="cancel" role="dismiss" onPress={() => void cancel($, false).catch(() => undefined)}>
            Abbrechen
          </Button>
        </Box>
      )
    }
    if (now === 'failed') {
      return (
        <Box flexDirection="column">
          <Text color="error">{line}</Text>
          {close}
        </Box>
      )
    }

    const resultOf = new Map(done.map(r => [r.n, r]))
    const chosen = list.filter(r => r.isChecked).length
    return (
      <Box flexDirection="column">
        {now === 'applying' && <Text>Schreibt … {elapsed(since, clock)}</Text>}
        {now === 'done' && <Text bold>{line}</Text>}
        {now === 'ready' && <Text dimColor>{[counted, `${list.length} Vorschläge`].filter(p => p !== '').join(' · ')}</Text>}
        {unreadable}
        {list.map(r => {
          const got = resultOf.get(r.n)
          const outcome = got === undefined ? '' : ` → ${RESULT_LABEL[got.result] ?? clean(got.result, 20)}${got.detail === '' ? '' : ` (${clean(got.detail, 120)})`}`
          return (
            <Box key={`row-${r.n}`} flexDirection="column">
              <Box>
                {now === 'ready' ? (
                  <Button key={`chk:${r.n}`} plain onPress={() => void toggle(r.n, 'isChecked')}>
                    {r.isChecked ? '[x]' : '[ ]'}
                  </Button>
                ) : (
                  <Text dimColor>{r.isChecked ? '[x]' : '[ ]'}</Text>
                )}
                <Text> </Text>
                <Button key={`row:${r.n}`} plain onPress={() => void toggle(r.n, 'isOpen')}>
                  {r.change} <Text dimColor>{r.card}</Text>
                </Button>
                {outcome !== '' && <Text color={got?.result === 'ok' || got?.result === 'unchanged' ? 'success' : 'warning'}>{outcome}</Text>}
              </Box>
              {r.isOpen && <Text dimColor>    Beleg: {r.why}</Text>}
              {r.isOpen && (
                <Text dimColor>
                  {'    '}
                  {r.before} → {r.after}
                </Text>
              )}
              {r.isOpen &&
                r.detail.map(d => (
                  <Text dimColor>
                    {'    '}
                    {d}
                  </Text>
                ))}
            </Box>
          )
        })}
        {now === 'ready' && gone.length > 0 && <Text dimColor>{gone.length} Vorschläge verworfen:</Text>}
        {now === 'ready' &&
          gone.map(x => (
            <Box key={`drop-${x.i}`} flexDirection="column">
              <Button key={`drop:${x.i}`} plain dimColor onPress={() => void update($, rejected, l => l.map(y => (y.i === x.i ? { ...y, isOpen: !y.isOpen } : y)))}>
                ✗ {x.change} <Text dimColor>{x.card}</Text>
              </Button>
              <Text dimColor>    – {x.reason}</Text>
              {x.isOpen &&
                x.detail.map(d => (
                  <Text dimColor>
                    {'    '}
                    {d}
                  </Text>
                ))}
            </Box>
          ))}
        {now === 'ready' && (
          <Box>
            <Button key="apply" variant="primary" onPress={() => void applyChecked($).catch(() => undefined)}>
              {`Übernehmen (${chosen})`}
            </Button>
            <Button key="none" onPress={() => void update($, rows, l => l.map(r => ({ ...r, isChecked: false })))}>
              Alle ab
            </Button>
            <Button key="cancel" role="dismiss" onPress={() => void cancel($, false).catch(() => undefined)}>
              Abbrechen
            </Button>
          </Box>
        )}
        {now === 'done' && close}
      </Box>
    )
  })

  // The pill beside the hint line (and the pills of the mods drawn below it);
  // gone where the line has no room. The terminal's main screen gets the band.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const below = await next(e)
    if (e.viewport?.isFullscreen === false || !pillFits(e.viewport?.columns, e.props.hint)) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const isBusy = (await read($, running)) || e.props.isWorking
    const pill = isBusy ? (
      <Text dimColor>{PILL_BUSY}</Text>
    ) : (
      <Button key="board" plain onPress={() => void startFromPress($, e.props.isWorking).catch(() => undefined)}>
        <Text backgroundColor="claude" color="inverseText" bold>
          {PILL}
        </Text>
      </Button>
    )

    return (
      <Box flexDirection="row">
        {below}
        <Box flexShrink={0} marginLeft={2}>
          {pill}
        </Box>
      </Box>
    )
  })

  // Fallback on the terminal's main screen, where the hint line takes no clicks.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const below = await next(e)
    if (e.viewport?.isFullscreen !== false) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const isBusy = (await read($, running)) || e.props.isWorking
    const mine = (
      <Box width={e.props.bodyColumns} justifyContent="flex-end">
        {isBusy ? (
          <Text dimColor>{PILL_BUSY}</Text>
        ) : (
          <Button key="board" plain onPress={() => void startFromPress($, e.props.isWorking).catch(() => undefined)}>
            <Text backgroundColor="claude" color="inverseText" bold>
              {PILL}
            </Text>
          </Button>
        )}
      </Box>
    )

    return (below as RenderElement | null | undefined) == null ? (
      mine
    ) : (
      <Box flexDirection="column">
        {below}
        {mine}
      </Box>
    )
  })
}
