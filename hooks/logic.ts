import type { Clash, Peer, PlanItem, Status } from '../types'

export const BEAT_MS = 20_000
export const LIVE_MS = 75_000
// A session that went quiet while waiting on you stays listed this long.
export const KEEP_WAITING_MS = 12 * 60 * 60_000
const FILE_WINDOW_MS = 60 * 60_000
const FOLDER_WINDOW_MS = 10 * 60_000
const MAX_TEXT = 300
export const HOST_ID = /^local_[0-9a-f-]{36}$/
const STATUSES: readonly Status[] = ['working', 'approval', 'question', 'waiting', 'idle']
const RANK: Record<Status, number> = { approval: 0, question: 0, waiting: 1, idle: 2, working: 3 }

export const needsYou = (p: Peer) =>
  p.status === 'approval' || p.status === 'question' || p.status === 'waiting'

export const isLive = (p: Peer, now: number) => now - p.beat < LIVE_MS

// Live sessions, plus ones whose process went quiet while still waiting on you.
export function visible(peers: readonly Peer[], now: number): Peer[] {
  return peers
    .filter(p => !p.isEnded && (isLive(p, now) || (needsYou(p) && now - p.beat < KEEP_WAITING_MS)))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || a.since - b.since)
}

const clip = (text: unknown, max = MAX_TEXT) =>
  typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : undefined

// A peer file is written by this mod in other processes; read it as untrusted.
export function parsePeer(text: string): Peer | undefined {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const { id, cwd, status, since, beat } = raw
  const isValid =
    typeof id === 'string' && /^[\w-]{1,80}$/.test(id) &&
    typeof cwd === 'string' &&
    STATUSES.includes(status as Status) &&
    typeof since === 'number' && typeof beat === 'number'
  if (!isValid) return undefined
  const files = Array.isArray(raw.files) ? raw.files : []
  const plan = Array.isArray(raw.plan) ? raw.plan : []
  const hostId = typeof raw.hostId === 'string' && HOST_ID.test(raw.hostId) ? raw.hostId : undefined

  return {
    id,
    hostId,
    title: clip(raw.title, 120),
    cwd: cwd.slice(0, 1000),
    status: status as Status,
    need: clip(raw.need),
    firstAsk: clip(raw.firstAsk),
    task: clip(raw.task),
    recap: clip(raw.recap),
    plan: plan
      .filter((i): i is PlanItem => typeof i?.content === 'string' && typeof i?.status === 'string')
      .slice(0, 50)
      .map(i => ({ content: clip(i.content, 120) ?? '', status: i.status })),
    files: files
      .filter((f): f is Peer['files'][number] => typeof f?.path === 'string' && typeof f?.at === 'number')
      .slice(-50),
    since,
    beat,
    isEnded: raw.isEnded === true || undefined,
  }
}

export function label(p: Peer): string {
  if (p.title) return p.title
  const folder = p.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? p.cwd
  const topic = p.firstAsk ?? p.task

  return topic ? `${folder}: ${topic.slice(0, 50)}` : folder
}

// update_plan sends the whole list (`items`) or steps (`advance`, `done`, `start`);
// TodoWrite always sends the whole list (`todos`).
export function nextPlan(prev: readonly PlanItem[], input: Record<string, unknown>): PlanItem[] {
  const whole = input.todos ?? input.items
  if (Array.isArray(whole)) {
    return whole
      .filter(i => typeof i?.content === 'string')
      .map(i => ({ content: String(i.content), status: String(i.status ?? 'pending') }))
  }
  const items = prev.map(i => ({ ...i }))
  if (Array.isArray(input.done)) {
    for (const n of input.done) {
      const item = typeof n === 'number' ? items[n - 1] : undefined
      if (item) item.status = 'completed'
    }
  }
  if (input.advance === true) {
    const current = items.find(i => i.status === 'in_progress')
    if (current) current.status = 'completed'
    const next = items.find(i => i.status === 'pending')
    if (next) next.status = 'in_progress'
  }
  const start = typeof input.start === 'number' ? items[input.start - 1] : undefined
  if (start) start.status = 'in_progress'

  return items
}

export function planSummary(plan: readonly PlanItem[]) {
  if (plan.length === 0) return undefined
  const done = plan.filter(i => i.status === 'completed').length
  const current = plan.find(i => i.status === 'in_progress')?.content

  return { done, total: plan.length, current }
}

// Files every session edits by routine (a notes vault's session-start/end ledger, a project's
// auto memory): they would make every pair of sessions look like a clash.
const ROUTINE = [
  /\/wiki\/(index|log|hot|pending|skills-usage|skills-insights)\.md$/,
  /\/\.claude\/projects\/[^/]+\/memory\//,
]

const norm = (path: string) => {
  const slashed = path.replace(/\\/g, '/')
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed
}

const STOP = new Set(
  ('the and for with that this from into onto then than them they you your our are was were ' +
    'can could should would will have has had not but its it\'s also just please pls make sure ' +
    'all any each some what when where which who how why add use using get let set new want need ' +
    'there here about after before again more most other same such only own very').split(' '),
)

// Paths are left out: two different tasks in one project quote the same folders.
export function words(text: string | undefined): Set<string> {
  return new Set(
    (text ?? '')
      .toLowerCase()
      .replace(/\S*[\\/]\S*/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter(w => w.length >= 3 && !STOP.has(w)),
  )
}

// Two prompts are the same task when they share at least 3 meaningful words
// and those make up at least 55% of the words either uses.
export function isSameTask(a: string | undefined, b: string | undefined): boolean {
  const left = words(a)
  const right = words(b)
  const shared = [...left].filter(w => right.has(w)).length
  const union = left.size + right.size - shared

  return shared >= 3 && shared / union >= 0.55
}

const base = (path: string) => path.split('/').at(-1) ?? path

export function clashes(peers: readonly Peer[], now: number): Clash[] {
  const found: Clash[] = []
  for (const [i, a] of peers.entries()) {
    for (const b of peers.slice(i + 1)) {
      const pair = [a.id, b.id].sort().join('|')
      const recent = (p: Peer, window: number) =>
        new Set(
          p.files
            .filter(f => now - f.at < window)
            .map(f => norm(f.path))
            .filter(path => !ROUTINE.some(rule => rule.test(path))),
        )
      const aFiles = recent(a, FILE_WINDOW_MS)
      const shared = [...recent(b, FILE_WINDOW_MS)].filter(f => aFiles.has(f))
      if (shared.length > 0) {
        const names = shared.slice(0, 3).map(base).join(', ')
        const more = shared.length > 3 ? ` +${shared.length - 3}` : ''
        // Keyed by the files too: a dismissed clash comes back when another file is shared.
        found.push({ key: `files:${pair}:${shared.sort().join(',')}`, a: a.id, b: b.id, kind: 'files', detail: `both edited ${names}${more}` })
      } else if (
        a.status === 'working' && b.status === 'working' &&
        norm(a.cwd) === norm(b.cwd) &&
        recent(a, FOLDER_WINDOW_MS).size > 0 && recent(b, FOLDER_WINDOW_MS).size > 0
      ) {
        found.push({ key: `folder:${pair}`, a: a.id, b: b.id, kind: 'folder', detail: 'both editing the same checkout' })
      }
      if (isSameTask(a.task ?? a.title, b.task ?? b.title) || isSameTask(a.firstAsk, b.firstAsk)) {
        found.push({ key: `task:${pair}`, a: a.id, b: b.id, kind: 'task', detail: 'look like the same task' })
      }
    }
  }

  return found
}

export function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

// The last question the reply put to you, if it ended on one.
export function lastQuestion(text: string | undefined): string | undefined {
  const lines = (text ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  const last = lines.at(-1)

  return last?.endsWith('?') ? clip(last, 160) : undefined
}

export function summarizeInput(input: Record<string, unknown>): string {
  const first = input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.pattern
  return typeof first === 'string' ? first.replace(/\s+/g, ' ').slice(0, 80) : ''
}
