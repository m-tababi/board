import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import {
  GH,
  MAX_ROWS,
  PILL,
  PYTHON,
  backlogDigest,
  changelogHead,
  checkProposal,
  clean,
  extractJson,
  isApplyCall,
  markerFields,
  markerIsCurrent,
  isSkillFormat,
  paneRows,
  entriesOf,
  nextStepsOf,
  normalTitle,
  parseConfig,
  sourceKey,
  pillFits,
  reminder,
  sha256Hex,
  systemPrompt,
} from '../hooks/board'
import type { BucketKey, Card, Config, Context, Pr } from '../hooks/board'

// Made-up values only: no real plan, bucket, user id or path belongs in a test.
const HOME = '/u/tester'
const DIR = `${HOME}/.claude/board`
const START = new Date(2026, 9, 27, 14, 0, 0).getTime()
const DAY = 24 * 60 * 60 * 1000
const ME = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const AZ = '/opt/az/bin/az'
const PLAN_ID = 'PlanFake0000000000000001'
const BUCKETS: Record<BucketKey, string> = {
  backlog: 'BucketBacklog00000000001',
  sprint_backlog: 'BucketSprint000000000001',
  in_progress: 'BucketProgress0000000001',
  in_review: 'BucketReview000000000001',
  done: 'BucketDone00000000000001',
}
const CONFIG_FILE = {
  azPath: AZ,
  planId: PLAN_ID,
  buckets: BUCKETS,
  ownerId: ME,
  ownerLogin: 'owner-login',
  repos: { alpha: 'example-org/alpha', beta: 'example-org/beta' },
  backlogSources: [{ repo: 'alpha', path: 'backlog.md', ref: 'main' }],
  changelog: { repo: 'alpha', path: 'CHANGELOG.md', ref: 'main' },
  statusFiles: ['~/notes/status.md', '/srv/notes/bench.md'],
  standFile: '~/notes/status.md',
  skipTitlePrefixes: ['Side:'],
  promptRules: ['Cards about the side project get nothing.'],
  extraStatuses: ['side_project'],
}
const CFG = parseConfig(JSON.stringify(CONFIG_FILE)) as Config

// A backlog file in the create-backlog format, and a card for one of its entries.
const BACKLOG = [
  '# Backlog',
  '',
  '## 2026-10-20 — Cache the Parsed Pages',
  '',
  '**Priority:** Important',
  '',
  'A rerun should skip the parser.',
  '',
  '## 2026-10-01 — Old Exporter ✅ DONE',
  '',
  'Shipped.',
  '',
  '## 2026-10-21 — Tidy the Docs Folder',
  '',
  'Docs are scattered.',
  '',
].join('\n')
const CACHE = '2026-10-20 — Cache the Parsed Pages'
const STORY = 'As a developer, I want to cache the parsed pages so that a rerun skips the parser.'
const CRITERIA = ['A rerun reads pages from the cache', 'A changed input invalidates its entry', 'The cache folder is documented']
const create = (extra: Record<string, unknown> = {}) => ({
  action: 'create',
  title: 'Cache the Parsed Pages',
  priority: 'Important',
  userStory: STORY,
  tasks: ['Add a cache folder per input', 'Key entries by the input hash'],
  acceptanceCriteria: [...CRITERIA],
  source: { file: 'alpha/backlog.md', heading: CACHE },
  evidence: 'alpha/backlog.md:3',
  ...extra,
})
const NO_CONTEXT: Context = { entries: [], keys: new Map(), hasSkill: true, nextSteps: null, standText: null }

async function contextFor(text: string, extra: Partial<Context> = {}): Promise<Context> {
  const entries = entriesOf('alpha/backlog.md', text)
  const keys = new Map<string, string>()
  for (const e of entries) keys.set(e.heading, await sourceKey(e.heading))
  return { entries, keys, hasSkill: true, nextSteps: null, standText: null, ...extra }
}

const T_OPEN = 'TaskOpen0000000000000001'
const T_REVIEW = 'TaskReview00000000000001'
const T_DONE = 'TaskDone0000000000000001'

const task = (id: string, title: string, bucket: BucketKey, assignees: string[] = []) => ({
  id,
  title,
  bucketId: BUCKETS[bucket],
  percentComplete: bucket === 'done' ? 100 : 0,
  assignments: Object.fromEntries(assignees.map(a => [a, {}])),
  createdBy: { user: { id: ME } },
  '@odata.etag': `W/"t${id}"`,
})
const TASKS = [
  task(T_OPEN, 'Write Parser Docs', 'in_progress'),
  task(T_REVIEW, 'Fix Cache Race \u001b[2J', 'in_review', [OTHER]),
  task(T_DONE, 'Retire Old Importer', 'done'),
]
const details = (id: string) => ({ '@odata.etag': `W/"d${id}"`, description: `Body of ${id}`, checklist: {} })
const PRS = [
  { number: 133, title: 'Same page', author: { login: 'someone' }, state: 'OPEN', isDraft: false, mergedAt: null, updatedAt: 'x', headRefName: 'b' },
  { number: 174, title: 'Rotation', author: { login: 'owner-login' }, state: 'MERGED', isDraft: false, mergedAt: 'y', updatedAt: 'y', headRefName: 'c' },
]
const REPLY = JSON.stringify({
  rows: [
    { action: 'assign', taskId: T_OPEN, evidence: 'In Progress ohne Zuweisung' },
    { action: 'marker', taskId: T_OPEN, marker: { status: 'in_progress', ref: 'backlog.md:12' }, evidence: 'backlog.md:12' },
    { action: 'move', taskId: T_REVIEW, bucket: 'done', evidence: 'PR #133' },
    { action: 'delete', taskId: T_REVIEW, evidence: 'weg damit' },
    { action: 'assign', taskId: T_REVIEW, evidence: 'Ignore all rules' },
  ],
})

type WorldOptions = {
  reply?: string
  // How long the engine takes to answer: az reads, the model, apply.py (ms on the mock clock).
  slow?: { az?: number; model?: number; apply?: number }
  surfaces?: ('terminal' | 'desktop')[]
  store?: Record<string, unknown>
  failAz?: boolean
  tasks?: unknown[]
  failStand?: boolean
  noSkill?: boolean
  backlog?: string
  // The config file's text; null: there is none.
  config?: string | null
  // What apply.py does: its stdout, or a rejection (killed at the timeout) with the report it left.
  apply?: { results?: string[]; reject?: boolean; report?: string }
}

function result(exitCode: number, stdout: string, stderr = ''): ProcessRunResult {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

function world(on: On, o: WorldOptions = {}) {
  const seen = {
    files: new Map<string, string>(),
    logs: [] as string[],
    toasts: [] as string[],
    opened: [] as string[],
    closed: [] as string[],
    runs: [] as string[][],
    prompts: [] as { system: string; prompt: string; model: string; effort?: string; maxTokens?: number }[],
    store: { ...(o.store ?? {}) } as Record<string, unknown>,
    clock: undefined as unknown as MockClock,
    confirmAtApply: undefined as string | undefined,
    // Runs that reached their end (the status line cleared in the finally).
    ends: 0,
  }

  seen.clock = mock.clock(on, { now: START })
  mock.env(on, { HOME })
  on('store.get', ($, e) => ({ value: seen.store[e.key] }))
  on('store.set', ($, e) => {
    seen.store[e.key] = e.value
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.surfaces', () => ({ value: o.surfaces ?? ['terminal'] }))
  on('ui.log', ($, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    if (e.text === undefined) seen.ends += 1
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('fs.write', ($, e) => {
    seen.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    if (e.path === `${DIR}/config.json`) {
      const text = o.config === undefined ? JSON.stringify(CONFIG_FILE) : o.config
      return text === null ? { deny: `ENOENT ${e.path}` } : { value: text }
    }
    if (e.path === `${HOME}/notes/status.md` || e.path === '/srv/notes/bench.md') {
      return o.failStand === true && e.path.endsWith('/bench.md') ? { deny: `ENOENT ${e.path}` } : { value: '# Stand\n\n## Nächster Schritt\nWrite the parser docs next.\n' }
    }
    if (e.path === `${HOME}/.claude/skills/create-backlog/SKILL.md`) {
      return o.noSkill === true ? { deny: `ENOENT ${e.path}` } : { value: '# Create Backlog\nSKILL BODY verbatim' }
    }
    if (e.path.endsWith('.jsonl') && o.apply?.report !== undefined) return { value: o.apply.report }
    const file = seen.files.get(e.path)
    return file === undefined ? { deny: `ENOENT ${e.path}` } : { value: file }
  })
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    seen.runs.push(argv)
    const line = argv.join(' ')
    if (argv[0] === AZ) {
      if (o.slow?.az !== undefined) await seen.clock.sleep(o.slow.az)
      if (o.failAz === true) return { value: result(1, '', 'AADSTS: login required') }
      const url = argv[argv.indexOf('--url') + 1] ?? ''
      if (url.endsWith(`/planner/plans/${PLAN_ID}/tasks`)) return { value: result(0, JSON.stringify({ value: o.tasks ?? TASKS })) }
      const id = /\/planner\/tasks\/([^/]+)\/details$/.exec(url)?.[1]
      return id === undefined ? { value: result(1, '', 'unexpected') } : { value: result(0, JSON.stringify(details(id))) }
    }
    if (argv[0] === GH && argv[1] === 'pr') {
      return { value: result(0, JSON.stringify(line.includes('example-org/alpha') ? PRS : [])) }
    }
    if (argv[0] === GH && argv[1] === 'api') {
      return { value: result(0, line.includes('backlog.md') ? (o.backlog ?? '# Backlog\n## Open item\ntext\n') : '# Changelog\n## [Unreleased]\n- x\n') }
    }
    if (argv[0] === '/usr/bin/rm') return { value: result(0, '') }
    if (argv[0] === PYTHON) {
      seen.confirmAtApply = seen.files.get(`${DIR}/confirm.json`)
      if (o.slow?.apply !== undefined) await seen.clock.sleep(o.slow.apply)
      if (o.apply?.reject === true) throw new Error('timed out')
      const rows = (argv[argv.indexOf('--rows') + 1] ?? '').split(',').map(Number)
      const results = o.apply?.results ?? []
      const written = rows.map((n, i) => ({ n, result: results[i] ?? 'ok', detail: '' }))
      // Like apply.py: one line per row in the report, then the final line.
      const report = argv[argv.indexOf('--report') + 1] ?? ''
      const lines = [...written.map(r => JSON.stringify(r)), JSON.stringify({ final: true, status: 'ok', reason: '', written: true })]
      seen.files.set(report, `${lines.join('\n')}\n`)
      return { value: result(0, JSON.stringify({ status: 'ok', reason: '', written: true, rows: written })) }
    }
    return { deny: `unexpected ${line}` }
  })
  on('model.complete', async ($, e) => {
    seen.prompts.push({ system: String(e.system), prompt: String(e.prompt), model: e.model, effort: e.effort, maxTokens: e.maxTokens })
    if (o.slow?.model !== undefined) await seen.clock.sleep(o.slow.model)
    return { value: { isAnswered: true, text: o.reply ?? REPLY, usage: { ...ZERO, input_tokens: 1234, output_tokens: 56 } } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran', stderr: '', interrupted: false } as never }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'engine', ref: 0 }) as never)
  return seen
}

function start($: Engine, isInteractive = true) {
  return $.session.start({ cwd: '/work', surface: isInteractive ? 'terminal' : null, isInteractive })
}

async function board($: Engine): Promise<string> {
  const ran = await $.command.run({ command: 'board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  return ran.text ?? ''
}

function hintLine($: Engine, columns: number, isWorking = false) {
  return $.ui.mount({
    plugin: 'board',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking, hint: '? for shortcuts' },
    viewport: { columns, rows: 40, isFullscreen: true },
  })
}

// The run started from a timer goes on through many engine calls: wait for its end.
async function settled(seen: { clock: MockClock; ends: number }): Promise<void> {
  for (let i = 0; i < 1000 && seen.ends === 0; i += 1) await seen.clock.settle()
}

function pane($: Engine) {
  return $.ui.mount({
    plugin: 'board',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'board-update',
    props: { title: 'Board Update', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    viewport: { columns: 160, rows: 40, isFullscreen: true },
  })
}

type Pane = Awaited<ReturnType<typeof pane>>

// Everything the pane shows, as one text.
async function shown(ui: Pane): Promise<string> {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n') + '\n' + (await ui.findAll({ type: 'Button' })).map(b => b.text).join('\n')
}

// Lets the run go on until the pane shows `text`.
async function until(seen: { clock: MockClock }, ui: Pane, text: string | RegExp): Promise<string> {
  let now = ''
  for (let i = 0; i < 300; i += 1) {
    now = await shown(ui)
    if (typeof text === 'string' ? now.includes(text) : text.test(now)) return now
    await seen.clock.settle()
  }
  throw new Error(`pane never showed ${String(text)}; it shows:\n${now}`)
}

const applyRun = (runs: string[][]) => runs.find(argv => argv[0] === PYTHON)
const stamped = '2026-10-27-140000'

// ---- pure logic -----------------------------------------------------------

describe('pill width', () => {
  test('fits from about 85 columns beside the other pills, gone below', () => {
    expect(pillFits(120, '? for shortcuts')).toBe(true)
    expect(pillFits(84, '? for shortcuts')).toBe(true)
    expect(pillFits(83, '? for shortcuts')).toBe(false)
    expect(pillFits(80, '? for shortcuts')).toBe(false)
    expect(pillFits(120, 'esc to interrupt · ctrl+t to show todos · ctrl+b to run in background')).toBe(false)
    expect(pillFits(undefined, 'x')).toBe(true)
  })
})

describe('proposal check', () => {
  const cards: Card[] = [
    { id: 'A1', title: 'Open', bucket: 'in_progress', percent: 0, assigned: 'none', createdBy: ME, etag: 'W/"a"', details: { etag: 'W/"ad"', description: '', checklist: [] } },
    { id: 'B2', title: 'Held', bucket: 'in_review', percent: 50, assigned: 'someone_else', createdBy: ME, etag: 'W/"b"', details: { etag: 'W/"bd"', description: '', checklist: [] } },
    { id: 'C3', title: 'Done card', bucket: 'done', percent: 100, assigned: 'none', createdBy: ME, etag: 'W/"c"' },
  ]
  const prs: Pr[] = [
    { repo: 'alpha', number: 133, title: 't', author: 'someone', state: 'OPEN', isDraft: false, mergedAt: null, updatedAt: '', branch: '' },
    { repo: 'alpha', number: 174, title: 't', author: 'owner-login', state: 'MERGED', isDraft: false, mergedAt: 'x', updatedAt: '', branch: '' },
  ]
  const check = (rows: unknown[], ctx: Context = NO_CONTEXT, on: Card[] = cards) => {
    const checked = checkProposal({ rows }, on, prs, CFG, ctx)
    if (typeof checked === 'string') throw new Error(checked)
    return checked
  }

  test('ids, etags and titles come from the read, never from the model', () => {
    const { rows } = check([{ action: 'percent', taskId: 'A1', percent: 100, evidence: 'x' }])
    expect(rows).toEqual([{ n: 1, taskId: 'A1', title: 'Open', etag: 'W/"a"', detailsEtag: 'W/"ad"', evidence: 'x', action: 'percent', percent: 100 }])
  })

  test('drops what the positive list does not hold', () => {
    const { rows, dropped } = check([
      { action: 'delete', taskId: 'A1' },
      { action: 'percent', taskId: 'A1', percent: 30 },
      { action: 'percent', taskId: 'A1', percent: 50, priority: 1 },
      { action: 'percent', taskId: 'X$(id)', percent: 100 },
      { action: 'move', taskId: 'C3', bucket: 'backlog' },
      { action: 'move', taskId: 'A1', bucket: 'trash' },
      { action: 'marker', taskId: 'A1', marker: { status: 'whatever' } },
      { action: 'marker', taskId: 'A1', marker: { status: 'done', ref: 'x; rm -rf /' } },
      { action: 'marker', taskId: 'A1', marker: { status: 'done', pr: 174 } },
      { action: 'assign', taskId: 'B2' },
      { action: 'assign', taskId: 'A1', evidence: `für ${ME}` },
      { action: 'create', title: 'Open', bucket: 'backlog', assign: false },
      { action: 'create', title: 'New Card', bucket: 'nowhere', assign: false },
    ])
    expect(rows).toEqual([])
    expect(dropped).toHaveLength(13)
  })

  test('one row per card and field; at most thirty rows', () => {
    const { rows, dropped } = check([
      { action: 'percent', taskId: 'A1', percent: 100 },
      { action: 'percent', taskId: 'A1', percent: 50 },
    ])
    expect(rows).toHaveLength(1)
    expect(dropped[0]).toContain('doppelt')

    const lots: Card[] = Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({
      id: `M${i}`,
      title: `Card ${i}`,
      bucket: 'backlog',
      percent: 0,
      assigned: 'none',
      etag: 'W/"m"',
      details: { etag: 'W/"md"', description: '', checklist: [] },
    }))
    const many = lots.map(c => ({ action: 'percent', taskId: c.id, percent: 50 }))
    const capped = check(many, NO_CONTEXT, lots)
    expect(capped.rows).toHaveLength(MAX_ROWS)
    expect(capped.rows.at(-1)?.n).toBe(MAX_ROWS)
    expect(capped.dropped).toEqual([`5 Vorschläge über der Grenze von ${MAX_ROWS}`])
  })

  test('no assignment to a card tied to someone else’s PR', () => {
    const { rows, dropped } = check([
      { action: 'assign', taskId: 'A1' },
      { action: 'marker', taskId: 'A1', marker: { status: 'in_review', repo: 'alpha', pr: 133 } },
    ])
    expect(rows.map(r => r.action)).toEqual(['marker'])
    expect(rows.map(r => r.n)).toEqual([1])
    expect(dropped).toHaveLength(1)
  })

  test('drops what is already so: same percent, same bucket, a block that says it', () => {
    const block = '<!-- board -->\r\nSTATUS 2026-10-01: in review · PR alpha#133\r\n<!-- /board -->\r\n\r\nBody'
    const held: Card[] = [
      { id: 'D4', title: 'Marked', bucket: 'in_review', percent: 50, assigned: 'none', createdBy: ME, etag: 'W/"d"', details: { etag: 'W/"dd"', description: block, checklist: [] } },
    ]
    const checked = checkProposal(
      {
        rows: [
          { action: 'percent', taskId: 'D4', percent: 50 },
          { action: 'move', taskId: 'D4', bucket: 'in_review' },
          { action: 'marker', taskId: 'D4', marker: { status: 'in_review', repo: 'alpha', pr: 133 } },
        ],
      },
      held,
      prs,
      CFG,
      NO_CONTEXT,
    )
    if (typeof checked === 'string') throw new Error(checked)
    expect(checked.rows).toEqual([])
    expect(checked.dropped).toHaveLength(3)
    // One line break after the block is the same block.
    expect(markerIsCurrent('<!-- board -->\nSTATUS 2026-01-01: open\n<!-- /board -->\nText', { status: 'open' })).toBe(true)
    // Another status is a change.
    expect(markerIsCurrent(block, { status: 'done', repo: 'alpha', pr: 133 })).toBe(false)
    // A board-src line on top is read past, as apply.py does.
    expect(markerIsCurrent('<!-- board-src: alpha/backlog.md#0123456789ab -->\n\n<!-- board -->\nSTATUS 2026-01-01: open\n<!-- /board -->\n\nText', { status: 'open' })).toBe(true)
  })

  test('the block text matches what apply.py writes', () => {
    // The same literal sits in tests/test_apply.py.
    expect(markerFields({ status: 'in_review', repo: 'alpha', pr: 133, ref: 'backlog.md:273' })).toBe(
      'in review · PR alpha#133 · ref backlog.md:273',
    )
    expect(markerFields({ status: 'side_project' })).toBe('side project')
  })

  test('a new title is at most 70 characters, so the table shows all of it', async () => {
    const ctx = await contextFor(BACKLOG)
    const { rows, dropped } = check(
      [create({ title: 'A'.repeat(71) }), create({ title: 'B'.repeat(70) })],
      ctx,
    )
    expect(rows.map(r => r.title)).toEqual(['B'.repeat(70)])
    expect(dropped).toHaveLength(1)
  })

  test('assign only for a card in In Progress or moved there; no user id from a card title', () => {
    const more: Card[] = [
      ...cards,
      { id: 'E5', title: 'Backlog card', bucket: 'backlog', percent: 0, assigned: 'none', createdBy: ME, etag: 'W/"e"', details: { etag: 'W/"ed"', description: '', checklist: [] } },
      { id: 'F6', title: `Owner ${OTHER}`, bucket: 'backlog', percent: 0, assigned: 'none', createdBy: ME, etag: 'W/"f"', details: { etag: 'W/"fd"', description: '', checklist: [] } },
    ]
    const checked = checkProposal(
      {
        rows: [
          { action: 'assign', taskId: 'E5' },
          { action: 'assign', taskId: 'A1' },
          { action: 'percent', taskId: 'F6', percent: 50 },
        ],
      },
      more,
      prs,
      CFG,
      NO_CONTEXT,
    )
    if (typeof checked === 'string') throw new Error(checked)
    expect(checked.rows.map(r => ('taskId' in r ? r.taskId : ''))).toEqual(['A1'])
    expect(checked.dropped).toHaveLength(2)

    const moved = checkProposal(
      { rows: [{ action: 'move', taskId: 'E5', bucket: 'in_progress', progress: { standLine: 'Backlog card runs' } }, { action: 'assign', taskId: 'E5' }] },
      more,
      prs,
      CFG,
      { ...NO_CONTEXT, standText: '## Offen\n- Backlog card runs' },
    )
    if (typeof moved === 'string') throw new Error(moved)
    expect(moved.rows.map(r => r.action)).toEqual(['move', 'assign'])
  })

  test('the reply may come fenced; anything else is unusable', () => {
    expect(extractJson('```json\n{"rows":[]}\n```')).toEqual({ rows: [] })
    expect(extractJson('Here: {"rows":[]} done')).toEqual({ rows: [] })
    expect(extractJson('no json')).toBeNull()
    expect(checkProposal(null, cards, prs, CFG, NO_CONTEXT)).toBe('Antwort ist kein gültiges JSON')
    expect(checkProposal({ items: [] }, cards, prs, CFG, NO_CONTEXT)).toBe('Antwort ist kein Objekt mit "rows"')
  })

  test('a broken row line in the asked form goes alone; the rows that parse stay', () => {
    const reply = [
      '{"rows":[',
      '{"action":"percent","taskId":"A1","percent":50,"evidence":"x.md:1"},',
      '{"action":"assign","taskId":"A1".replace?"":"","evidence":""},',
      '{"action":"percent","taskId":"B2","percent":100,"evidence":"x.md:2"}',
      ']}',
    ].join('\n')
    const checked = checkProposal(extractJson(reply), cards, prs, CFG, NO_CONTEXT)
    if (typeof checked === 'string') throw new Error(checked)
    expect(checked.rows.map(r => ('taskId' in r ? r.taskId : ''))).toEqual(['A1', 'B2'])
    expect(checked.dropped).toEqual(['Vorschlag 2: kein gültiges JSON'])
    expect(checked.rejected.map(x => x.reason)).toEqual(['kein gültiges JSON'])
  })

  test('a broken reply in any other form stays unusable', () => {
    const cut = '{"rows":[\n{"action":"percent","taskId":"A1","percent":50,"evidence":"x"},\n{"action":"percent","taskId":"B2",'
    const pretty = '{"rows":[\n  {\n    "action": "percent",\n    "taskId": "A1".x\n  }\n]}'
    for (const reply of [cut, pretty]) {
      expect(extractJson(reply)).toBeNull()
      expect(checkProposal(extractJson(reply), cards, prs, CFG, NO_CONTEXT)).toBe('Antwort ist kein gültiges JSON')
    }
  })

  test('a broken start line takes its assign along: a backlog card stays free', () => {
    const more: Card[] = [
      ...cards,
      { id: 'E5', title: 'Backlog card', bucket: 'backlog', percent: 0, assigned: 'none', createdBy: ME, etag: 'W/"e"', details: { etag: 'W/"ed"', description: '', checklist: [] } },
    ]
    const reply = [
      '{"rows":[',
      '{"action":"move","taskId":"E5","bucket":"in_progress","progress":{"standLine":"Backlog card runs"}.x,"evidence":"x"},',
      '{"action":"assign","taskId":"E5","evidence":"x"}',
      ']}',
    ].join('\n')
    const checked = checkProposal(extractJson(reply), more, prs, CFG, { ...NO_CONTEXT, standText: '## Offen\n- Backlog card runs' })
    if (typeof checked === 'string') throw new Error(checked)
    expect(checked.rows).toEqual([])
    expect(checked.rejected.map(x => x.reason)).toEqual(['kein gültiges JSON', 'Karte nicht in In Progress (Backlog/Sprint bleiben frei)'])
  })

  test('statuses, repos and skipped cards follow the config', () => {
    const side: Card[] = [
      ...cards,
      { id: 'G7', title: 'Side: Tidy Notes', bucket: 'backlog', percent: 0, assigned: 'none', createdBy: ME, etag: 'W/"g"', details: { etag: 'W/"gd"', description: '', checklist: [] } },
    ]
    const checked = checkProposal(
      {
        rows: [
          { action: 'marker', taskId: 'A1', marker: { status: 'side_project' } },
          { action: 'marker', taskId: 'B2', marker: { status: 'mystery' } },
          { action: 'marker', taskId: 'B2', marker: { status: 'open', repo: 'gamma', pr: 1 } },
          { action: 'percent', taskId: 'G7', percent: 50 },
        ],
      },
      side,
      prs,
      CFG,
      NO_CONTEXT,
    )
    if (typeof checked === 'string') throw new Error(checked)
    expect(checked.rows.map(r => r.action)).toEqual(['marker'])
    expect(checked.dropped).toHaveLength(3)
  })
})

describe('new cards in the create-backlog format', () => {
  const cards: Card[] = [
    { id: 'A1', title: 'Open', bucket: 'in_progress', percent: 0, assigned: 'none', createdBy: ME, etag: 'W/"a"', details: { etag: 'W/"ad"', description: '', checklist: [] } },
  ]
  const check = (rows: unknown[], ctx: Context, on: Card[] = cards) => {
    const checked = checkProposal({ rows }, on, [], CFG, ctx)
    if (typeof checked === 'string') throw new Error(checked)
    return checked
  }

  test('the source key is the one apply.py computes', async () => {
    // The same literal sits in tests/test_apply.py.
    expect(await sourceKey(CACHE)).toBe('1edc5164ebbd')
  })

  test('a valid card keeps its fields and names its source entry', async () => {
    const { rows, dropped } = check([create()], await contextFor(BACKLOG))
    expect(dropped).toEqual([])
    expect(rows).toEqual([
      {
        n: 1,
        action: 'create',
        title: 'Cache the Parsed Pages',
        priority: 'Important',
        userStory: STORY,
        tasks: ['Add a cache folder per input', 'Key entries by the input hash'],
        acceptanceCriteria: CRITERIA,
        source: { file: 'alpha/backlog.md', heading: CACHE },
        evidence: 'alpha/backlog.md:3',
      },
    ])
    // Twenty-five tasks pass; apply.py puts the last five below the description.
    const many = check([create({ tasks: Array.from({ length: 25 }, (_, i) => `Task number ${i + 1}`) })], await contextFor(BACKLOG))
    expect(many.rows).toHaveLength(1)
  })

  test('a card off the format is dropped, each for its own reason', async () => {
    const ctx = await contextFor(BACKLOG)
    for (const bad of [
      create({ priority: 'Must' }),
      create({ userStory: 'As a developer, I want the cache so that reruns are fast.' }),
      create({ userStory: 'As a developer, I want to cache the parsed pages.' }),
      create({ userStory: 'As an operator, I want to cache the parsed pages so that reruns are fast.' }),
      create({ acceptanceCriteria: CRITERIA.slice(0, 2) }),
      create({ acceptanceCriteria: [...CRITERIA, 'Fourth criterion', 'Fifth criterion', 'Sixth criterion'] }),
      create({ tasks: [] }),
      create({ tasks: Array.from({ length: 41 }, (_, i) => `Task ${i}`) }),
      create({ title: 'Cache the `parsed` Pages' }),
      create({ title: 'Cache the **Parsed** Pages' }),
      create({ title: '2026-10-20 — Cache the Parsed Pages' }),
      create({ tasks: ['Add <!-- board --> here'] }),
      create({ userStory: 'As a developer, I want to cache <!-- x --> pages so that reruns are fast.' }),
      create({ title: 'Cache Pages 2026-10-20 – Again' }),
      create({ userStory: 'As a developer, I want to cache pages\nso that reruns are fast.' }),
      create({ tasks: ['line\nbreak'] }),
      create({ bucket: 'backlog' }),
    ]) {
      const { rows, dropped } = check([bad], ctx)
      expect([bad, rows]).toEqual([bad, []])
      expect(dropped).toHaveLength(1)
    }
  })

  test('the source must be an open entry of a read backlog file that no card holds yet', async () => {
    const ctx = await contextFor(BACKLOG)
    const key = await sourceKey(CACHE)
    const holder: Card = {
      id: 'H8',
      title: 'Something Else',
      bucket: 'backlog',
      percent: 0,
      assigned: 'none',
      etag: 'W/"h"',
      details: { etag: 'W/"hd"', description: `<!-- board-src: alpha/backlog.md#${key} -->\n\nPriority: Low`, checklist: [] },
    }
    const twin: Card = { ...holder, id: 'H9', title: '2026-10-20 — Cache the `Parsed` Pages.', details: { etag: 'W/"h9"', description: 'old', checklist: [] } }
    expect(check([create({ source: { file: 'alpha/backlog.md', heading: 'No Such Entry' } })], ctx).dropped[0]).toContain('keiner gelesenen Backlog-Datei')
    expect(check([create({ source: { file: 'alpha/backlog.md', heading: '2026-10-01 — Old Exporter ✅ DONE' } })], ctx).dropped[0]).toContain('DONE')
    expect(check([create({ source: { file: 'beta/backlog.md', heading: CACHE } })], ctx).dropped).toHaveLength(1)
    expect(check([create()], ctx, [...cards, holder]).dropped[0]).toContain('hat schon eine Karte')
    // An old card without a source line and the same title (date, backticks and full stop aside).
    expect(normalTitle(twin.title)).toBe(normalTitle('Cache the Parsed Pages'))
    expect(check([create()], ctx, [...cards, twin]).dropped[0]).toContain('gibt es schon')
    // Two creates for one entry: the second goes.
    expect(check([create(), create({ title: 'Cache Pages Again' })], ctx).rows).toHaveLength(1)
  })

  test('at most fifteen new cards per run', async () => {
    const text = Array.from({ length: 17 }, (_, i) => `## Entry Number ${i}\ntext`).join('\n')
    const ctx = await contextFor(text)
    const rows = Array.from({ length: 17 }, (_, i) => create({ title: `Entry Number ${i}`, source: { file: 'alpha/backlog.md', heading: `Entry Number ${i}` } }))
    const checked = check(rows, ctx)
    expect(checked.rows).toHaveLength(15)
    expect(checked.dropped).toEqual(['Vorschlag 16: mehr als 15 neue Karten', 'Vorschlag 17: mehr als 15 neue Karten'])
  })

  test('without the skill file no card is created', async () => {
    const ctx = await contextFor(BACKLOG, { hasSkill: false })
    const checked = check([create()], ctx)
    expect(checked.rows).toEqual([])
    expect(checked.dropped[0]).toContain('gesperrt')
  })

  test('source sets the entry of an old card without one', async () => {
    const ctx = await contextFor(BACKLOG)
    const old: Card = { id: 'O1', title: 'Cache Pages', bucket: 'backlog', percent: 0, assigned: 'none', createdBy: ME, etag: 'W/"o"', details: { etag: 'W/"od"', description: 'old text', checklist: [] } }
    const marked: Card = { ...old, id: 'O2', details: { etag: 'W/"o2"', description: '<!-- board-src: alpha/backlog.md#0123456789ab -->\nold', checklist: [] } }
    const source = { file: 'alpha/backlog.md', heading: CACHE }
    const { rows, dropped } = check(
      [
        { action: 'source', taskId: 'O1', source, evidence: 'alpha/backlog.md:3' },
        { action: 'source', taskId: 'O2', source: { file: 'alpha/backlog.md', heading: '2026-10-21 — Tidy the Docs Folder' } },
        create(),
      ],
      ctx,
      [old, marked],
    )
    expect(rows).toEqual([{ n: 1, action: 'source', taskId: 'O1', title: 'Cache Pages', etag: 'W/"o"', detailsEtag: 'W/"od"', source, evidence: 'alpha/backlog.md:3' }])
    // The second card has its line; the create's entry is now held by O1.
    expect(dropped).toHaveLength(2)
  })
})

describe('rewriting old cards', () => {
  test('is switched off: a rewrite row is dropped and the prompt offers none', () => {
    const rewrite = { action: 'rewrite', taskId: 'A1', ...(({ source: _s, action: _a, ...f }) => f)(create()) }
    const own: Card = { id: 'A1', title: 'Old card', bucket: 'backlog', percent: 0, assigned: 'none', createdBy: ME, etag: 'W/"a"', details: { etag: 'W/"ad"', description: '', checklist: [] } }
    const checked = checkProposal({ rows: [rewrite] }, [own], [], CFG, NO_CONTEXT)
    if (typeof checked === 'string') throw new Error(checked)
    expect(checked.rows).toEqual([])
    expect(checked.dropped).toEqual(['Vorschlag 1: neu fassen ist abgeschaltet'])
    expect(systemPrompt(CFG, 'skill', false)).not.toContain('"action":"rewrite"')
  })
})

describe('cards someone else made', () => {
  test('are not assigned, rewritten or started; other rows on them go', () => {
    const theirs: Card = {
      id: 'C9',
      title: 'Their Card',
      bucket: 'in_progress',
      percent: 0,
      assigned: 'none',
      createdBy: OTHER,
      etag: 'W/"c9"',
      details: { etag: 'W/"c9d"', description: 'free text', checklist: [] },
    }
    const backlog: Card = { ...theirs, id: 'C8', bucket: 'backlog', etag: 'W/"c8"' }
    const unknown: Card = { ...theirs, id: 'C7', createdBy: undefined, etag: 'W/"c7"' }
    const checked = checkProposal(
      {
        rows: [
          { action: 'assign', taskId: 'C9' },
          { action: 'move', taskId: 'C8', bucket: 'in_progress', progress: { standLine: 'Cache work runs' } },
          { action: 'assign', taskId: 'C7' },
          { action: 'percent', taskId: 'C9', percent: 50 },
        ],
      },
      [theirs, backlog, unknown],
      [],
      CFG,
      { ...NO_CONTEXT, standText: '## Offen\n- Cache work runs' },
    )
    if (typeof checked === 'string') throw new Error(checked)
    expect(checked.rows.map(r => r.action)).toEqual(['percent'])
    expect(checked.dropped).toHaveLength(3)
    expect(checked.dropped.every(d => d.includes('jemand anderes angelegt'))).toBe(true)
  })
})

describe('In Progress', () => {
  const card = (id: string, bucket: BucketKey): Card => ({
    id,
    title: `Cache the Parsed Pages ${id}`,
    bucket,
    percent: 0,
    assigned: 'none',
    createdBy: ME,
    etag: `W/"${id}"`,
    details: { etag: `W/"${id}d"`, description: '', checklist: [] },
  })
  const keyed: Card = { ...card('B4', 'backlog'), title: 'Tidy Up', details: { etag: 'W/"B4d"', description: '<!-- board-src: alpha/backlog.md#0123456789ab -->\n\nx', checklist: [] } }
  const cards = [card('B1', 'backlog'), card('B2', 'sprint_backlog'), card('B3', 'in_review'), keyed]
  const pr = (number: number, author: string, state: string, title: string, branch = '') =>
    ({ repo: 'alpha', number, title, author, state, isDraft: false, mergedAt: null, updatedAt: '', branch }) as Pr
  const prs: Pr[] = [
    pr(174, 'owner-login', 'OPEN', 'Cache parsed pages per input'),
    pr(133, 'someone', 'OPEN', 'Cache parsed pages per input'),
    pr(160, 'owner-login', 'MERGED', 'Cache parsed pages per input'),
    pr(175, 'owner-login', 'OPEN', 'Release 0.12.0'),
    pr(176, 'owner-login', 'OPEN', 'Small fix', 'feature/0123456789ab-tidy'),
  ]
  const STAND = '# Stand\n\n## Offen\n- Cache work runs on branch feature/cache\n---\n\n## Erledigt\n- Old work runs no more\n\n## Nächster Schritt\n1. Then the docs run\n'
  const ctx: Context = { ...NO_CONTEXT, standText: STAND }
  const start = (taskId: string, progress?: unknown) => ({ action: 'move', taskId, bucket: 'in_progress', ...(progress === undefined ? {} : { progress }), evidence: 'x' })
  const check = (rows: unknown[], on: Context = ctx) => {
    const checked = checkProposal({ rows }, cards, prs, CFG, on)
    if (typeof checked === 'string') throw new Error(checked)
    return checked
  }

  test('an open PR of the owner or a whole line of the stand file starts a card, with assign', () => {
    const viaPr = check([start('B1', { pr: 174, repo: 'alpha' }), { action: 'assign', taskId: 'B1' }])
    expect(viaPr.dropped).toEqual([])
    expect(viaPr.rows.map(r => r.action)).toEqual(['move', 'assign'])
    expect(viaPr.rows[0]?.evidence).toBe('Läuft: PR alpha#174 „Cache parsed pages per input“ – x')
    const viaLine = check([start('B2', { standLine: 'Cache work runs on branch feature/cache' })])
    expect(viaLine.rows[0]?.evidence).toBe('Läuft: „Cache work runs on branch feature/cache“ – x')
    expect(check([start('B2', { standLine: 'Then the docs run' })]).rows).toHaveLength(1)
    // A PR whose branch carries the card's source hash names it too.
    expect(check([start('B4', { pr: 176, repo: 'alpha' })]).rows).toHaveLength(1)
  })

  test('a PR of the owner that does not name the card, or a line outside the running sections: dropped', () => {
    for (const progress of [
      { pr: 175, repo: 'alpha' },
      { standLine: 'Old work runs no more' },
      { standLine: '## Offen' },
      { standLine: 'Offen' },
      { standLine: '---' },
      { standLine: '' },
    ]) {
      const { rows, dropped } = check([start('B1', progress)])
      expect([progress, rows]).toEqual([progress, []])
      expect(dropped[0]).toContain('In Progress nur mit')
    }
    expect(check([start('B4', { pr: 174, repo: 'alpha' })]).rows).toEqual([])
  })

  test('a start stands unticked in the pane, and so does its assign', () => {
    const { rows } = check([start('B1', { pr: 174, repo: 'alpha' }), { action: 'assign', taskId: 'B1' }])
    expect(paneRows(rows, cards).map(r => [r.change, r.isChecked])).toEqual([
      ['→ In Progress', false],
      ['mir zuweisen', false],
    ])
  })

  test('no proof, someone else’s PR, a merged PR, a piece of a line, no stand file: dropped', () => {
    for (const progress of [undefined, { pr: 133, repo: 'alpha' }, { pr: 160, repo: 'alpha' }, { pr: 999, repo: 'alpha' }, { standLine: 'Cache work' }, { standLine: 'x', pr: 174 }]) {
      const { rows, dropped } = check([start('B1', progress)])
      expect([progress, rows]).toEqual([progress, []])
      expect(dropped[0]).toContain('In Progress nur mit')
    }
    expect(check([start('B1', { standLine: 'Cache work runs on branch feature/cache' })], NO_CONTEXT).rows).toEqual([])
    // From another bucket the rule does not apply.
    expect(check([start('B3')]).rows).toHaveLength(1)
  })
})

describe('the Sprint Backlog', () => {
  const backlogCard = (id: string): Card => ({
    id,
    title: `Card ${id}`,
    bucket: 'backlog',
    percent: 0,
    assigned: 'none',
    createdBy: ME,
    etag: `W/"${id}"`,
    details: { etag: `W/"${id}d"`, description: '', checklist: [] },
  })
  const cards: Card[] = [
    backlogCard('S1'),
    backlogCard('S2'),
    backlogCard('S3'),
    backlogCard('S4'),
    { id: 'P1', title: 'Running', bucket: 'in_progress', percent: 0, assigned: 'none', createdBy: ME, etag: 'W/"p"', details: { etag: 'W/"pd"', description: '', checklist: [] } },
  ]
  const steps = nextStepsOf('# Stand\n\n## Nächster Schritt\n\n- Ship the **cache** work\n- Then tidy the docs.\n\n## Later\nnot this')
  const ctx: Context = { ...NO_CONTEXT, nextSteps: steps }
  const pull = (taskId: string, nextStep = 'ship the cache work') => ({ action: 'move', taskId, bucket: 'sprint_backlog', nextStep, evidence: 'Stand' })
  const check = (rows: unknown[], on: Context = ctx) => {
    const checked = checkProposal({ rows }, cards, [], CFG, on)
    if (typeof checked === 'string') throw new Error(checked)
    return checked
  }

  test('the section stops at the next heading of its level', () => {
    expect(steps).toBe('- Ship the **cache** work\n- Then tidy the docs.')
    expect(nextStepsOf('# Stand\nnothing')).toBeNull()
  })

  test('a pull from Backlog for a named next step goes, its evidence quoting the step', () => {
    const { rows, dropped } = check([pull('S1')])
    expect(dropped).toEqual([])
    expect(rows).toEqual([{ n: 1, action: 'move', taskId: 'S1', title: 'Card S1', etag: 'W/"S1"', detailsEtag: 'W/"S1d"', bucket: 'sprint_backlog', evidence: 'Nächster Schritt: „ship the cache work“ – Stand' }])
  })

  test('another bucket, a fourth pull, an assignment, a step not in the section, no standFile: dropped', () => {
    expect(check([pull('P1')]).dropped[0]).toContain('nur aus Backlog')
    const four = check([pull('S1'), pull('S2'), pull('S3', 'Then tidy the docs.'), pull('S4', '- then tidy the docs.')])
    expect(four.rows).toHaveLength(3)
    expect(four.dropped).toEqual(['Vorschlag 4: mehr als 3 Karten in den Sprint Backlog'])
    const assigned = check([pull('S1'), { action: 'assign', taskId: 'S1' }])
    expect(assigned.rows.map(r => r.action)).toEqual(['move'])
    expect(assigned.dropped[0]).toContain('bleiben frei')
    expect(check([pull('S1', 'release the parser')]).dropped[0]).toContain('nextStep')
    // Only a whole line or bullet counts, never a piece of one.
    for (const piece of ['the docs', 'tidy the docs', 'Ship the', 'cache']) {
      expect([piece, check([pull('S1', piece)]).dropped[0]]).toEqual([piece, expect.stringContaining('nextStep')])
    }
    expect(check([pull('S1')], NO_CONTEXT).dropped[0]).toContain('standFile')
  })
})

describe('config', () => {
  test('the config holds or the run does not start', () => {
    expect(CFG.ghPath).toBe(GH)
    expect(CFG.pythonPath).toBe(PYTHON)
    const bad: Record<string, unknown>[] = [
      { ...CONFIG_FILE, planId: 'bad id' },
      { ...CONFIG_FILE, azPath: 'az' },
      { ...CONFIG_FILE, ownerId: 'me' },
      { ...CONFIG_FILE, buckets: { ...BUCKETS, done: BUCKETS.backlog } },
      { ...CONFIG_FILE, repos: { alpha: 'no slug' } },
      { ...CONFIG_FILE, backlogSources: [{ repo: 'gamma', path: 'backlog.md', ref: 'main' }] },
      { ...CONFIG_FILE, backlogSources: [{ repo: 'alpha', path: '../x', ref: 'main' }] },
      { ...CONFIG_FILE, statusFiles: ['relative.md'] },
      { ...CONFIG_FILE, extraStatuses: ['open'] },
      { ...CONFIG_FILE, surprise: true },
    ]
    for (const value of bad) {
      expect(typeof parseConfig(JSON.stringify(value))).toBe('string')
    }
    expect(parseConfig('{')).toBe('kein JSON')
  })
})

describe('helpers', () => {
  test('control characters never reach the screen', () => {
    expect(clean('a\u001b[2Jb\u202ec\nd')).toBe('a [2Jb c d')
    expect(clean('x'.repeat(10), 5)).toBe('xxxx…')
  })

  test('the hash matches the fixture apply.py checks against', async () => {
    expect(await sha256Hex('{"rows":[]}\nÄ')).toBe('38af88d060177d15ab6e4a7e69d4699f52d8c82602adbdceb3874ded67908411')
  })

  test('backlog digest keeps open sections numbered, DONE ones as headings', () => {
    const text = '# Backlog\n## A ✅ DONE\nhidden\n## B\nshown\n'
    expect(backlogDigest(text)).toBe('2: ## A ✅ DONE\n4: ## B\n5: shown\n6: ')
    expect(changelogHead('# C\n## [Unreleased]\nu\n## [2]\na\n## [1]\nb\n## [0]\nc', 2)).toBe(
      '1: # C\n2: ## [Unreleased]\n3: u\n4: ## [2]\n5: a\n6: ## [1]\n7: b',
    )
  })

  test('the reminder speaks after seven days or when there was no run', () => {
    expect(reminder(START - 3 * DAY, START)).toBeNull()
    expect(reminder(START - 7 * DAY, START)).toBeNull()
    expect(reminder(START - 8 * DAY, START)).toBe('Board zuletzt abgeglichen vor 8 Tagen – Knopf ▦ Board')
    expect(reminder(undefined, START)).toContain('noch nie')
  })

  test('only literal calls of the mod’s apply.py trip the guard; everyday commands pass', () => {
    for (const command of [
      'python3 ~/claude-mods/board/apply.py --rows 1',
      '/usr/bin/python3 -I /u/tester/mods/board/apply.py --rows 1 --sha256 0',
      'cd ~/claude-mods/board && python3 apply.py --rows 1',
      'python3 ~/.claude/plugins/cache/some-market/board/0.1.0/apply.py',
      'cd x && /usr/bin/python3 -I BOARD/APPLY.PY',
    ]) {
      expect([command, isApplyCall(command)]).toEqual([command, true])
    }
    for (const command of [
      'ls',
      'git status',
      'git add a*',
      'ls a*',
      'ls src/b*',
      'ls ~/c*',
      'grep -rn foo docs/b*',
      'pip show runpy-helper',
      'claude plugin test .',
      'cd ~/claude-mods/board && claude plugin test .',
      'cat ~/claude-mods/board/README.md',
      'cd ~/claude-mods && git log -- board',
      "cd ~/claude-mods/board && /usr/bin/python3 -I -m unittest discover -s tests -p 'test_*.py'",
      'ruff check *.py',
    ]) {
      expect([command, isApplyCall(command)]).toEqual([command, false])
    }
  })

  test('a test file of the mod and a pytest run pass; the other wrappings of a call stay blocked', () => {
    for (const command of [
      'grep x board/tests/test_apply.py',
      'grep -n confirm /u/tester/claude-mods/board/tests/test_apply.py',
      'python -m pytest tests/',
      'cd ~/claude-mods/board && python3 -m pytest tests/test_apply.py',
      'python3 -c "print(1)"',
    ]) {
      expect([command, isApplyCall(command)]).toEqual([command, false])
    }
    for (const command of [
      'python3 ~/.claude/plugins/cache/some-market/board/0.2.0/apply.py --rows 1',
      'cat ~/claude-mods/board//apply.py',
      'ls ~/claude-mods/board/0.2.0//apply.py',
      'cat ~/.claude/plugins/cache/some-market/board/0.2.0/apply.py',
      '{ python3 apply.py; }',
      'if true; then python3 apply.py; fi',
      'for i in 1; do python3 apply.py; done',
      '! python3 apply.py',
      'eval "python3 ~/claude-mods/board/apply.py --rows 1"',
      'eval python3 apply.py',
      'bash -lc "cd ~/claude-mods/board && python3 apply.py --rows 1"',
      "sh -xc 'python3 apply.py'",
      'sudo -u me python3 apply.py',
      'ssh host python3 apply.py',
      'watch -n1 python3 apply.py',
      'flock /tmp/l python3 apply.py',
      'strace -f python3 apply.py',
      'xargs -a f python3 apply.py',
      'bash -c "python3 ~/claude-mods/board/apply.py --rows 1"',
      'echo $(python3 board/apply.py --rows 1)',
      '"/usr/bin/python3" "board/apply.py" --rows 1',
      'timeout 60 python3 apply.py --rows 1',
      '~/claude-mods/board/apply.py --rows 1',
      'python3 < board/apply.py',
      'python3 -m runpy ~/claude-mods/board/apply.py',
    ]) {
      expect([command, isApplyCall(command)]).toEqual([command, true])
    }
  })
})

// ---- the run through the engine ---------------------------------------------

describe('a board run in the pane', () => {
  test('the pill opens the pane: collecting, thinking, ready; Übernehmen runs apply.py with the shown file’s hash', async ($, on) => {
    const seen = world(on, { slow: { az: 3000, model: 5000 } })
    await start($, false)

    const ui = await hintLine($, 120)
    expect(await ui.find({ type: 'Button', text: /▦ Board/ })).toBeDefined()
    await ui.press({ key: 'board' })
    expect(seen.opened).toEqual(['board-update'])

    const view = await pane($)
    expect(await until(seen, view, 'Sammelt … 0 s')).toContain('Abbrechen')
    await seen.clock.advance(1000)
    await until(seen, view, 'Sammelt … 1 s')
    await seen.clock.advance(5000)
    const thinking = await until(seen, view, 'Opus denkt … 0 s')
    expect(thinking).toContain('3 Karten · 2 PRs · 1 Backlog-Einträge')
    await seen.clock.advance(2000)
    await until(seen, view, 'Opus denkt … 2 s')
    await seen.clock.advance(3000)
    const ready = await until(seen, view, 'Übernehmen (3)')

    // Opus, medium, no tools, the rules as system prompt; the data inside <data>.
    const [sent] = seen.prompts
    expect(sent?.model).toBe('opus')
    expect(sent?.effort).toBe('medium')
    expect(sent?.maxTokens).toBe(32000)
    expect(sent?.system).toContain('untrusted')
    expect(sent?.system).toContain('- Cards about the side project get nothing.')
    expect(sent?.system).toContain('"alpha"|"beta"')
    expect(sent?.prompt).toContain('<data>')
    expect(sent?.prompt).toContain(T_OPEN)
    expect(sent?.prompt).not.toContain(OTHER)
    expect(sent?.prompt).toContain('"assigned": "someone_else"')

    // Collected without a shell: az with its absolute path, gh with the head of each branch.
    expect(seen.runs.some(r => r[0] === AZ && r.includes(`https://graph.microsoft.com/v1.0/planner/tasks/${T_DONE}/details`))).toBe(false)
    expect(seen.runs.some(r => r.join(' ') === '/usr/bin/gh api -H Accept: application/vnd.github.raw repos/example-org/alpha/contents/backlog.md?ref=main')).toBe(true)

    // Three rows kept, two dropped, no escape sequence; nothing in the transcript log.
    expect((await view.find({ key: 'row:1' }))?.text).toBe('mir zuweisen Write Parser Docs')
    expect((await view.find({ key: 'row:3' }))?.text).toBe('→ Done Fix Cache Race [2J')
    expect(ready).toContain('2 Vorschläge verworfen')
    expect(ready).not.toContain('\u001b')
    expect(seen.logs).toEqual([])

    // A row opens to its evidence and before -> after; unchecking changes the count.
    await view.press({ key: 'row:3' })
    const open = await until(seen, view, 'Beleg: PR #133')
    expect(open).toContain('In Review → Done')
    await view.press({ key: 'chk:2' })
    await until(seen, view, 'Übernehmen (2)')

    await view.press({ key: 'apply' })
    await until(seen, view, 'Ausgeführt: 2 von 2 Zeilen ok.')
    const file = `${DIR}/proposals-${stamped}.json`
    const document = seen.files.get(file) ?? ''
    expect(applyRun(seen.runs)).toEqual([
      PYTHON,
      '-I',
      expect.stringMatching(/\/apply\.py$/),
      '--proposals',
      file,
      '--rows',
      '1,3',
      '--sha256',
      await sha256Hex(document),
      '--report',
      `${DIR}/apply-${stamped}.jsonl`,
    ])
    // The one-time confirmation came before apply.py, with hash, rows and time.
    expect(JSON.parse(seen.confirmAtApply ?? '{}')).toEqual({ sha256: await sha256Hex(document), rows: [1, 3], at: seen.clock.now() })
    expect(JSON.parse(document).rows.map((r: { action: string }) => r.action)).toEqual(['assign', 'marker', 'move'])
    expect(seen.files.get(`${DIR}/last-run.md`)).toContain('Board: ausgeführt')
    expect(seen.store.lastRunAt).toBe(START)
    expect(seen.toasts).toContain('Board: 2 von 2 Zeilen ausgeführt.')

    await view.press({ key: 'close' })
    expect(seen.closed).toEqual(['board-update'])
  })

  test('dropped proposals stand greyed out with their reason, not tickable, and open to what they wanted', async ($, on) => {
    const seen = world(on)
    await start($, false)
    await board($)
    const view = await pane($)
    const ready = await until(seen, view, 'Übernehmen (3)')

    expect(ready).toContain('2 Vorschläge verworfen:')
    expect(ready).toContain('– Aktion nicht erlaubt (delete)')
    expect(ready).toContain('– Karte ist schon zugewiesen')
    // Only the kept rows have a checkbox.
    expect((await view.findAll({ type: 'Button' })).filter(b => (b.key ?? '').startsWith('chk:'))).toHaveLength(3)
    expect((await view.find({ key: 'drop:1' }))?.text).toBe('✗ delete Fix Cache Race [2J')
    expect((await view.find({ key: 'drop:2' }))?.text).toBe('mir zuweisen Fix Cache Race [2J')
    await view.press({ key: 'drop:1' })
    await until(seen, view, 'Beleg: weg damit')
    // Übernehmen counts and sends only the kept rows.
    await view.press({ key: 'apply' })
    await until(seen, view, 'Ausgeführt: 3 von 3 Zeilen ok.')
    expect(applyRun(seen.runs)?.[6]).toBe('1,2,3')
  })

  test('two presses on Übernehmen run apply.py once', async ($, on) => {
    const seen = world(on, { slow: { apply: 2000 } })
    await start($, false)
    await board($)
    const view = await pane($)
    await until(seen, view, 'Übernehmen (3)')

    await Promise.all([view.press({ key: 'apply' }), view.press({ key: 'apply' })])
    await seen.clock.advance(2000)
    await until(seen, view, 'Ausgeführt: 3 von 3 Zeilen ok.')
    expect(seen.runs.filter(argv => argv[0] === PYTHON)).toHaveLength(1)
  })

  test('the rows’ results come from apply.py’s report while it runs', async ($, on) => {
    const seen = world(on, { slow: { apply: 5000 }, apply: { results: ['ok', 'skipped', 'ok'] } })
    await start($, false)
    await board($)
    const view = await pane($)
    await until(seen, view, 'Übernehmen (3)')

    await view.press({ key: 'apply' })
    await until(seen, view, 'Schreibt … 0 s')
    // Half way, the report holds the first row.
    seen.files.set(`${DIR}/apply-${stamped}.jsonl`, '{"n": 1, "result": "ok", "detail": ""}\n')
    await seen.clock.advance(2000)
    const halfway = await until(seen, view, 'Schreibt … 2 s')
    expect(halfway).toContain('→ ok')
    await seen.clock.advance(3000)
    const done = await until(seen, view, 'Ausgeführt: 2 von 3 Zeilen ok.')
    expect(done).toContain('→ übersprungen')
  })

  test('Alle ab, then Übernehmen (0): no confirmation, no apply.py, a review all the same', async ($, on) => {
    const seen = world(on)
    await start($, false)
    await board($)
    const view = await pane($)
    await until(seen, view, 'Übernehmen (3)')

    await view.press({ key: 'none' })
    await until(seen, view, 'Übernehmen (0)')
    await view.press({ key: 'apply' })
    await settled(seen)

    expect(applyRun(seen.runs)).toBeUndefined()
    expect(seen.files.has(`${DIR}/confirm.json`)).toBe(false)
    expect(seen.store.lastRunAt).toBe(START)
    expect(seen.closed).toEqual(['board-update'])
  })

  test('Abbrechen while Opus thinks cuts the model call and counts as a review', async ($, on) => {
    const seen = world(on, { slow: { model: 60_000 } })
    await start($, false)
    await board($)
    const view = await pane($)
    await until(seen, view, 'Opus denkt')

    await view.press({ key: 'cancel' })
    await settled(seen)
    // The pane closes at once. The test kit holds the stand-in model hook until
    // its sleep is over (the real signal path is not seen here); the run then
    // ends on the cancel flag either way.
    expect(seen.closed).toEqual(['board-update'])
    await seen.clock.advance(60_000)
    await settled(seen)

    expect(seen.files.has(`${DIR}/proposals-${stamped}.json`)).toBe(false)
    expect(applyRun(seen.runs)).toBeUndefined()
    expect(seen.store.lastRunAt).toBe(START)
    expect(seen.closed).toEqual(['board-update'])
  })

  test('Abbrechen while collecting never calls the model and is no review', async ($, on) => {
    const seen = world(on, { slow: { az: 3000 } })
    await start($, false)
    await board($)
    const view = await pane($)
    await until(seen, view, 'Sammelt')

    await view.press({ key: 'cancel' })
    await seen.clock.advance(10_000)
    await settled(seen)

    expect(seen.prompts).toEqual([])
    expect(seen.store.lastRunAt).toBeUndefined()
    expect(seen.closed).toEqual(['board-update'])
    // The pill is free again.
    expect(await board($)).toBe('Board-Abgleich gestartet – Fenster „Board Update“.')
  })

  test('Abbrechen with the proposals shown runs nothing and counts as a review', async ($, on) => {
    const seen = world(on)
    await start($, false)
    await board($)
    const view = await pane($)
    await until(seen, view, 'Übernehmen (3)')

    await view.press({ key: 'cancel' })
    await settled(seen)

    expect(applyRun(seen.runs)).toBeUndefined()
    expect(seen.store.lastRunAt).toBe(START)
    expect(seen.closed).toEqual(['board-update'])
    // The pill is free again.
    expect(await board($)).toBe('Board-Abgleich gestartet – Fenster „Board Update“.')
  })

  test('apply.py killed at the timeout: the rows it reported are shown, the run is not stamped', async ($, on) => {
    const report = '{"n": 1, "result": "ok", "detail": ""}\n{"n": 2, "result": "skipped", "detail": "Karte seit dem Abgleich geändert"}\n'
    const seen = world(on, { apply: { reject: true, report } })
    await start($, false)
    await board($)
    const view = await pane($)
    await until(seen, view, 'Übernehmen (3)')
    await view.press({ key: 'apply' })

    const done = await until(seen, view, 'ABGEBROCHEN – apply.py ohne Abschlusszeile beendet')
    expect(done).toContain('→ unbekannt – auf dem Board prüfen')
    expect(done).toContain('→ übersprungen (Karte seit dem Abgleich geändert)')
    expect(seen.files.get(`${DIR}/last-run.md`)).toContain('ABGEBROCHEN')
    expect(seen.store.lastRunAt).toBeUndefined()
  })

  test('a run where every row failed is not stamped', async ($, on) => {
    const seen = world(on, { apply: { results: ['error', 'skipped', 'error'] } })
    await start($, false)
    await board($)
    const view = await pane($)
    await until(seen, view, 'Übernehmen (3)')
    await view.press({ key: 'apply' })
    await until(seen, view, 'Ausgeführt: 0 von 3 Zeilen ok.')

    expect(applyRun(seen.runs)).toBeDefined()
    expect(seen.store.lastRunAt).toBeUndefined()
  })

  test('an empty board stops loudly before the model and stamps nothing', async ($, on) => {
    const seen = world(on, { tasks: [] })
    await start($, false)
    await board($)
    const view = await pane($)

    expect(await until(seen, view, 'keine Karten gelesen')).toContain('Schließen')
    expect(seen.prompts).toEqual([])
    expect(seen.store.lastRunAt).toBeUndefined()
  })

  test('unreadable cards are named, and an empty proposal then stamps nothing', async ($, on) => {
    const seen = world(on, { tasks: [...TASKS, { id: 'bad id', title: 'x', '@odata.etag': 'W/"z"' }], reply: '{"rows":[]}' })
    await start($, false)
    await board($)
    const view = await pane($)

    const done = await until(seen, view, 'Keine Änderungen vorgeschlagen')
    expect(done).toContain('Achtung – 1 Karte(n) unlesbar, nicht bewertet.')
    expect(seen.store.lastRunAt).toBeUndefined()
  })

  test('an unreadable status file stops before the model', async ($, on) => {
    const seen = world(on, { failStand: true })
    await start($, false)
    await board($)
    const view = await pane($)

    await until(seen, view, 'Standdatei bench.md nicht lesbar')
    expect(seen.prompts).toEqual([])
  })

  for (const config of [null, '{', JSON.stringify({ ...CONFIG_FILE, planId: 'bad id' })]) {
    test(`a ${config === null ? 'missing' : 'broken'} config stops before anything is read`, async ($, on) => {
      const seen = world(on, { config })
      await start($, false)
      await board($)
      const view = await pane($)

      await until(seen, view, 'Abgebrochen – Konfiguration')
      expect(seen.runs).toEqual([['/usr/bin/rm', '-f', `${DIR}/confirm.json`]])
      expect(seen.prompts).toEqual([])
    })
  }

  test('a subagent turn does not block the pill', async ($, on) => {
    const seen = world(on)
    await start($, false)
    await $.turn.start({ turnId: 'sub', prompt: 'x', agentId: 'a1' } as never)
    await board($)
    const view = await pane($)
    await until(seen, view, 'Übernehmen (3)')

    expect(seen.prompts).toHaveLength(1)
  })

  test('a confirmation left from an earlier run is deleted before anything is read', async ($, on) => {
    const seen = world(on)
    await start($, false)
    await board($)
    const view = await pane($)
    await until(seen, view, 'Übernehmen (3)')

    expect(seen.runs[0]).toEqual(['/usr/bin/rm', '-f', `${DIR}/confirm.json`])
  })

  test('/board opens the pane and its text carries no card contents', async ($, on) => {
    const seen = world(on)
    await start($, false)

    const text = await board($)
    expect(text).toBe('Board-Abgleich gestartet – Fenster „Board Update“.')
    expect(seen.opened).toEqual(['board-update'])
    const view = await pane($)
    await until(seen, view, 'Übernehmen (3)')
    // A second /board while the proposals wait opens the pane again, no second run.
    expect(await board($)).toBe('Board-Abgleich läuft bereits – Fenster „Board Update“.')
    expect(seen.prompts).toHaveLength(1)
  })

  test('without a surface (-p) the run is a dry run: table in the log, no pane, no apply', async ($, on) => {
    const seen = world(on, { surfaces: [] })
    await start($, false)

    const text = await board($)

    expect(text).toBe('Board-Abgleich: 3 Vorschläge gezeigt (Trockenlauf ohne Oberfläche), nichts ausgeführt.')
    expect(text).not.toContain('Parser')
    expect(applyRun(seen.runs)).toBeUndefined()
    expect(seen.opened).toEqual([])
    expect(seen.logs).toContain('Nr | Karte | Aktion | Beleg')
    expect(seen.logs.some(l => l.startsWith('1 | Write Parser Docs | mir zuweisen'))).toBe(true)
    expect(seen.logs.filter(l => l.startsWith('Board: verworfen'))).toHaveLength(2)
  })

  test('refused while Claude works, and while a run is underway', async ($, on) => {
    const seen = world(on)
    await start($, false)

    const busy = await hintLine($, 120, true)
    expect(await busy.find({ type: 'Button', text: /▦ Board/ })).toBeUndefined()
    await busy.unmount()

    await $.turn.start({ turnId: 't1', prompt: 'x' } as never)
    expect(await board($)).toBe('Board-Abgleich nicht gestartet: Claude arbeitet gerade.')
    await seen.clock.settle()
    expect(seen.runs).toEqual([])
    expect(seen.opened).toEqual([])
    expect(seen.toasts).toEqual(['Claude arbeitet gerade – Board-Abgleich nach der Antwort.'])
  })

  test('a failed az read stops before the model', async ($, on) => {
    const seen = world(on, { failAz: true })
    await start($, false)
    await board($)
    const view = await pane($)

    await until(seen, view, 'Abgebrochen – az: AADSTS')
    expect(seen.prompts).toEqual([])
  })

  test('the skill reaches the prompt word for word; a new card shows its source entry and itself', async ($, on) => {
    const reply = JSON.stringify({ rows: [create({ source: { file: 'alpha/backlog.md', heading: CACHE } })] })
    const seen = world(on, { reply, backlog: BACKLOG })
    await start($, false)
    await board($)
    const view = await pane($)
    await until(seen, view, 'Übernehmen (1)')

    expect(seen.prompts[0]?.system).toContain('<create-backlog-skill>\n# Create Backlog\nSKILL BODY verbatim\n</create-backlog-skill>')
    // The exact story form and one full card, with the order to check every create against them.
    expect(seen.prompts[0]?.system).toContain('The user story is exactly "As a developer, I want to <goal> so that <value>."')
    expect(seen.prompts[0]?.system).toContain('"userStory":"As a developer, I want to set up Qdrant as the local vector store')
    expect(seen.prompts[0]?.system).toContain('Before you answer, check every create against this template')
    expect(seen.prompts[0]?.prompt).toContain('## Next steps (the stand file\'s section)\nWrite the parser docs next.')
    await view.press({ key: 'row:1' })
    const open = await until(seen, view, `Quelle: alpha/backlog.md › ${CACHE}`)
    expect(open).toContain('A rerun should skip the parser.')
    expect(open).toContain('Priority: Important')
    expect(open).toContain(STORY)
    expect(open).toContain('- Key entries by the input hash')
    expect(open).toContain('- The cache folder is documented')
    const document = JSON.parse(seen.files.get(`${DIR}/proposals-${stamped}.json`) ?? '{}')
    expect(document.rows[0].source).toEqual({ file: 'alpha/backlog.md', heading: CACHE })
  })

  test('a missing skill file locks new cards and the pane says why', async ($, on) => {
    const reply = JSON.stringify({ rows: [create(), { action: 'percent', taskId: T_OPEN, percent: 50, evidence: 'x' }] })
    const seen = world(on, { reply, backlog: BACKLOG, noSkill: true })
    await start($, false)
    await board($)
    const view = await pane($)

    const ready = await until(seen, view, 'Übernehmen (1)')
    expect(ready).toContain('Neue Karten gesperrt: Skill-Datei SKILL.md nicht lesbar.')
    expect(seen.prompts[0]?.system).toContain('create: not available in this run')
    expect(ready).toContain('neue Karten gesperrt')
  })

  test('an empty proposal stamps the run and shows no rows', async ($, on) => {
    const seen = world(on, { reply: '{"rows":[]}' })
    await start($, false)
    await board($)
    const view = await pane($)

    await until(seen, view, 'Keine Änderungen vorgeschlagen – Board passt zum Stand.')
    expect(await view.find({ key: 'apply' })).toBeUndefined()
    expect(seen.store.lastRunAt).toBe(START)
  })
})

describe('around the run', () => {
  test('the pill leaves a narrow line alone', async ($, on) => {
    world(on)
    await start($, false)
    const ui = await hintLine($, 80)
    expect(await ui.find({ type: 'Button', text: /▦ Board/ })).toBeUndefined()
    expect(PILL).toBe(' ▦ Board ')
  })

  test('the main model cannot run apply.py through Bash', async ($, on) => {
    world(on)
    await start($, false)

    for (const command of ['python3 /x/board/apply.py --rows 1 --sha256 0', 'cd ~/claude-mods/board && python3 apply.py']) {
      const denied = (await $.tool.call({ tool: 'Bash', command })) as { deny?: string }
      expect(denied.deny).toContain('nie per Bash')
    }
    const allowed = (await $.tool.call({ tool: 'Bash', command: 'ls' })) as { deny?: string }
    expect(allowed.deny).toBeUndefined()
  })

  test('no file tool writes the confirmation or a proposal file', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create' } as never }))
    on('tool.call', { tool: 'Edit' }, () => ({ result: {} as never }))
    on('tool.call', { tool: 'NotebookEdit' }, () => ({ result: {} as never }))
    await start($, false)

    for (const file_path of [
      `${DIR}/confirm.json`,
      '~/.claude/board/confirm.json',
      `${HOME}/.claude/x/../board/./proposals-2026-10-27-140000.json`,
      `${HOME}//.claude/board/proposals-x.json`,
    ]) {
      const write = (await $.tool.call({ tool: 'Write', file_path, content: '{}' } as never)) as { deny?: string }
      expect([file_path, write.deny]).toEqual([file_path, expect.stringContaining('nur der board-Mod')])
      const edit = (await $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' } as never)) as { deny?: string }
      expect(edit.deny).toContain('nur der board-Mod')
    }
    const notebook = (await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${DIR}/proposals-1.json`, new_source: 'x' } as never)) as { deny?: string }
    expect(notebook.deny).toContain('nur der board-Mod')
    for (const file_path of [`${DIR}/config.json`, `${DIR}/last-run.md`, `${HOME}/notes/confirm.json`, 'confirm.json']) {
      const write = (await $.tool.call({ tool: 'Write', file_path, content: '{}' } as never)) as { deny?: string }
      expect([file_path, write.deny]).toEqual([file_path, undefined])
    }
  })

  test('the startup reminder toasts once when the last run is old', async ($, on) => {
    const seen = world(on, { store: { lastRunAt: START - 9 * DAY } })
    await start($)
    await seen.clock.settle()
    await start($)
    await seen.clock.settle()

    expect(seen.toasts).toEqual(['Board zuletzt abgeglichen vor 9 Tagen – Knopf ▦ Board'])
  })

  test('no reminder after a recent run or in a -p session', async ($, on) => {
    const seen = world(on, { store: { lastRunAt: START - DAY } })
    await start($)
    await start($, false)
    await seen.clock.settle()

    expect(seen.toasts).toEqual([])
  })
})
