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
  parseConfig,
  pillFits,
  reminder,
  selectedRows,
  sha256Hex,
} from '../hooks/board'
import type { BucketKey, Card, Config, Pr } from '../hooks/board'

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
  skipTitlePrefixes: ['Side:'],
  promptRules: ['Cards about the side project get nothing.'],
  extraStatuses: ['side_project'],
}
const CFG = parseConfig(JSON.stringify(CONFIG_FILE)) as Config

const T_OPEN = 'TaskOpen0000000000000001'
const T_REVIEW = 'TaskReview00000000000001'
const T_DONE = 'TaskDone0000000000000001'

const task = (id: string, title: string, bucket: BucketKey, assignees: string[] = []) => ({
  id,
  title,
  bucketId: BUCKETS[bucket],
  percentComplete: bucket === 'done' ? 100 : 0,
  assignments: Object.fromEntries(assignees.map(a => [a, {}])),
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
  ask?: string | 'dismiss'
  reply?: string
  surfaces?: ('terminal' | 'desktop')[]
  store?: Record<string, unknown>
  failAz?: boolean
  tasks?: unknown[]
  failStand?: boolean
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
    questions: [] as string[],
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
      return o.failStand === true && e.path.endsWith('/bench.md') ? { deny: `ENOENT ${e.path}` } : { value: '# Stand' }
    }
    if (e.path.endsWith('.jsonl') && o.apply?.report !== undefined) return { value: o.apply.report }
    const file = seen.files.get(e.path)
    return file === undefined ? { deny: `ENOENT ${e.path}` } : { value: file }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    seen.runs.push(argv)
    const line = argv.join(' ')
    if (argv[0] === AZ) {
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
      return { value: result(0, line.includes('backlog.md') ? '# Backlog\n## Open item\ntext\n' : '# Changelog\n## [Unreleased]\n- x\n') }
    }
    if (argv[0] === '/usr/bin/rm') return { value: result(0, '') }
    if (argv[0] === PYTHON) {
      seen.confirmAtApply = seen.files.get(`${DIR}/confirm.json`)
      if (o.apply?.reject === true) throw new Error('timed out')
      const rows = (argv[argv.indexOf('--rows') + 1] ?? '').split(',').map(Number)
      const results = o.apply?.results ?? []
      const written = rows.map((n, i) => ({ n, result: results[i] ?? 'ok', detail: '' }))
      return { value: result(0, JSON.stringify({ status: 'ok', reason: '', written: true, rows: written })) }
    }
    return { deny: `unexpected ${line}` }
  })
  on('model.complete', ($, e) => {
    seen.prompts.push({ system: String(e.system), prompt: String(e.prompt), model: e.model, effort: e.effort, maxTokens: e.maxTokens })
    return { value: { isAnswered: true, text: o.reply ?? REPLY, usage: { ...ZERO, input_tokens: 1234, output_tokens: 56 } } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]?.question ?? ''
    seen.questions.push(question)
    if (o.ask === 'dismiss') return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [question]: o.ask ?? 'ja' } } as never }
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

const applyRun = (runs: string[][]) => runs.find(argv => argv[0] === PYTHON)
const stamped = '2026-10-27-140000'

// ---- pure logic -----------------------------------------------------------

describe('answer grammar', () => {
  test('ja, nein and ja außer are the only answers', () => {
    expect(selectedRows('ja', 4)).toEqual([1, 2, 3, 4])
    expect(selectedRows(' ja ', 2)).toEqual([1, 2])
    expect(selectedRows('ja außer 3, 1', 4)).toEqual([2, 4])
    expect(selectedRows('ja außer 2,3', 4)).toEqual([1, 4])
    expect(selectedRows('nein', 4)).toBeNull()
    for (const bad of ['Ja', 'yes', 'ja bitte', 'ja außer', 'ja außer 5', 'ja außer 0', 'ja außer 1, 1', 'ja außer 1 2', 'ja; rm -rf', '']) {
      expect(selectedRows(bad, 4)).toBeNull()
    }
    // Excluding every row leaves nothing to run.
    expect(selectedRows('ja außer 1, 2', 2)).toBeNull()
  })
})

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
    { id: 'A1', title: 'Open', bucket: 'in_progress', percent: 0, assigned: 'none', etag: 'W/"a"', details: { etag: 'W/"ad"', description: '', checklist: [] } },
    { id: 'B2', title: 'Held', bucket: 'in_review', percent: 50, assigned: 'someone_else', etag: 'W/"b"', details: { etag: 'W/"bd"', description: '', checklist: [] } },
    { id: 'C3', title: 'Done card', bucket: 'done', percent: 100, assigned: 'none', etag: 'W/"c"' },
  ]
  const prs: Pr[] = [
    { repo: 'alpha', number: 133, title: 't', author: 'someone', state: 'OPEN', isDraft: false, mergedAt: null, updatedAt: '', branch: '' },
    { repo: 'alpha', number: 174, title: 't', author: 'owner-login', state: 'MERGED', isDraft: false, mergedAt: 'x', updatedAt: '', branch: '' },
  ]
  const check = (rows: unknown[]) => {
    const checked = checkProposal({ rows }, cards, prs, CFG)
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

    const many = Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({ action: 'create', title: `New Card ${i}`, bucket: 'backlog', assign: false }))
    const capped = check(many)
    expect(capped.rows).toHaveLength(MAX_ROWS)
    expect(capped.rows.at(-1)?.n).toBe(MAX_ROWS)
    expect(capped.dropped).toEqual([`5 Vorschläge über der Grenze von ${MAX_ROWS}`])
  })

  test('no assignment to a card or a new card tied to someone else’s PR', () => {
    const { rows, dropped } = check([
      { action: 'assign', taskId: 'A1' },
      { action: 'marker', taskId: 'A1', marker: { status: 'in_review', repo: 'alpha', pr: 133 } },
      { action: 'create', title: 'Their Work', bucket: 'in_progress', assign: true, marker: { status: 'in_review', repo: 'alpha', pr: 133 } },
      { action: 'create', title: 'My Work', bucket: 'in_progress', assign: true, marker: { status: 'in_review', repo: 'alpha', pr: 174 } },
    ])
    expect(rows.map(r => r.action)).toEqual(['marker', 'create'])
    expect(rows.map(r => r.n)).toEqual([1, 2])
    expect(dropped).toHaveLength(2)
  })

  test('drops what is already so: same percent, same bucket, a block that says it', () => {
    const block = '<!-- board -->\r\nSTATUS 2026-10-01: in review · PR alpha#133\r\n<!-- /board -->\r\n\r\nBody'
    const held: Card[] = [
      { id: 'D4', title: 'Marked', bucket: 'in_review', percent: 50, assigned: 'none', etag: 'W/"d"', details: { etag: 'W/"dd"', description: block, checklist: [] } },
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
    )
    if (typeof checked === 'string') throw new Error(checked)
    expect(checked.rows).toEqual([])
    expect(checked.dropped).toHaveLength(3)
    // One line break after the block is the same block.
    expect(markerIsCurrent('<!-- board -->\nSTATUS 2026-01-01: open\n<!-- /board -->\nText', { status: 'open' })).toBe(true)
    // Another status is a change.
    expect(markerIsCurrent(block, { status: 'done', repo: 'alpha', pr: 133 })).toBe(false)
  })

  test('the block text matches what apply.py writes', () => {
    // The same literal sits in tests/test_apply.py.
    expect(markerFields({ status: 'in_review', repo: 'alpha', pr: 133, ref: 'backlog.md:273' })).toBe(
      'in review · PR alpha#133 · ref backlog.md:273',
    )
    expect(markerFields({ status: 'side_project' })).toBe('side project')
  })

  test('a new title is at most 70 characters, so the table shows all of it', () => {
    const long = 'A'.repeat(71)
    const { rows, dropped } = check([
      { action: 'create', title: long, bucket: 'backlog', assign: false },
      { action: 'create', title: 'B'.repeat(70), bucket: 'backlog', assign: false },
    ])
    expect(rows.map(r => r.title)).toEqual(['B'.repeat(70)])
    expect(dropped).toHaveLength(1)
  })

  test('assign only for a card in In Progress or moved there; no user id from a card title', () => {
    const more: Card[] = [
      ...cards,
      { id: 'E5', title: 'Backlog card', bucket: 'backlog', percent: 0, assigned: 'none', etag: 'W/"e"', details: { etag: 'W/"ed"', description: '', checklist: [] } },
      { id: 'F6', title: `Owner ${OTHER}`, bucket: 'backlog', percent: 0, assigned: 'none', etag: 'W/"f"', details: { etag: 'W/"fd"', description: '', checklist: [] } },
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
    )
    if (typeof checked === 'string') throw new Error(checked)
    expect(checked.rows.map(r => ('taskId' in r ? r.taskId : ''))).toEqual(['A1'])
    expect(checked.dropped).toHaveLength(2)

    const moved = checkProposal({ rows: [{ action: 'move', taskId: 'E5', bucket: 'in_progress' }, { action: 'assign', taskId: 'E5' }] }, more, prs, CFG)
    if (typeof moved === 'string') throw new Error(moved)
    expect(moved.rows.map(r => r.action)).toEqual(['move', 'assign'])
  })

  test('the reply may come fenced; anything else is unusable', () => {
    expect(extractJson('```json\n{"rows":[]}\n```')).toEqual({ rows: [] })
    expect(extractJson('Here: {"rows":[]} done')).toEqual({ rows: [] })
    expect(extractJson('no json')).toBeNull()
    expect(checkProposal(null, cards, prs, CFG)).toBe('Antwort ist kein Objekt mit "rows"')
  })

  test('statuses, repos and skipped cards follow the config', () => {
    const side: Card[] = [
      ...cards,
      { id: 'G7', title: 'Side: Tidy Notes', bucket: 'backlog', percent: 0, assigned: 'none', etag: 'W/"g"', details: { etag: 'W/"gd"', description: '', checklist: [] } },
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
    )
    if (typeof checked === 'string') throw new Error(checked)
    expect(checked.rows.map(r => r.action)).toEqual(['marker'])
    expect(checked.dropped).toHaveLength(3)
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

  test('naming the script passes; calling it, in any wrapping, stays blocked', () => {
    for (const command of [
      'grep -n confirm /u/tester/claude-mods/board/tests/test_apply.py',
      'grep -rn BUDGET ~/claude-mods/board/apply.py',
      'cat ~/claude-mods/board/apply.py',
      "sed -n '1,40p' ~/claude-mods/board/apply.py",
      'cd ~/claude-mods/board && python3 -m pytest tests/test_apply.py',
      'python3 -m pytest tests/',
      "cat > /tmp/notes.md <<'EOF'\npython3 ~/claude-mods/board/apply.py --rows 1\nEOF\nls",
      'cat <<-EOF > x.txt\n\tpython3 board/apply.py\n\tEOF',
      'cat <<A <<B\npython3 board/apply.py\nA\npython3 board/apply.py\nB\nls',
      'git commit -m "guard: python3 board/apply.py stays blocked"',
      "git commit -m 'fix(guard): mentions of board/apply.py pass'",
      'echo done # python3 board/apply.py',
      'python3 -c "print(1)"',
      'diff board/apply.py board-next/apply.py',
    ]) {
      expect([command, isApplyCall(command)]).toEqual([command, false])
    }
    for (const command of [
      'bash -c "python3 ~/claude-mods/board/apply.py --rows 1"',
      "sh -c 'cd ~/claude-mods/board && python3 apply.py'",
      'echo $(python3 board/apply.py --rows 1)',
      'echo `python3 board/apply.py`',
      'echo "result: $(python3 board/apply.py)"',
      '"/usr/bin/python3" "board/apply.py" --rows 1',
      'env A=1 python3 board/apply.py',
      'timeout 60 python3 apply.py --rows 1',
      'python3 -W ignore apply.py',
      './apply.py --rows 1',
      '~/claude-mods/board/apply.py --rows 1',
      'python3 < board/apply.py',
      'uv run apply.py',
      "cat <<'EOF'\nx\nEOF\npython3 board/apply.py",
      'cat <<A <<B\nx\nA\ny\nB\npython3 apply.py',
      'cat <<EOF\n$(python3 board/apply.py)\nEOF',
      'ls; python3 apply.py',
      'python3 "board/apply.py',
    ]) {
      expect([command, isApplyCall(command)]).toEqual([command, true])
    }
  })
})

// ---- the run through the engine ---------------------------------------------

describe('a board run', () => {
  test('the pill collects, asks, then runs apply.py with the shown file’s hash', async ($, on) => {
    const seen = world(on, { ask: 'ja außer 2' })
    await start($, false)

    const ui = await hintLine($, 120)
    expect(await ui.find({ type: 'Button', text: /▦ Board/ })).toBeDefined()
    await ui.press({ key: 'board' })
    await settled(seen)

    // Opus, medium, no tools, the rules as system prompt; the data inside <data>.
    const [sent] = seen.prompts
    expect(sent?.model).toBe('opus')
    expect(sent?.effort).toBe('medium')
    expect(sent?.maxTokens).toBe(16000)
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

    // The table: three rows kept, two dropped, no escape sequence.
    expect(seen.logs).toContain('Nr | Karte | Aktion | Beleg')
    expect(seen.logs.some(l => l.startsWith('1 | Write Parser Docs | mir zuweisen'))).toBe(true)
    expect(seen.logs.some(l => l.startsWith('3 | Fix Cache Race [2J | → Done'))).toBe(true)
    expect(seen.logs.filter(l => l.startsWith('Board: verworfen'))).toHaveLength(2)
    expect(seen.logs.join('\n')).not.toContain('\u001b')
    expect(seen.questions).toHaveLength(1)

    const file = `${DIR}/proposals-${stamped}.json`
    const shown = seen.files.get(file) ?? ''
    expect(applyRun(seen.runs)).toEqual([
      PYTHON,
      '-I',
      expect.stringMatching(/\/apply\.py$/),
      '--proposals',
      file,
      '--rows',
      '1,3',
      '--sha256',
      await sha256Hex(shown),
      '--report',
      `${DIR}/apply-${stamped}.jsonl`,
    ])
    expect(JSON.parse(shown).rows.map((r: { action: string }) => r.action)).toEqual(['assign', 'marker', 'move'])
    expect(seen.files.get(`${DIR}/last-run.md`)).toContain('Board: ausgeführt')
    expect(seen.store.lastRunAt).toBe(START)
    expect(seen.toasts).toContain('Board: 2 von 2 Zeilen ausgeführt.')
  })

  test('the yes writes a one-time confirmation with hash, rows and time before apply.py runs', async ($, on) => {
    const seen = world(on, { ask: 'ja außer 2' })
    await start($, false)
    await board($)
    await settled(seen)

    const argv = applyRun(seen.runs) ?? []
    expect(JSON.parse(seen.confirmAtApply ?? '{}')).toEqual({ sha256: argv[8], rows: [1, 3], at: START })
    expect(argv.slice(9)).toEqual(['--report', `${DIR}/apply-${stamped}.jsonl`])
  })

  test('apply.py killed at the timeout: the rows it reported are shown, the run is not stamped', async ($, on) => {
    const report = '{"n": 1, "result": "ok", "detail": ""}\n{"n": 2, "result": "skipped", "detail": "Karte seit dem Abgleich geändert"}\n'
    const seen = world(on, { apply: { reject: true, report } })
    await start($, false)
    await board($)
    await settled(seen)

    expect(seen.logs).toContain('Board: ABGEBROCHEN – apply.py ohne Abschlusszeile beendet')
    // Row 3 never reached the report: it may have been running at the kill.
    expect(seen.logs.some(l => l.startsWith('3 | ') && l.includes('unbekannt – auf dem Board prüfen'))).toBe(true)
    expect(seen.logs.some(l => l.startsWith('1 | Write Parser Docs – mir zuweisen | ok'))).toBe(true)
    expect(seen.logs.some(l => l.startsWith('2 | ') && l.includes('übersprungen'))).toBe(true)
    expect(seen.files.get(`${DIR}/last-run.md`)).toContain('ABGEBROCHEN')
    expect(seen.store.lastRunAt).toBeUndefined()
  })

  test('a run where every row failed is not stamped', async ($, on) => {
    const seen = world(on, { apply: { results: ['error', 'skipped', 'error'] } })
    await start($, false)
    await board($)
    await settled(seen)

    expect(applyRun(seen.runs)).toBeDefined()
    expect(seen.store.lastRunAt).toBeUndefined()
  })

  test('an empty board stops loudly before the model and stamps nothing', async ($, on) => {
    const seen = world(on, { tasks: [] })
    await start($, false)
    await board($)
    await settled(seen)

    expect(seen.prompts).toEqual([])
    expect(seen.logs.some(l => l.includes('keine Karten gelesen'))).toBe(true)
    expect(seen.store.lastRunAt).toBeUndefined()
  })

  test('unreadable cards are named, and an empty proposal then stamps nothing', async ($, on) => {
    const seen = world(on, { tasks: [...TASKS, { id: 'bad id', title: 'x', '@odata.etag': 'W/"z"' }], reply: '{"rows":[]}' })
    await start($, false)
    await board($)
    await settled(seen)

    expect(seen.logs).toContain('Board: Achtung – 1 Karte(n) unlesbar, nicht bewertet.')
    expect(seen.store.lastRunAt).toBeUndefined()
  })

  test('an unreadable status file stops before the model', async ($, on) => {
    const seen = world(on, { failStand: true })
    await start($, false)
    await board($)
    await settled(seen)

    expect(seen.prompts).toEqual([])
    expect(seen.logs.some(l => l.includes('bench.md'))).toBe(true)
  })

  for (const config of [null, '{', JSON.stringify({ ...CONFIG_FILE, planId: 'bad id' })]) {
    test(`a ${config === null ? 'missing' : 'broken'} config stops before anything is read`, async ($, on) => {
      const seen = world(on, { config })
      await start($, false)
      await board($)
      await settled(seen)

      expect(seen.runs).toEqual([['/usr/bin/rm', '-f', `${DIR}/confirm.json`]])
      expect(seen.prompts).toEqual([])
      expect(seen.logs.some(l => l.startsWith('Board: abgebrochen – Konfiguration'))).toBe(true)
    })
  }

  test('a subagent turn does not block the pill', async ($, on) => {
    const seen = world(on)
    await start($, false)
    await $.turn.start({ turnId: 'sub', prompt: 'x', agentId: 'a1' } as never)
    await board($)
    await settled(seen)

    expect(seen.prompts).toHaveLength(1)
  })

  test('a confirmation left from an earlier run is deleted before anything is read', async ($, on) => {
    const seen = world(on)
    await start($, false)
    await board($)
    await settled(seen)

    expect(seen.runs[0]).toEqual(['/usr/bin/rm', '-f', `${DIR}/confirm.json`])
  })

  test('/board runs the same path and its text carries no card contents', async ($, on) => {
    const seen = world(on)
    await start($, false)

    const text = await board($)
    await settled(seen)

    expect(text).toBe('Board-Abgleich gestartet – Tabelle und Rückfrage folgen.')
    expect(applyRun(seen.runs)?.[6]).toBe('1,2,3')
  })

  test('a deliberate „nein“ runs nothing but counts as a review', async ($, on) => {
    const seen = world(on, { ask: 'nein' })
    await start($, false)
    await board($)
    await settled(seen)

    expect(applyRun(seen.runs)).toBeUndefined()
    expect(seen.files.has(`${DIR}/confirm.json`)).toBe(false)
    expect(seen.store.lastRunAt).toBe(START)
  })

  for (const ask of ['dismiss', 'ja außer 9', 'mach alles'] as const) {
    test(`the answer „${ask}“ runs nothing and stamps nothing`, async ($, on) => {
      const seen = world(on, { ask })
      await start($, false)
      await board($)
      await settled(seen)

      expect(seen.questions).toHaveLength(1)
      expect(applyRun(seen.runs)).toBeUndefined()
      expect(seen.store.lastRunAt).toBeUndefined()
      expect(seen.files.has(`${DIR}/last-run.md`)).toBe(false)
    })
  }

  test('without a surface (-p) the run is a dry run: table, no question answered, no apply', async ($, on) => {
    const seen = world(on, { surfaces: [], ask: 'dismiss' })
    await start($, false)

    const text = await board($)

    expect(text).toBe('Board-Abgleich: 3 Vorschläge gezeigt, keine Antwort, nichts ausgeführt.')
    expect(text).not.toContain('Parser')
    expect(applyRun(seen.runs)).toBeUndefined()
    expect(seen.logs).toContain('Nr | Karte | Aktion | Beleg')
  })

  test('refused while Claude works, and while a run is underway', async ($, on) => {
    const seen = world(on)
    await start($, false)

    const busy = await hintLine($, 120, true)
    expect(await busy.find({ type: 'Button', text: /▦ Board/ })).toBeUndefined()
    await busy.unmount()

    await $.turn.start({ turnId: 't1', prompt: 'x' } as never)
    expect(await board($)).toBe('Board-Abgleich gestartet – Tabelle und Rückfrage folgen.')
    await seen.clock.settle()
    expect(seen.runs).toEqual([])
    expect(seen.toasts).toEqual(['Claude arbeitet gerade – Board-Abgleich nach der Antwort.'])
  })

  test('a failed az read stops before the model', async ($, on) => {
    const seen = world(on, { failAz: true })
    await start($, false)
    await board($)
    await settled(seen)

    expect(seen.prompts).toEqual([])
    expect(seen.logs.some(l => l.startsWith('Board: abgebrochen – az: AADSTS'))).toBe(true)
  })

  test('an empty proposal stamps the run without asking', async ($, on) => {
    const seen = world(on, { reply: '{"rows":[]}' })
    await start($, false)
    await board($)
    await settled(seen)

    expect(seen.questions).toEqual([])
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
