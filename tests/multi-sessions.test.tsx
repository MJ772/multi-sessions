import { expect, mock, test } from 'claude-code/testing'

import type { Peer } from '../types'
import { clashes, isSameTask, nextPlan, parsePeer, planSummary, visible } from '../hooks/logic'

const NOW = 1_800_000_000_000
const HOST_B = 'local_11111111-2222-3333-4444-555555555555'
const DIR = 'C:/Users/T/.claude/multi-sessions'
// The engine hands a Windows path to the fs hooks with backslashes.
const slash = (path: string) => path.replace(/\\/g, '/')

const peer = (over: Partial<Peer>): Peer => ({
  id: 'x',
  cwd: 'C:/repo',
  status: 'working',
  plan: [],
  files: [],
  since: NOW,
  beat: NOW,
  ...over,
})

const BAND = {
  plugin: 'multi-sessions',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 29 },
    view: {},
  },
} as const

test('the plan follows update_plan steps and TodoWrite lists', async () => {
  const items = [
    { content: 'one', status: 'in_progress' },
    { content: 'two', status: 'pending' },
    { content: 'three', status: 'pending' },
  ]
  const whole = nextPlan([], { items })
  expect(planSummary(whole)).toEqual({ done: 0, total: 3, current: 'one' })

  const advanced = nextPlan(whole, { advance: true })
  expect(planSummary(advanced)).toEqual({ done: 1, total: 3, current: 'two' })

  const jumped = nextPlan(advanced, { done: [2], start: 3 })
  expect(planSummary(jumped)).toEqual({ done: 2, total: 3, current: 'three' })

  const todos = nextPlan(jumped, { todos: [{ content: 'a', status: 'completed', activeForm: 'A' }] })
  expect(planSummary(todos)).toEqual({ done: 1, total: 1, current: undefined })
  expect(planSummary([])).toBeUndefined()
})

test('clashes: shared files across path spellings, same task, same checkout', async () => {
  const a = peer({ id: 'a', files: [{ path: 'C:\\Repo\\src\\Login.tsx', at: NOW - 1000 }] })
  const b = peer({ id: 'b', files: [{ path: 'c:/repo/src/login.tsx', at: NOW - 2000 }] })
  expect(clashes([a, b], NOW).map(c => c.kind)).toEqual(['files'])
  expect(clashes([a, b], NOW)[0]?.detail).toBe('both edited login.tsx')

  // An edit older than the hour no longer counts.
  const stale = peer({ id: 'b', files: [{ path: 'c:/repo/src/login.tsx', at: NOW - 2 * 3600_000 }] })
  expect(clashes([a, stale], NOW)).toEqual([])

  const c = peer({ id: 'c', files: [{ path: 'C:/repo/a.ts', at: NOW }] })
  const d = peer({ id: 'd', files: [{ path: 'C:/repo/b.ts', at: NOW }] })
  expect(clashes([c, d], NOW).map(x => x.kind)).toEqual(['folder'])
  expect(clashes([c, { ...d, status: 'idle' }], NOW)).toEqual([])

  const ledger = (id: string) =>
    peer({ id, status: 'idle', files: [{ path: 'C:/Users/T/notes/wiki/log.md', at: NOW }] })
  expect(clashes([ledger('l1'), ledger('l2')], NOW)).toEqual([])

  const g = peer({ id: 'g', firstAsk: 'build the weather widget for the dashboard', task: 'now make it blue' })
  const h = peer({ id: 'h', cwd: 'C:/other', firstAsk: 'build the dashboard weather widget', task: 'go' })
  expect(clashes([g, h], NOW).map(x => x.kind)).toEqual(['task'])
  expect(isSameTask('update C:/repo/src/a.ts and C:/repo/src/b.ts for login', 'fix C:/repo/src/a.ts tests')).toBe(false)

  const e = peer({ id: 'e', task: 'fix the login page crash when the user submits the form' })
  const f = peer({ id: 'f', cwd: 'C:/other', task: 'login page crash on form submit, fix it' })
  expect(clashes([e, f], NOW).map(x => x.kind)).toEqual(['task'])
  expect(isSameTask('fix the login page crash', 'write the quarterly sales report')).toBe(false)
  expect(isSameTask('yes', 'yes')).toBe(false)
})

test('a peer file is parsed as untrusted, and quiet sessions drop out', async () => {
  expect(parsePeer('not json')).toBeUndefined()
  expect(parsePeer(JSON.stringify({ id: '../../x', cwd: 'C:/', status: 'idle', since: 1, beat: 1 }))).toBeUndefined()
  expect(parsePeer(JSON.stringify({ id: 'a', cwd: 'C:/', status: 'hacked', since: 1, beat: 1 }))).toBeUndefined()
  const parsed = parsePeer(
    JSON.stringify({ id: 'a', cwd: 'C:/', status: 'idle', since: 1, beat: 1, hostId: 'local_bad', task: 'x'.repeat(900) }),
  )
  expect(parsed?.hostId).toBeUndefined()
  expect(parsed?.task?.length).toBe(300)

  const live = peer({ id: 'live' })
  const gone = peer({ id: 'gone', beat: NOW - 10 * 60_000 })
  const asleep = peer({ id: 'asleep', status: 'waiting', beat: NOW - 10 * 60_000, since: NOW - 20 * 60_000 })
  const ended = peer({ id: 'ended', isEnded: true })
  expect(visible([live, gone, asleep, ended], NOW).map(p => p.id)).toEqual(['asleep', 'live'])
})

test('the band lists sessions, flags the clash and resolves it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, {
    USERPROFILE: 'C:/Users/T',
    OS: 'Windows_NT',
    CLAUDE_CODE_HOST_SESSION_ID: 'local_aaaaaaaa-2222-3333-4444-555555555555',
  })
  const files = new Map<string, string>()
  files.set(
    `${DIR}/sess-b.json`,
    JSON.stringify(
      peer({
        id: 'sess-b',
        hostId: HOST_B,
        title: 'Fix login bug',
        status: 'approval',
        need: 'approve Bash: npm test',
        files: [{ path: 'C:\\repo\\src\\Login.tsx', at: NOW }],
        since: NOW - 120_000,
      }),
    ),
  )
  const ran: string[][] = []
  const sent: Array<{ to: string; text: string }> = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.id', () => ({ value: 'sess-a' }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('fs.write', (_, e) => {
    files.set(slash(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = files.get(slash(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.list', (_, e) => ({
    value: [...files.keys()]
      .filter(path => path.startsWith(`${slash(e.path)}/`))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: clock.now(), isLink: false })),
  }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.send', (_, e) => {
    sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  let shown: Peer[] = []
  on('state.set', { key: 'peers' }, (_, e, next) => {
    shown = e.value as Peer[]
    return next(e)
  })
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: false })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/repo/src/login.tsx', old_string: 'a', new_string: 'b' })
  await clock.advance(3_000)

  expect(JSON.parse(files.get(`${DIR}/sess-a.json`) ?? '{}').files[0].path).toBe('C:/repo/src/login.tsx')

  expect(shown.map(p => p.id)).toEqual(['sess-b', 'sess-a'])

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /1 need you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Fix login bug ↔ .*both edited login\.tsx/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /needs approval 2m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /approve Bash: npm test/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'open:sess-b' })
  expect(ran).toEqual([['explorer.exe', `claude://claude.ai/epitaxy/${HOST_B}`]])

  await ui.press({ key: 'pause:files:sess-a|sess-b:c:/repo/src/login.tsx:sess-b' })
  expect(sent[0]?.to).toContain('sess-b')
  expect(sent[0]?.text).toContain('both edited login.tsx')

  await ui.press({ key: 'dismiss:files:sess-a|sess-b:c:/repo/src/login.tsx' })
  expect(await ui.find({ type: 'Text', text: /both edited/ })).toBeUndefined()

  await ui.press({ key: 'toggle' })
  expect(await ui.find({ type: 'Text', text: /approve Bash/ })).toBeUndefined()
  await ui.unmount()
})

test('a turn that ends on a question waits on the person', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/T' })
  const files = new Map<string, string>()
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.id', () => ({ value: 'sess-a' }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('fs.write', (_, e) => {
    files.set(slash(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: false })
  await $.turn.start({ text: 'build the thing', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Built it.', ask: 'Commit it now?' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Built it.', durationMs: 10, isAborted: false })
  await clock.advance(3_000)

  const me = JSON.parse(files.get(`${DIR}/sess-a.json`) ?? '{}') as Peer
  expect(me.status).toBe('waiting')
  expect(me.need).toBe('Commit it now?')
  expect(me.recap).toBe('Built it.')
})

test('a reply that ends on a question waits too; an interrupt does not', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/T' })
  const files = new Map<string, string>()
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.id', () => ({ value: 'sess-a' }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('fs.write', (_, e) => {
    files.set(slash(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const mine = () => JSON.parse(files.get(`${DIR}/sess-a.json`) ?? '{}') as Peer

  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: false })
  await $.turn.start({ text: 'look at it', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Found two.\nWhich one first?', durationMs: 5, isAborted: false })
  await clock.advance(3_000)
  expect(mine().status).toBe('waiting')
  expect(mine().need).toBe('Which one first?')

  await $.prompt.submit({ text: 'the first', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: 'the first', turnId: 't2' })
  await $.turn.complete({ turnId: 't2', reason: 'aborted', answer: 'Should I?', durationMs: 5, isAborted: true })
  await clock.advance(3_000)
  expect(mine().status).toBe('idle')
})

test('a question stays open while a subagent works, and closes when answered', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/T' })
  const files = new Map<string, string>()
  let answer: () => void = () => {}
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.id', () => ({ value: 'sess-a' }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('fs.write', (_, e) => {
    files.set(slash(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', (_, e) =>
    e.tool === 'AskUserQuestion'
      ? new Promise(resolve => (answer = () => resolve({ result: {} })))
      : { result: {} },
  )
  const mine = () => JSON.parse(files.get(`${DIR}/sess-a.json`) ?? '{}') as Peer

  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: false })
  await $.turn.start({ text: 'pick a db', turnId: 't1' })
  const asking = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Postgres or SQLite?', header: 'DB', options: [], multiSelect: false }],
  } as never)
  await clock.settle()
  await $.tool.call({ tool: 'Read', file_path: 'C:/repo/a.ts', agentId: 'sub-1' })
  await clock.advance(3_000)
  expect(mine().status).toBe('question')
  expect(mine().need).toBe('Postgres or SQLite?')

  answer()
  await asking
  await clock.advance(3_000)
  expect(mine().status).toBe('working')
})

test('a turn the person did not start keeps the question it left open', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/T' })
  const files = new Map<string, string>()
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.id', () => ({ value: 'sess-a' }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('fs.write', (_, e) => {
    files.set(slash(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const mine = () => JSON.parse(files.get(`${DIR}/sess-a.json`) ?? '{}') as Peer

  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: false })
  await $.turn.start({ text: 'ship it', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Ready.\nCommit it now?', durationMs: 5, isAborted: false })
  // A background task's notification starts a turn of its own.
  await $.turn.start({ text: '', turnId: 't2' })
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: 'The build passed.', durationMs: 5, isAborted: false })
  await clock.advance(3_000)
  expect(mine().status).toBe('waiting')
  expect(mine().need).toBe('Commit it now?')
})
