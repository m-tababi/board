import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import {
  ANSWER_NO,
  ANSWER_YES,
  GRAPH,
  PILL,
  PILL_BUSY,
  askText,
  backlogDigest,
  cardFrom,
  changelogHead,
  checkProposal,
  clean,
  detailsFrom,
  extractJson,
  isApplyCall,
  isStamped,
  lastRunMarkdown,
  outcomeFrom,
  parseConfig,
  pillFits,
  prFrom,
  promptFor,
  proposalDocument,
  reminder,
  reportOutcome,
  resultLines,
  selectedRows,
  sha256Hex,
  stamp,
  systemPrompt,
  tableLines,
} from './board'
import type { Card, Config, Outcome, Pr, RepoFile, Sources } from './board'

const running = atom({ plugin: 'board', key: 'running' } as const, false)
const isTurnRunning = atom({ plugin: 'board', key: 'isTurnRunning' } as const, false)
const startupChecked = atom({ plugin: 'board', key: 'startupChecked' } as const, false)

const AZ_TIMEOUT_MS = 60_000
const GH_TIMEOUT_MS = 60_000
const MODEL_TIMEOUT_MS = 600_000
// apply.py starts no card after 120 s and cuts each az call at 30 s: its slowest
// card ends by 270 s, inside this limit.
const APPLY_TIMEOUT_MS = 330_000
const MAX_TOKENS = 16_000
const DETAILS_AT_ONCE = 6
const TOAST_MS = 8000
const GUARD_REFUSAL =
  'apply.py schreibt aufs Planner-Board und läuft nur über den board-Mod nach Bestätigung im Mod (Knopf ▦ Board oder /board), nie per Bash.'

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

async function collect($: EngineInterface, cfg: Config, today: string, homeDir: string): Promise<Sources & { unreadable: number }> {
  const [{ cards, unreadable }, prs, backlogs, changelog] = await Promise.all([
    readCards($, cfg),
    Promise.all(Object.keys(cfg.repos).map(repo => readPrs($, cfg, repo))),
    Promise.all(cfg.backlogSources.map(file => readRepoFile($, cfg, file))),
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
  return { cards, prs: prs.flat(), files, today, unreadable }
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

function isoDate(at: number): string {
  return stamp(at).slice(0, 10)
}

// The whole run behind the pill and /board: collect, judge, show, ask, apply.
// Answers a one-line summary without card contents (it may reach Claude).
async function runBoard($: EngineInterface, isWorkingAtDraw = false): Promise<string> {
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
    toast($, 'Board-Abgleich läuft bereits.')
    return 'Board-Abgleich läuft bereits.'
  }

  try {
    return await reconcile($)
  } catch (err) {
    const why = clean(err instanceof Error ? err.message : String(err), 200)
    log($, `Board: abgebrochen – ${why}`)
    toast($, 'Board-Abgleich abgebrochen (siehe Verlauf).')
    return `Board-Abgleich abgebrochen: ${why}`
  } finally {
    $.ui.status(undefined)
    await update($, running, () => false)
  }
}

async function reconcile($: EngineInterface): Promise<string> {
  const homeDir = await home($)
  const dir = `${homeDir}/.claude/board`
  // A confirmation an earlier run left behind (apply.py never started) goes first.
  await $.process.run(['/usr/bin/rm', '-f', `${dir}/confirm.json`], { timeoutMs: 10_000 })
  const cfg = await readConfig($, dir)
  const now = await $.clock.now()
  const at = stamp(now)

  $.ui.status('▦ Board: sammelt …')
  const sources = await collect($, cfg, isoDate(now), homeDir)
  await $.fs.write(`${dir}/snapshot-${at}.json`, `${JSON.stringify({ at, cards: sources.cards, prs: sources.prs }, null, 2)}\n`)
  const prompt = promptFor(sources, cfg)
  // Cards that could not be read are not judged; such a run is no full review.
  const isComplete = sources.unreadable === 0
  if (!isComplete) log($, `Board: Achtung – ${sources.unreadable} Karte(n) unlesbar, nicht bewertet.`)

  $.ui.status('▦ Board: Opus bewertet …')
  const reply = await $.model.complete({
    model: 'opus',
    effort: 'medium',
    system: systemPrompt(cfg),
    prompt,
    maxTokens: MAX_TOKENS,
    timeoutMs: MODEL_TIMEOUT_MS,
  })
  if (!reply.isAnswered) {
    throw new Error(`keine Bewertung (${reply.reason}${reply.reason === 'api-error' ? ` ${reply.status ?? ''} ${reply.error}` : ''})`)
  }
  await $.fs.write(`${dir}/reply-${at}.txt`, reply.text)
  log(
    $,
    `Board: ${sources.cards.length} Karten, ${sources.prs.length} PRs gelesen; Eingabe ${prompt.length} Zeichen = ${reply.usage.input_tokens} Token, Antwort ${reply.usage.output_tokens} Token.`,
  )

  const checked = checkProposal(extractJson(reply.text), sources.cards, sources.prs, cfg)
  if (typeof checked === 'string') throw new Error(`Bewertung unbrauchbar: ${checked} (Rohantwort reply-${at}.txt)`)
  for (const line of checked.dropped) log($, `Board: verworfen – ${clean(line, 200)}`)
  if (checked.rows.length === 0) {
    if (isComplete) await $.store.set('lastRunAt', now)
    log($, 'Board: keine Änderungen vorgeschlagen – Board passt zum Stand.')
    return 'Board-Abgleich: keine Änderungen vorgeschlagen.'
  }

  const file = `${dir}/proposals-${at}.json`
  const document = proposalDocument(checked.rows, new Date(now).toISOString(), cfg.planId)
  await $.fs.write(file, document)
  const hash = await sha256Hex(document)
  for (const line of tableLines(checked.rows)) log($, line)
  log($, `Board: Datei ${file}, sha256 ${hash}`)
  $.ui.status('▦ Board: wartet auf Antwort …')

  let answer: string
  try {
    answer = await $.ui.ask(askText(checked.rows.length, `proposals-${at}.json`), { options: [ANSWER_YES, ANSWER_NO], header: 'Board' })
  } catch {
    log($, 'Board: keine Antwort – nichts ausgeführt.')
    return `Board-Abgleich: ${checked.rows.length} Vorschläge gezeigt, keine Antwort, nichts ausgeführt.`
  }
  const selected = selectedRows(answer, checked.rows.length)
  if (selected === null) {
    const isNo = answer.trim() === ANSWER_NO
    // A deliberate no is a review: the board was seen and judged.
    if (isNo && isComplete) await $.store.set('lastRunAt', now)
    const why = isNo ? 'abgelehnt' : `Antwort „${clean(answer, 40)}“ ist nicht „ja“, „nein“ oder „ja außer n, …“`
    log($, `Board: ${why} – nichts ausgeführt.`)
    return 'Board-Abgleich: nichts ausgeführt.'
  }

  // The one-time confirmation apply.py insists on; it deletes it on reading.
  await $.fs.write(`${dir}/confirm.json`, JSON.stringify({ sha256: hash, rows: selected, at: await $.clock.now() }))
  $.ui.status('▦ Board: schreibt …')
  const report = `${dir}/apply-${at}.jsonl`
  const argv = [cfg.pythonPath, '-I', `${$.plugin.root}/apply.py`, '--proposals', file, '--rows', selected.join(','), '--sha256', hash, '--report', report]
  const ran = await $.process.run(argv, { timeoutMs: APPLY_TIMEOUT_MS }).catch(() => null)
  // Killed at the timeout or without a result: the report holds every row it got to.
  const outcome: Outcome =
    (ran === null ? null : outcomeFrom(ran.stdout)) ?? reportOutcome(await $.fs.read(report).catch(() => ''), selected)
  for (const line of resultLines(checked.rows, outcome)) log($, line)
  await $.fs.write(`${dir}/last-run.md`, lastRunMarkdown(at, file, checked.rows, outcome))
  if (isStamped(outcome)) await $.store.set('lastRunAt', now)

  const ok = outcome.rows.filter(r => r.result === 'ok').length
  const summary = outcome.status === 'ok' ? `Board: ${ok} von ${selected.length} Zeilen ausgeführt.` : 'Board: Lauf abgebrochen (siehe Verlauf).'
  toast($, summary)
  return summary
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A run in flight is lost with the old environment on a hot reload.
    await update($, running, () => false)
    await $.command.register({ name: 'board', description: 'Planner-Board mit Repo-Stand abgleichen (Vorschläge zeigen, nach „ja“ ausführen)' })
    const started = await next(e)
    if (e.isInteractive) {
      void remind($).catch(() => undefined)
    }
    return started
  })

  on('command.run', { command: 'board' }, async $ => {
    // No surface (a -p run): no one can confirm, so the run stops after the
    // table; it is awaited here, as nothing is asked mid-turn.
    if ((await $.session.surfaces()).length === 0) {
      return { text: await runBoard($) }
    }
    // The question runs from a timer: this hook must not wait on it.
    $.clock.after(0, () => {
      void runBoard($).catch(() => undefined)
    })
    return { text: 'Board-Abgleich gestartet – Tabelle und Rückfrage folgen.' }
  }).catch(() => ({ text: 'board: Befehl fehlgeschlagen.' }))

  // Second net beside the deny rule: the main model never runs apply.py.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => (isApplyCall(e.command) ? { deny: GUARD_REFUSAL } : next(e))).catch(
    ($, e, next) => (next.called ? next(e) : { deny: GUARD_REFUSAL }),
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
      <Button key="board" plain onPress={() => void runBoard($, e.props.isWorking).catch(() => undefined)}>
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
          <Button key="board" plain onPress={() => void runBoard($, e.props.isWorking).catch(() => undefined)}>
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
