import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentSpawnInput, AgentStatus, EngineInterface, Register, Timer, ToolCallInput } from 'claude-code'

import type { AgentStat, BoardView } from '../types'
import { diagram, fit } from './diagram'
import type { Node } from './diagram'
import { JEV_URL, MIN_CONFIDENCE, pick, question } from './route'
import type { Pick } from './route'

const PANE = 'agent-board'
const MAIN = 'main'
// The prompt-cache TTLs the transcripts show: 5 min in a subagent, 1 h on the main loop.
// ponytail: fixed, usage overage drops main to 5 min and the board then calls a cold cache warm
const COLD_MS = 5 * 60_000
const MAIN_COLD_MS = 60 * 60_000
const SOON_MS = 60_000
const LONG_WORDS = 100
const LAST_CALLS = 5
// The dock width the board asks for; a width the person drags wins.
const WIDTH = 46
const MODEL_W = 9
const RIGHT_W = 7
// The time lanes take a third of a row past its fixed columns; under 6 cells they show nothing.
const LANE_SHARE = 1 / 3
const LANE_MIN = 6
// 8 frames a second: the engine redraws a pane at most 10 times a second.
const FRAME_MS = 125
const FLASH_MS = 1000
const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
// The board's own dark palette, so it reads the same under any theme: each text color clears
// 4.5:1 on bg (the tests check it). Theme keys fail here: the dark theme's `subtle` is 2.3:1.
// Each bg channel stays under 26, so a 256-color terminal rounds bg to black, not navy.
export const PALETTE = { bg: '#141019', text: '#e6e1f2', muted: '#9d97b8', working: '#ffb055', done: '#8bd6a8', failed: '#ff8f9b', soon: '#f2d27a' } as const
const C = PALETTE
// The input fields that name what a tool call works on: the first one present wins.
const BRIEF_KEYS = ['description', 'file_path', 'command', 'pattern', 'url', 'query', 'skill']
const ENDED: AgentStatus[] = ['completed', 'failed', 'killed']
// Jev picks the model only for these types: a plugin's agent may set its own model in its definition.
const ROUTED = ['Explore', 'general-purpose']
// Past this the spawn goes on with the mod's own rule.
const JEV_TIMEOUT_MS = 3000

// $.state, so a save of this mod keeps the counts; a restart still forgets them.
const agents = atom({ plugin: 'agent-board', key: 'agents' } as const, {} as Record<string, AgentStat>)
const view = atom({ plugin: 'agent-board', key: 'view' } as const, { open: [], hideDone: false, still: false, cleared: [] } as BoardView)
let timer: Timer | undefined
let spin: Timer | undefined

type Kind = 'working' | 'idle' | 'done' | 'failed' | 'other'
// `wait`: how long the current tool call has run, while it runs.
type Look = { kind: Kind; glyph: string; color: string; right: string; note?: string; noteColor?: string; cache?: string; wait?: string }

const title = (count: number) => `Agents · ${count}`
const blank = (at: number): AgentStat => ({ tools: 0, fails: 0, last: [], at, isDone: false, tokens: 0, cached: 0, ms: 0 })
const kilo = (n: number) =>
  n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 999_500 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`
const minutes = (ms: number) => `${Math.ceil(ms / 60_000)}m`
const bar = (share: number) => {
  const n = Math.min(5, Math.max(0, Math.ceil(share * 5)))
  return '▰'.repeat(n) + '▱'.repeat(5 - n)
}

// One agent's run on the shared time axis [t0, t1], at least one cell so a quick run still shows.
function lane(from: number, to: number, t0: number, t1: number, w: number) {
  const cell = Math.max(1, t1 - t0) / w
  const a = Math.max(0, Math.min(w - 1, Math.floor((from - t0) / cell)))
  const b = Math.max(a, Math.min(w - 1, Math.ceil((to - t0) / cell) - 1))
  return ' '.repeat(a) + '━'.repeat(b - a + 1) + ' '.repeat(w - 1 - b)
}

function clock(ms: number) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function brief(e: ToolCallInput) {
  const input = e as unknown as Record<string, unknown>
  const value = BRIEF_KEYS.map(k => input[k]).find((v): v is string => typeof v === 'string' && v !== '')
  const line = value?.split('\n')[0]

  return line === undefined ? e.tool : `${e.tool}: ${line.startsWith('/') ? line.split('/').pop() : line}`
}

// Every write stamps the time, so the idle clock counts from the agent's last event.
// The blank fills the fields a record from an older save of this mod lacks.
async function touch($: EngineInterface, id: string, fn: (s: AgentStat, at: number) => Partial<AgentStat>) {
  const at = await $.clock.now()
  await update($, agents, all => {
    const s = { ...blank(at), ...all[id] }
    return { ...all, [id]: { ...s, at, ...fn(s, at) } }
  })
}

// The list entry of an agent, kept for its row once the engine drops its task.
async function entry($: EngineInterface, id: string) {
  const a = (await $.agent.list()).find(x => x.id === id)
  return a && { description: a.description, type: a.type, name: a.name, parentId: a.parentId }
}

// The engine drops an ended subagent's task a while after it returns: the kept entry holds its row,
// in spawn order, until `c` clears it. A cleared agent that runs again shows again.
function roster(list: AgentInfo[], stats: Record<string, AgentStat>, cleared: string[]): AgentInfo[] {
  const ids = new Set(list.map(a => a.id))
  const kept = Object.entries(stats).flatMap(([id, s]): AgentInfo[] =>
    s.info === undefined || ids.has(id)
      ? []
      : [{ ...s.info, id, status: s.end !== undefined && s.end !== 'answer' ? 'failed' : s.isDone ? 'completed' : 'killed' }],
  )
  const rank = new Map(Object.keys(stats).map((id, i) => [id, i]))
  const at = (id: string) => rank.get(id) ?? rank.size

  return [...list, ...kept].filter(a => !(cleared.includes(a.id) && ENDED.includes(a.status))).sort((a, b) => at(a.id) - at(b.id))
}

// OPENROUTER_API_KEY from the environment, else from a .env in the session's directory.
async function jevKey($: EngineInterface) {
  const env = await $.env.get('OPENROUTER_API_KEY').catch(() => undefined)
  if (env) {
    return env
  }
  const file = await $.fs.read('.env').catch(() => '')
  return typeof file === 'string' ? file.match(/^OPENROUTER_API_KEY=["']?([^"'\s]+)/m)?.[1] : undefined
}

// Jev's tier for a spawn, or the reason the mod's own rule decides instead.
async function route($: EngineInterface, e: AgentSpawnInput): Promise<Pick | string> {
  const key = await jevKey($)
  if (key === undefined) {
    return 'no key'
  }
  const ask = $.http.fetch(JEV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(question(e)),
  })
  const res = await Promise.race([ask, $.clock.sleep(JEV_TIMEOUT_MS).then(() => undefined)])
  if (res === undefined) {
    return 'timeout'
  }
  if (!res.ok) {
    return `http ${res.status}`
  }
  const p = pick(res.text)
  if (p === undefined) {
    return 'bad answer'
  }

  return p.confidence < MIN_CONFIDENCE ? `${p.tier} at ${p.confidence.toFixed(2)}, low` : p
}

async function refresh($: EngineInterface) {
  const isRunning = (await $.agent.list()).some(a => a.status === 'running')
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (!isRunning && !isOpen) {
    timer?.cancel()
    timer = undefined
    return
  }
  if (isOpen) {
    await show($)
  }
  $.ui.invalidate('ui.render')
}

function watch($: EngineInterface) {
  timer ??= $.clock.every(10_000, () => void refresh($))
}

// The open board moves while a spinner turns or a flash shows; motion off, it never does.
async function isMoving($: EngineInterface) {
  const { value: v } = await $.state.get({ plugin: 'agent-board', key: 'view' })
  if (v?.still === true || !(await $.ui.panes()).some(p => p.id === PANE)) {
    return false
  }
  const { value: all = {} } = await $.state.get({ plugin: 'agent-board', key: 'agents' })
  const now = await $.clock.now()
  const isFlashing = Object.values(all).some(s => s.flashAt !== undefined && now - s.flashAt < FLASH_MS)
  const isBusy = all[MAIN]?.isDone === false || (await $.agent.list()).some(a => a.status === 'running' && all[a.id]?.isDone !== true)

  return isFlashing || isBusy
}

// Redraws 8 times a second, and stops itself once nothing moves: an idle board costs nothing.
async function tick($: EngineInterface) {
  if (!(await isMoving($))) {
    spin?.cancel()
    spin = undefined
  }
  $.ui.invalidate('ui.render')
}

function animate($: EngineInterface) {
  spin ??= $.clock.every(FRAME_MS, () => void tick($))
}

// Each open sets closeOnEscape and the asked width anew, so the refresh opens with them too.
async function show($: EngineInterface) {
  const { value: stats = {} } = await $.state.get({ plugin: 'agent-board', key: 'agents' })
  const { value: v } = await $.state.get({ plugin: 'agent-board', key: 'view' })
  const count = roster(await $.agent.list(), stats, v?.cleared ?? []).length
  await $.ui.open({ id: PANE, title: title(count), closeOnEscape: true, columns: WIDTH })
}

async function open($: EngineInterface) {
  await show($)
  watch($)
  animate($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: 'Show the agent tree of this session in a pane' })

    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    await open($)

    return { text: 'Agent board opened.' }
  })

  // A spawn that names no model: Jev picks it, else Explore gets haiku and the rest inherit.
  on('agent.spawn', async ($, e, next) => {
    const jev = e.model === undefined && ROUTED.includes(e.subagentType) ? await route($, e).catch(err => `error ${String(err)}`) : undefined
    const set = typeof jev === 'object' ? jev.tier : e.subagentType === 'Explore' && e.model === undefined ? 'haiku' : undefined
    const why =
      typeof jev === 'object' ? `jev ${jev.tier} at ${jev.confidence.toFixed(2)}` : jev === undefined ? undefined : `${set ?? 'inherit'}, jev: ${jev}`
    const ran = await next(set === undefined ? e : { ...e, model: set })
    if (ran.deny === undefined && ran.agentId !== undefined) {
      const { model, agentId } = ran
      const info = await entry($, agentId)
      await touch($, agentId, (s, at) => ({ model, isStar: set !== undefined, route: why, isDone: false, since: at, start: s.start ?? at, info: info ?? s.info }))
      watch($)
      animate($)
    }

    return ran
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const call = { id: e.tool_use_id, label: brief(e) }
    // A teammate's later turn raises no turn.start: its first tool call starts the clock.
    await touch($, id, (s, at) => ({
      tools: s.tools + 1,
      tool: call.label,
      last: [...s.last, { ...call, at }].slice(-LAST_CALLS),
      isDone: false,
      since: s.since ?? at,
      start: s.start ?? at,
    }))
    animate($)
    const ran = await next(e)
    const isFail = ran.deny !== undefined || ran.isError === true
    // The return stops the call's clock; a failed one also counts and flashes.
    await touch($, id, (s, at) => ({
      last: s.last.map(c => (c.id === call.id ? { ...c, end: at, ...(isFail ? { isError: true } : {}) } : c)),
      ...(isFail ? { fails: s.fails + 1, flashAt: at } : {}),
    }))
    if (isFail) {
      animate($)
    }

    return ran
  })

  // Only the main loop raises turn.start.
  on('turn.start', async ($, e, next) => {
    await touch($, MAIN, (_s, at) => ({ isDone: false, since: at, tool: undefined }))
    animate($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    const tokens = u === undefined ? 0 : u.input_tokens + u.output_tokens + u.cache_creation_input_tokens
    const cached = u?.cache_read_input_tokens ?? 0
    const answer = e.answer.trim()
    const isSub = e.agentId !== undefined
    const info = e.agentId === undefined ? undefined : await entry($, e.agentId)
    await touch($, e.agentId ?? MAIN, (s, at) => ({
      isDone: true,
      tokens: s.tokens + tokens,
      cached: s.cached + cached,
      ms: s.ms + e.durationMs,
      since: undefined,
      tool: undefined,
      end: e.reason,
      // A subagent's return flashes its row and keeps its report's length.
      ...(isSub ? { flashAt: at, report: answer === '' ? 0 : answer.split(/\s+/).length, info: info ?? s.info } : {}),
    }))
    if (isSub) {
      animate($)
    }

    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const n = (await $.agent.list()).filter(a => a.status === 'running').length
    if (n === 0) {
      return next(e)
    }

    // The suffix replaces the engine's ellipsis, so the engine still draws its own spinner.
    return next({ ...e, props: { ...e.props, suffix: ` · ${n} agent${n === 1 ? '' : 's'} running…` } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const stats = await read($, agents)
    const v = await read($, view)
    const list = roster(await $.agent.list(), stats, v.cleared ?? [])
    const width = e.props.bodyColumns || WIDTH
    const stat = (id: string) => ({ ...blank(now), ...stats[id] })
    const ids = new Set(list.map(a => a.id))
    // An agent whose parent left the list hangs under main.
    const kids = (parent?: string) => list.filter(a => (a.parentId !== undefined && ids.has(a.parentId) ? a.parentId : undefined) === parent)

    const look = (status: string, s: AgentStat, coldMs: number): Look => {
      // A teammate that waits for a message is `idle`: live, not failed.
      const isLive = status === 'running' || status === 'idle'
      const isIdle = status === 'idle' || (status === 'running' && s.isDone)
      const end = s.end !== undefined && s.end !== 'answer' ? s.end : undefined
      const ms = s.ms + (status === 'running' && !isIdle && s.since !== undefined ? now - s.since : 0)
      const time = ms > 0 ? clock(ms) : ''
      const left = coldMs - (now - s.at)
      if (status === 'failed' || status === 'killed' || (end !== undefined && !isLive)) {
        return { kind: 'failed', glyph: '✗', color: C.failed, right: end ?? status }
      }
      if (status === 'completed') {
        return { kind: 'done', glyph: '✓', color: C.done, right: time }
      }
      if (status === 'running' && !isIdle) {
        const glyph = v.still ? '●' : (FRAMES[Math.floor(now / FRAME_MS) % FRAMES.length] ?? '●')
        const call = s.last.at(-1)
        const wait = s.tool !== undefined && call?.at !== undefined && call.end === undefined ? clock(now - call.at) : undefined
        return { kind: 'working', glyph, color: C.working, right: time, note: s.tool, cache: 'warm', wait }
      }
      if (isIdle) {
        const color = left < SOON_MS ? C.soon : C.muted
        const note = left <= 0 ? 'idle · cache cold' : `idle · cache ${minutes(left)} left`
        return { kind: 'idle', glyph: '○', color, right: time, note, noteColor: color, cache: left <= 0 ? `${bar(0)} cold` : `${bar(left / coldMs)} ${minutes(left)} left` }
      }
      return { kind: 'other', glyph: '·', color: C.muted, right: status }
    }

    const looks = new Map(list.map(a => [a.id, look(a.status, stat(a.id), COLD_MS)]))
    // A returned agent with no live agent under it: `h` hides it, `c` clears it.
    const isDoneTree = (a: AgentInfo): boolean => looks.get(a.id)?.kind === 'done' && kids(a.id).every(isDoneTree)
    const isHidden = (a: AgentInfo) => v.hideDone && isDoneTree(a)
    // The lanes' time axis: from the first shown start to now, or to the last end once nothing works.
    const spans = new Map(
      list.flatMap(a => {
        const s = stats[a.id]
        const l = looks.get(a.id)
        return s?.start === undefined || l === undefined || isHidden(a) ? [] : [[a.id, [s.start, l.kind === 'working' ? now : s.at]] as const]
      }),
    )
    const t0 = Math.min(...[...spans.values()].map(r => r[0]))
    const t1 = Math.max(...[...spans.values()].map(r => r[1]))
    const share = Math.floor((width - 3 - MODEL_W - 1 - RIGHT_W) * LANE_SHARE)
    const laneW = share >= LANE_MIN ? share : 0
    const clear = () =>
      void update($, view, w => ({ ...w, cleared: [...(w.cleared ?? []), ...list.filter(isDoneTree).map(a => a.id)] })).then(() => show($))
    const toggle = (id: string) => () =>
      void update($, view, w => ({ ...w, open: w.open.includes(id) ? w.open.filter(x => x !== id) : [...w.open, id] }))

    // Text keeps no key, so each keyed piece sits in a Box of its own.
    // An agent's rows: the line itself, its current tool or idle note, and its details when expanded.
    // `pad` draws the tree in front of the line, `cont` the tree in front of the lines under it.
    const rows = (id: string, name: string, pad: string, cont: string, s: AgentStat, l: Look) => {
      const isFlash = !v.still && s.flashAt !== undefined && now - s.flashAt < FLASH_MS
      const model = `${s.model?.replace(/^claude-/, '') ?? ''}${s.isStar === true ? '*' : ''}`
      const nameW = Math.max(4, width - pad.length - 3 - MODEL_W - 1 - RIGHT_W - (laneW > 0 ? laneW + 1 : 0))
      const label = fit(name, nameW)
      const run = spans.get(id)
      const detail = (key: string, head: string, value: string, color: string = C.muted) => (
        <Box key={key}>
          <Text color={color} wrap="truncate-end">{`${cont}    ${head.padEnd(8)}${value}`}</Text>
        </Box>
      )
      const words = s.report

      return [
        <Box key={`row-${id}`} flexDirection="row">
          <Text color={C.muted}>{pad}</Text>
          <Box key={`glyph-${id}`}>
            <Text color={l.color} inverse={isFlash} bold={isFlash}>{l.glyph}</Text>
          </Box>
          <Text> </Text>
          <Button key={`open-${id}`} plain label={label} onPress={toggle(id)}>
            <Text color={l.color}>{label}</Text>
          </Button>
          <Text color={C.muted}>{`${' '.repeat(nameW - label.length + 1)}${fit(model, MODEL_W).padEnd(MODEL_W)} `}</Text>
          {laneW > 0 && (
            <Box key={`lane-${id}`}>
              <Text color={l.color}>{run === undefined ? ' '.repeat(laneW) : lane(run[0], run[1], t0, t1, laneW)}</Text>
            </Box>
          )}
          {laneW > 0 && <Text> </Text>}
          <Box key={`right-${id}`}>
            <Text color={l.color} inverse={isFlash}>
              {fit(l.right, RIGHT_W).padStart(RIGHT_W)}
            </Text>
          </Box>
        </Box>,
        l.note !== undefined && (
          <Box key={`now-${id}`}>
            <Text color={l.noteColor ?? C.muted} wrap="truncate-end">
              {/* The clock goes last, so the tool's name gives way to it. */}
              {`${cont}  └ ${l.wait === undefined ? l.note : `${fit(l.note, width - cont.length - 7 - l.wait.length)} · ${l.wait}`}`}
            </Text>
          </Box>
        ),
        v.open.includes(id) && (
          <Box key={`detail-${id}`} flexDirection="column">
            {s.route !== undefined && detail(`route-${id}`, 'model', s.route)}
            {detail(`tokens-${id}`, 'tokens', s.tokens + s.cached > 0 ? `${kilo(s.tokens)} + ${kilo(s.cached)} cached` : '—')}
            {detail(`tools-${id}`, 'tools', `${s.tools}${s.fails > 0 ? `  ✗${s.fails}` : ''}`, s.fails > 0 ? C.failed : undefined)}
            {l.cache !== undefined && detail(`cache-${id}`, 'cache', l.cache, l.noteColor)}
            {words !== undefined &&
              detail(`report-${id}`, 'report', words === 0 ? 'none' : `${words} words${words > LONG_WORDS ? ' · long' : ''}`)}
            {s.last.map((c, i) => detail(`last-${id}-${i}`, i === 0 ? 'last' : '', `${c.label}${c.isError === true ? '  ✗' : ''}`, c.isError === true ? C.failed : undefined))}
          </Box>
        ),
      ]
    }

    const main = { ...blank(now), isDone: true, ...stats[MAIN], model: await $.session.model() }
    const mainLook = look('running', main, MAIN_COLD_MS)
    const out = rows(MAIN, MAIN, '', '', main, mainLook)
    const walk = (parent: string | undefined, pad: string) => {
      const shown = kids(parent).filter(a => !isHidden(a))
      shown.forEach((a, i) => {
        const isLast = i === shown.length - 1
        const cont = `${pad}${isLast ? '  ' : '│ '}`
        out.push(...rows(a.id, a.name ?? a.description, `${pad}${isLast ? '└ ' : '├ '}`, cont, stat(a.id), looks.get(a.id) ?? look(a.status, stat(a.id), COLD_MS)))
        walk(a.id, cont)
      })
    }
    walk(undefined, '')

    // The diagram view: the same tree as boxes, its lines pulsing toward the working agents.
    const node = (a: AgentInfo): Node => {
      const l = looks.get(a.id) ?? look(a.status, stat(a.id), COLD_MS)
      const under = kids(a.id).filter(k => !isHidden(k))
      return { label: a.name ?? a.description, glyph: l.glyph, color: l.color, isLive: l.kind === 'working', kids: under.map(node) }
    }
    const top = kids(undefined).filter(a => !isHidden(a))
    const root: Node = { label: MAIN, glyph: mainLook.glyph, color: mainLook.color, isLive: false, kids: top.map(node) }
    const dg = v.diagram === true ? diagram(root, width, v.still ? undefined : Math.floor(now / FRAME_MS), C.muted, C.working) : undefined

    const counts = (['working', 'idle', 'failed', 'done'] as const)
      .map(kind => ({ kind, n: [...looks.values()].filter(l => l.kind === kind).length }))
      .filter(c => c.n > 0)
    const color = { working: C.working, idle: C.muted, failed: C.failed, done: C.done }
    const isStarred = list.some(a => stats[a.id]?.isStar === true)

    // Docked, the color fills the whole body; inline, the frame fits the tree.
    return (
      <Box flexDirection="column" backgroundColor={C.bg} minHeight={e.props.placement === 'dock' ? e.props.scroll.bodyRows : undefined}>
        <Box key="summary" flexDirection="row">
          {counts.length === 0 && <Text color={C.muted}>no subagents yet</Text>}
          {counts.map((c, i) => (
            <Text key={`count-${c.kind}`} color={color[c.kind]}>{`${i > 0 ? ' · ' : ''}${c.n} ${c.kind}`}</Text>
          ))}
        </Box>
        {dg === undefined ? (
          out
        ) : (
          <Box key="diagram" flexDirection="column">
            {dg.rows.map((runs, y) => (
              <Box key={`dg-${y}`} flexDirection="row">
                {runs.map((r, i) => (
                  <Box key={`dg-${y}-${i}`}>
                    <Text color={r.color}>{r.text}</Text>
                  </Box>
                ))}
              </Box>
            ))}
            {dg.isCut && (
              <Box key="dg-cut">
                <Text color={C.muted}>wider than the pane: drag it wider</Text>
              </Box>
            )}
          </Box>
        )}
        {dg === undefined && isStarred && (
          <Box key="footnote">
            <Text color={C.muted}>* model set by mod: click the row for why</Text>
          </Box>
        )}
        <Box key="footer" flexDirection="column">
          <Box key="keys" flexDirection="row">
            <Button key="hide" plain hotkey="h" onPress={() => void update($, view, w => ({ ...w, hideDone: !w.hideDone }))}>
              <Text color={C.text}>{v.hideDone ? 'show done' : 'hide done'}</Text>
            </Button>
            <Text>  </Text>
            <Button key="clear" plain hotkey="c" onPress={clear}>
              <Text color={C.text}>clear done</Text>
            </Button>
            <Text>  </Text>
            <Button key="view" plain hotkey="v" onPress={() => void update($, view, w => ({ ...w, diagram: w.diagram !== true }))}>
              <Text color={C.text}>{v.diagram === true ? 'lanes' : 'diagram'}</Text>
            </Button>
          </Box>
          <Box key="keys2" flexDirection="row">
            <Button
              key="motion"
              plain
              hotkey="m"
              onPress={() => void update($, view, w => ({ ...w, still: !w.still })).then(() => animate($))}
            >
              <Text color={C.text}>{v.still ? 'motion on' : 'motion off'}</Text>
            </Button>
            <Text>  </Text>
            {/* The relay mod answers /relay now: a handoff at the next breakpoint, /clear, continue. */}
            <Button
              key="handoff"
              plain
              hotkey="r"
              onPress={() => void $.command.run({ command: 'relay', args: 'now' }).catch(err => $.ui.toast(`handoff: ${String(err)}`))}
            >
              <Text color={C.text}>handoff</Text>
            </Button>
            <Text color={C.muted}>  esc close</Text>
          </Box>
        </Box>
      </Box>
    )
  })
}
