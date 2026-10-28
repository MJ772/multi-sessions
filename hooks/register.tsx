import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Clash, Peer, Status } from '../types'
import {
  BEAT_MS,
  HOST_ID,
  KEEP_WAITING_MS,
  age,
  clashes,
  isLive,
  isParked,
  label,
  lastQuestion,
  needsYou,
  nextPlan,
  parseParked,
  parsePeer,
  planSummary,
  summarizeInput,
  visible,
} from './logic'

type $ = EngineInterface

const ME_REF = { plugin: 'multi-sessions', key: 'me' } as const
const PEERS_REF = { plugin: 'multi-sessions', key: 'peers' } as const
const ME = atom(ME_REF, null)
const PEERS = atom(PEERS_REF, [])
const IS_OPEN = atom({ plugin: 'multi-sessions', key: 'isOpen' } as const, true)
const DISMISSED = atom({ plugin: 'multi-sessions', key: 'dismissed' } as const, [])
const PARKED_REF = { plugin: 'multi-sessions', key: 'parked' } as const
const PARKED = atom(PARKED_REF, {})
const IS_SHOWING_PARKED = atom({ plugin: 'multi-sessions', key: 'isShowingParked' } as const, false)
// Not a heartbeat: its name does not end in .json, so the tick never reads it as a session.
const PARKED_FILE = '_parked.txt'

const TICK_MS = 3_000
const MAX_ROWS = 8
const UUID = /^[0-9a-f-]{36}$/
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const STATE_TEXT: Record<Status, string> = {
  approval: 'needs approval',
  question: 'asks you',
  waiting: 'waiting on you',
  idle: 'done',
  working: 'working',
}

// Best effort: a failure here must never break the session it watches.
const safe = (work: Promise<unknown>) => work.catch(() => undefined)

async function folder($: $): Promise<string | undefined> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const root = config ?? (home === undefined ? undefined : `${home}/.claude`)

  return root === undefined ? undefined : `${root.replace(/\\/g, '/')}/multi-sessions`
}

// The desktop app keeps each session's sidebar title in a file of its own.
async function desktopTitle($: $): Promise<string | undefined> {
  const [appData, home, account, org, host] = await Promise.all([
    $.env.get('APPDATA'),
    $.env.get('HOME'),
    $.env.get('CLAUDE_CODE_ACCOUNT_UUID'),
    $.env.get('CLAUDE_CODE_ORGANIZATION_UUID'),
    $.env.get('CLAUDE_CODE_HOST_SESSION_ID'),
  ])
  const app = appData ? `${appData}/Claude` : home && `${home}/Library/Application Support/Claude`
  const isSafe = host && HOST_ID.test(host) && UUID.test(account ?? '') && UUID.test(org ?? '')
  if (!app || !isSafe) return undefined
  const text = await $.fs.read(`${app}/claude-code-sessions/${account}/${org}/${host}.json`)
  const title = (JSON.parse(text) as { title?: unknown }).title

  return typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : undefined
}

async function init($: $) {
  const [id, cwd, now, host, dir] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
    $.clock.now(),
    $.env.get('CLAUDE_CODE_HOST_SESSION_ID'),
    folder($),
  ])
  const hostId = host && HOST_ID.test(host) ? host : undefined
  // A restarted process (the desktop app re-waking it, a resume) picks up its own last heartbeat.
  const saved = dir === undefined ? undefined : parsePeer(await $.fs.read(`${dir}/${id}.json`).catch(() => ''))
  const resumed: Peer | undefined = saved && {
    ...saved,
    cwd,
    hostId,
    status: saved.status === 'working' ? 'idle' : saved.status,
    isEnded: undefined,
  }
  const fresh: Peer = { id, hostId, cwd, status: 'idle', plan: [], files: [], since: now, beat: now }
  await update($, ME, me => (me?.id === id ? { ...me, cwd, hostId } : saved?.id === id && resumed ? resumed : fresh))
  await refreshTitle($)
}

async function refreshTitle($: $) {
  const title = await desktopTitle($).catch(() => undefined)
  if (title !== undefined) await update($, ME, me => me && { ...me, title })
}

async function setStatus($: $, status: Status, need?: string) {
  const now = await $.clock.now()
  await update($, ME, me =>
    me === null || (me.status === status && me.need === need) ? me : { ...me, status, need, since: now },
  )
}

async function openSession($: $, hostId: string) {
  if (!HOST_ID.test(hostId)) return
  const url = `claude://claude.ai/epitaxy/${hostId}`
  const argv = (await $.env.get('OS')) === 'Windows_NT' ? ['explorer.exe', url] : ['open', url]
  await $.process.run(argv).catch(() => $.ui.toast('multi-sessions: could not open that session'))
}

// Puts a session away from every band, or brings it back. The person presses this, so two
// sessions writing the list in the same instant is not a case worth a lock.
async function setParked($: $, id: string, isAway: boolean) {
  const dir = await folder($)
  if (dir === undefined) return
  const now = await $.clock.now()
  const { [id]: _, ...rest } = parseParked(await $.fs.read(`${dir}/${PARKED_FILE}`).catch(() => ''))
  const parked = isAway ? { ...rest, [id]: now } : rest
  await $.fs.write(`${dir}/${PARKED_FILE}`, JSON.stringify(parked))
  await $.state.set(PARKED_REF, parked)
}

async function askToPause($: $, target: Peer, clash: Clash, sender: Peer | undefined) {
  const from = sender ? `the session "${label(sender)}"` : 'another session'
  const why =
    clash.kind === 'task'
      ? `you and ${from} look like you are doing the same task`
      : `you and ${from} ${clash.detail}`
  const sent = await $.session
    .send({
      to: { sessionId: target.id },
      text:
        `[multi-sessions] The person pressed "Pause" because ${why}. ` +
        'Stop before your next edit, and ask the person how to split the work before going on.',
    })
    .catch((error: unknown) => ({ isDelivered: false as const, reason: String(error) }))
  $.ui.toast(
    sent.isDelivered
      ? `Asked "${label(target)}" to pause`
      : `Could not reach "${label(target)}": ${sent.reason ?? 'not delivered'}`,
  )
}

// The module's own run: a hot reload starts it over, and $.state keeps the rest.
const run = {
  timer: undefined as { cancel: () => void } | undefined,
  isStarting: false,
  isTicking: false,
  isSeeded: false,
  writtenVersion: -1,
  beatAt: 0,
  signature: '',
  pendingAsk: undefined as string | undefined,
  // What holds the turn on the person: the call that asked, or the tool a permission prompt is for
  // ('*' when only a notification said so); only that call's end clears it.
  hold: undefined as { tool: string; agentId?: string; callId?: string } | undefined,
  // Whether the next turn starts from the person's own prompt, and the question an automatic
  // turn (a task notification, a continuation) must not wipe.
  isPersonTurn: false,
  heldNeed: undefined as string | undefined,
  // Each alert by when it last showed: one that flickers out for a tick is not raised twice.
  seen: new Map<string, number>(),
  // Each peer file's last good read, kept while another process is half way through writing it.
  cache: new Map<string, Peer>(),
}

// Publish this session's heartbeat, then read every session's.
async function tick($: $) {
  const dir = await folder($)
  if (dir === undefined) return
  const [now, id, cwd, dismissed] = await Promise.all([
    $.clock.now(),
    $.session.id(),
    $.session.cwd(),
    read($, DISMISSED),
  ])
  const before = await read($, ME)
  // A /clear goes on under a new session id with no session.start.
  if (before?.id !== id) await init($)
  else if (before.cwd !== cwd) await update($, ME, me => me && { ...me, cwd })
  const held = await $.state.get(ME_REF)
  const me = held.value ?? null
  if (me !== null && (held.version !== run.writtenVersion || now - run.beatAt >= BEAT_MS)) {
    await $.fs.write(`${dir}/${me.id}.json`, JSON.stringify({ ...me, beat: now }))
    run.writtenVersion = held.version
    run.beatAt = now
  }

  const entries = await $.fs.list(dir).catch(() => [])
  const names = entries
    .filter(f => f.kind === 'file' && f.name.endsWith('.json') && now - f.mtimeMs < KEEP_WAITING_MS)
    .map(f => f.name)
  const parsed = await Promise.all(
    names.map(async name => {
      const peer = parsePeer(await $.fs.read(`${dir}/${name}`).catch(() => '')) ?? run.cache.get(name)
      return [name, peer] as const
    }),
  )
  run.cache = new Map(parsed.filter((r): r is readonly [string, Peer] => r[1] !== undefined))
  const others = [...run.cache.values()].filter(p => p.id !== me?.id)
  const peers = visible(me === null ? others : [{ ...me, beat: now }, ...others], now)
  const parked = parseParked(await $.fs.read(`${dir}/${PARKED_FILE}`).catch(() => ''))
  if (JSON.stringify(parked) !== JSON.stringify(await read($, PARKED))) await $.state.set(PARKED_REF, parked)
  const active = peers.filter(p => !isParked(p, parked))

  // Redraw on a change, and once a minute so the ages move on.
  const signature = JSON.stringify([
    Math.floor(now / 60_000),
    peers.map(p => ({ ...p, beat: isLive(p, now) })),
  ])
  if (signature !== run.signature) {
    run.signature = signature
    await $.state.set(PEERS_REF, peers)
  }

  // A session put away raises nothing until it is back.
  const alerts = new Map<string, string>()
  for (const p of active) {
    if (p.id !== me?.id && needsYou(p)) {
      alerts.set(`need:${p.id}:${p.since}`, `"${label(p)}" ${STATE_TEXT[p.status]}${p.need ? `: ${p.need}` : ''}`)
    }
  }
  const byId = new Map(active.map(p => [p.id, p]))
  for (const c of clashes(active, now)) {
    const [a, b] = [byId.get(c.a), byId.get(c.b)]
    if (c.kind !== 'folder' && a && b && !dismissed.includes(c.key)) alerts.set(c.key, `Clash: "${label(a)}" and "${label(b)}" ${c.detail}`)
  }
  for (const [key, text] of alerts) {
    const last = run.seen.get(key)
    if (run.isSeeded && (last === undefined || now - last > 2 * 60_000)) $.ui.toast(text)
    run.seen.set(key, now)
  }
  for (const [key, at] of run.seen) if (now - at > 60 * 60_000) run.seen.delete(key)
  run.isSeeded = true
}

// Starts the heartbeat once, from whichever hook runs first: a mod loaded
// part way through a session hears no session.start.
async function start($: $) {
  if (run.timer !== undefined || run.isStarting) return
  run.isStarting = true
  try {
    // A person attends a session the desktop app hosts or a surface draws. The desktop attaches
    // its surface only while the session is on screen, so its entrypoint counts too. A `claude -p`
    // run from a session's Bash inherits that entrypoint, and is told apart by CHILD_SESSION.
    const [surfaces, entry, child] = await Promise.all([
      $.session.surfaces().catch(() => []),
      $.env.get('CLAUDE_CODE_ENTRYPOINT'),
      $.env.get('CLAUDE_CODE_CHILD_SESSION'),
    ])
    if (child === '1' || (surfaces.length === 0 && entry !== 'claude-desktop')) return
    await init($)
    run.timer = $.clock.every(TICK_MS, () => {
      if (run.isTicking) return
      run.isTicking = true
      void safe(tick($)).finally(() => (run.isTicking = false))
    })
  } finally {
    run.isStarting = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await safe(start($))

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    await safe(start($))
    const isFromPerson = e.isMeta !== true && e.origin.kind !== 'peer' && e.origin.kind !== 'task-notification'
    // A slash command or pasted markup is the person's too, but no task to show.
    const isPersons = isFromPerson && e.command === undefined && !e.text.trimStart().startsWith('<')
    // A prompt folded into a running turn starts none.
    if (e.turnId === undefined) run.isPersonTurn = isPersons
    if (isPersons) run.heldNeed = undefined
    const result = await next(e)
    if (result.drop !== undefined || !isFromPerson) return result
    // What entered, after any hook masked it.
    const task = result.text.replace(/\s+/g, ' ').trim().slice(0, 300)
    const count = task.split(' ').length
    const promptedAt = await $.clock.now()
    await safe(
      update($, ME, me => {
        if (me === null) return me
        // "yes" or "go with the first one" answers the task; it does not replace it.
        const isNewTask =
          isPersons && count >= 3 && !(me.status === 'waiting' && count < 6 && me.task !== undefined)
        return isNewTask ? { ...me, task, firstAsk: me.firstAsk ?? task, promptedAt } : { ...me, promptedAt }
      }),
    )

    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await safe(start($))
    if (e.agentId === undefined) {
      const me = await read($, ME)
      if (!run.isPersonTurn && me?.status === 'waiting') run.heldNeed = me.need
      run.isPersonTurn = false
      run.pendingAsk = undefined
      run.hold = undefined
      await safe(setStatus($, 'working'))
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await safe(start($))
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const isMain = e.agentId === undefined
    if (isMain && (tool === 'TodoWrite' || tool.endsWith('__update_plan'))) {
      await safe(update($, ME, me => me && { ...me, plan: nextPlan(me.plan, input) }))
    }
    if (isMain && tool.endsWith('__wrap_up')) {
      run.pendingAsk = typeof input.ask === 'string' && input.ask.trim() ? input.ask.trim().slice(0, 160) : undefined
      const recap = typeof input.recap === 'string' ? input.recap.slice(0, 300) : undefined
      await safe(
        update($, ME, me => me && { ...me, recap, plan: me.plan.map(i => ({ ...i, status: 'completed' })) }),
      )
    }
    const questions = Array.isArray(input.questions) ? input.questions : []
    const asks =
      tool === 'AskUserQuestion'
        ? String(questions[0]?.question ?? 'answer a question').slice(0, 160)
        : tool === 'ExitPlanMode'
          ? 'approve the plan'
          : undefined
    if (isMain && asks) {
      run.hold = { tool, callId: e.tool_use_id }
      await safe(setStatus($, 'question', asks))
    }

    const result = await next(e)

    const path = input.file_path ?? input.notebook_path
    if (FILE_TOOLS.has(tool) && typeof path === 'string' && result.deny === undefined && result.isError !== true) {
      const now = await $.clock.now()
      await safe(
        update($, ME, me => me && { ...me, files: [...me.files.filter(f => f.path !== path), { path, at: now }].slice(-50) }),
      )
    }
    // The question or permission that held the turn is answered once its own call ran.
    const hold = run.hold
    const isHolder =
      hold !== undefined &&
      (hold.callId !== undefined
        ? hold.callId === e.tool_use_id
        : (hold.tool === '*' || hold.tool === tool) && hold.agentId === e.agentId)
    if (isHolder) {
      run.hold = undefined
      await safe(setStatus($, 'working'))
    }

    return result
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    // A question or a plan to approve is already shown as what it asks.
    if (e.tool_name === 'AskUserQuestion' || e.tool_name === 'ExitPlanMode') return next(e)
    const what = summarizeInput((e.tool_input ?? {}) as Record<string, unknown>)
    run.hold = { tool: e.tool_name, agentId: e.agent_id }
    await safe(setStatus($, 'approval', `approve ${e.tool_name}${what ? `: ${what}` : ''}`))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    const status = (await read($, ME))?.status
    // The PermissionRequest before it already said which tool, and for what.
    if (e.notification_type === 'permission_prompt' && status !== 'approval' && status !== 'question') {
      run.hold = { tool: '*' }
      await safe(setStatus($, 'approval', e.message.slice(0, 160)))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const ask = run.pendingAsk ?? (e.reason === 'answer' ? lastQuestion(e.answer) : undefined)
    const need =
      e.reason === 'error'
        ? 'stopped on an error'
        : e.reason === 'refusal'
          ? 'the model refused'
          : (ask ?? run.heldNeed)
    await safe(setStatus($, need === undefined ? 'idle' : 'waiting', need))
    run.pendingAsk = undefined
    run.heldNeed = undefined
    run.hold = undefined
    await safe(refreshTitle($))

    return result
  })

  on('session.end', async ($, e, next) => {
    const [dir, me, now] = await Promise.all([folder($), read($, ME), $.clock.now()])
    if (dir !== undefined && me?.id === e.sessionId) {
      // The desktop app ends an idle process ('other') that it can wake again: one still
      // waiting on the person stays listed, as asleep.
      const isEnded = e.reason !== 'other' || !needsYou(me)
      await safe($.fs.write(`${dir}/${me.id}.json`, JSON.stringify({ ...me, isEnded, beat: now })))
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const peers = await read($, PEERS)
    // One session alone has nothing to coordinate.
    if (e.props.hasSurvey || peers.length < 2) return next(e)
    const [me, isOpen, dismissed, now, parked, isShowingParked] = await Promise.all([
      read($, ME),
      read($, IS_OPEN),
      read($, DISMISSED),
      $.clock.now(),
      read($, PARKED),
      read($, IS_SHOWING_PARKED),
    ])
    const away = peers.filter(p => isParked(p, parked))
    const active = peers.filter(p => !isParked(p, parked))
    const found = clashes(active, now).filter(c => !dismissed.includes(c.key))
    const waiting = active.filter(needsYou).length
    const byId = new Map(active.map(p => [p.id, p]))
    const { Box, Text, Button } = $.ui.resolve(e)
    // The band is one slot the mods share: draw the other mods' bands first,
    // never in their place. Claude Code's own placeholder is never nested: the desktop drops a
    // band that nests it.
    const drawn = await (async () => next(e))().catch(() => null)
    const others = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const header = (
      <Box key="header" flexDirection="row" gap={1}>
        <Text bold>Sessions</Text>
        <Text dimColor>{`${active.length} live`}</Text>
        {waiting > 0 && <Text color="warning">{`· ${waiting} need you`}</Text>}
        {found.length > 0 && <Text color="error">{`· ${found.length} clash${found.length > 1 ? 'es' : ''}`}</Text>}
        {isOpen && away.length > 0 && (
          <Button
            key="parked"
            plain
            label={`${away.length} done for now`}
            onPress={() => update($, IS_SHOWING_PARKED, v => !v)}
          />
        )}
        <Button key="toggle" plain label={isOpen ? 'Hide' : 'Show'} onPress={() => update($, IS_OPEN, v => !v)} />
      </Box>
    )
    if (!isOpen) {
      return (
        <Box flexDirection="column">
          {others}
          {header}
        </Box>
      )
    }

    const clashRow = (c: Clash) => {
      const pair = [byId.get(c.a), byId.get(c.b)].filter((p): p is Peer => p !== undefined)
      const targets = pair.filter(p => p.id !== me?.id)
      const sender = pair.find(p => p.id === me?.id)

      return (
        <Box key={`clash:${c.key}`} flexDirection="row" gap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={c.kind === 'folder' ? 'warning' : 'error'} wrap="truncate-end">
              {`⚠ ${pair.map(label).join(' ↔ ')}: ${c.detail}`}
            </Text>
          </Box>
          {targets.map(t => (
            <Button
              key={`pause:${c.key}:${t.id}`}
              plain
              label={targets.length > 1 ? `Pause ${label(t).slice(0, 16)}` : 'Pause other'}
              onPress={() => askToPause($, t, c, sender)}
            />
          ))}
          <Button
            key={`dismiss:${c.key}`}
            plain
            label="Dismiss"
            onPress={() => update($, DISMISSED, d => [...d, c.key])}
          />
        </Box>
      )
    }

    const peerRow = (p: Peer) => {
      const isMe = p.id === me?.id
      const plan = planSummary(p.plan)
      const color = needsYou(p) ? 'warning' : p.status === 'working' ? 'claude' : 'success'
      const mark = needsYou(p) ? '!' : p.status === 'working' ? '●' : '✓'
      const asleep = isLive(p, now) ? '' : ' · asleep'
      const progress =
        plan && plan.done < plan.total ? `${plan.done}/${plan.total}${plan.current ? ` · ${plan.current}` : ''}` : undefined
      const detail = needsYou(p)
        ? p.need
        : p.status === 'working'
          ? (progress ?? p.task)
          : (p.recap ?? p.task)

      return (
        <Box key={`peer:${p.id}`} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={color}>{mark}</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold={needsYou(p)} wrap="truncate-end">
                {`${isMe ? '(this session) ' : ''}${label(p)}`}
              </Text>
            </Box>
            <Text color={color}>{`${STATE_TEXT[p.status]} ${age(now - p.since)}${asleep}`}</Text>
            {!isMe && p.hostId !== undefined && (
              <Button key={`open:${p.id}`} plain label="Open" onPress={() => openSession($, p.hostId ?? '')} />
            )}
            <Button
              key={`park:${p.id}`}
              plain
              label="Done for now"
              // Closes the list of sessions put away too, so this one leaves the band at once.
              onPress={() => setParked($, p.id, true).then(() => update($, IS_SHOWING_PARKED, () => false))}
            />
          </Box>
          {detail !== undefined && (
            <Text dimColor wrap="truncate-end">{`  ${detail}`}</Text>
          )}
        </Box>
      )
    }

    const awayRow = (p: Peer) => (
      <Box key={`away:${p.id}`} flexDirection="row" gap={1}>
        <Text dimColor>–</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {`${p.id === me?.id ? '(this session) ' : ''}${label(p)}`}
          </Text>
        </Box>
        <Text dimColor>{`${STATE_TEXT[p.status]} ${age(now - p.since)}`}</Text>
        <Button key={`unpark:${p.id}`} plain label="Bring back" onPress={() => setParked($, p.id, false)} />
      </Box>
    )

    return (
      <Box flexDirection="column">
        {others}
        {header}
        {found.map(clashRow)}
        {active.slice(0, MAX_ROWS).map(peerRow)}
        {active.length > MAX_ROWS && <Text dimColor>{`+${active.length - MAX_ROWS} more`}</Text>}
        {isShowingParked && away.map(awayRow)}
      </Box>
    )
  })
}
