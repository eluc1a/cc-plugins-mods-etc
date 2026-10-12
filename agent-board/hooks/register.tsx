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
// A working agent with no tool call or return for this long turns its tool line yellow: it may be stuck.
// ponytail: one fixed limit, a long test run trips it too
const QUIET_MS = 3 * 60_000
const LONG_WORDS = 100
const LAST_CALLS = 5
// The dock width the board asks for; a width the person drags wins.
const WIDTH = 46
// The model and a star: `sonnet 5.5*`.
const MODEL_W = 11
const RIGHT_W = 7
// The engine draws a hotkey before its label (`1: `), outside the tree's text.
const KEY_W = 3
// A lane under 6 cells shows nothing.
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
// Each work lane's heading and card edges: purple, aqua, pink, blue, white, then again from purple. None is a status color.
export const LANE_COLORS = ['#c08cff', '#5ce1e6', '#ff79e0', '#6aa6ff', '#f2f2f2'] as const
// The input fields that name what a tool call works on: the first one present wins.
const BRIEF_KEYS = ['description', 'file_path', 'command', 'pattern', 'url', 'query', 'skill', 'to']
const ENDED: AgentStatus[] = ['completed', 'failed', 'killed']
// Jev picks the model only for these types: a plugin's agent may set its own model in its definition.
const ROUTED = ['Explore', 'general-purpose']
// Past this the spawn goes on with the mod's own rule.
const JEV_TIMEOUT_MS = 3000
// A work lane, from the start of an Agent description: `Lane 2: review the diff`.
const LANE = /^lane (\d+):\s*/i
// The rule that makes the model write that prefix, so the lanes need no CLAUDE.md on the machine.
export const LANE_RULE = {
  id: 'agent-board:lanes',
  text:
    'When you run work in parallel with subagents, start each Agent description with `Lane N: ` ' +
    '(for example `Lane 1: implement the parser`). Give a follow-up agent for the same work (review, fix) ' +
    'the same lane number. The agent board groups agents by this prefix.',
  scope: 'session',
} as const

// $.state, so a save of this mod keeps the counts; a restart still forgets them.
const agents = atom({ plugin: 'agent-board', key: 'agents' } as const, {} as Record<string, AgentStat>)
const view = atom({ plugin: 'agent-board', key: 'view' } as const, { open: [], hideDone: false, still: false, cleared: [] } as BoardView)
let timer: Timer | undefined
let spin: Timer | undefined
// The agents whose worktree the board looked for; a reload forgets them, and each costs one more look.
const looked = new Set<string>()

type Kind = 'working' | 'idle' | 'done' | 'failed' | 'other'
// `wait`: how long the current tool call has run, or how long ago the last one returned.
// `isQuiet`: working, with no tool call or return for QUIET_MS.
type Look = { kind: Kind; glyph: string; color: string; right: string; note?: string; noteColor?: string; cache?: string; wait?: string; isQuiet?: boolean }

const title = (count: number) => `Agents · ${count}`
const blank = (at: number): AgentStat => ({ tools: 0, fails: 0, last: [], at, isDone: false, tokens: 0, cached: 0, ms: 0 })
const kilo = (n: number) =>
  n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 999_500 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`
const minutes = (ms: number) => `${Math.ceil(ms / 60_000)}m`
// `sonnet 5.5` for `claude-sonnet-5-5`, `sonnet 4` for `claude-sonnet-4-20250514`; an alias (`haiku`) shows
// as it is. The full id shows in the details.
export function short(model?: string) {
  const m = model?.match(/(opus|sonnet|haiku|fable)(?:-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?)?/)
  if (m === null || m === undefined) {
    return model?.replace(/^claude-/, '') ?? ''
  }
  const version = [m[2], m[3]].filter(x => x !== undefined).join('.')
  return version === '' ? m[1]! : `${m[1]} ${version}`
}
const bar = (share: number) => {
  const n = Math.min(5, Math.max(0, Math.ceil(share * 5)))
  return '▰'.repeat(n) + '▱'.repeat(5 - n)
}

// One agent's run on the shared time axis [t0, t1], at least one cell so a quick run still shows.
function lane(from: number, to: number, t0: number, t1: number, w: number) {
  const cell = Math.max(1, t1 - t0) / w
  const a = Math.max(0, Math.min(w - 1, Math.floor((from - t0) / cell)))
  const b = Math.max(a, Math.min(w - 1, Math.ceil((to - t0) / cell) - 1))
  return ' '.repeat(a) + '▆'.repeat(b - a + 1) + ' '.repeat(w - 1 - b)
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

// The branch of an agent spawned to run in a directory other than the session's.
async function branchOf($: EngineInterface, cwd: string | undefined) {
  if (cwd === undefined || cwd === (await $.session.cwd())) {
    return undefined
  }
  const r = await $.process.run(['git', 'branch', '--show-current'], { cwd, timeoutMs: 2000 }).catch(() => undefined)
  return r?.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : undefined
}

// The branch of a worktree agent: the spawn gives no cwd for it, but its worktree is `agent-<id>`.
// ponytail: that name is what the engine made in a live test, not a documented contract
async function worktreeBranch($: EngineInterface, id: string) {
  const r = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd: await $.session.cwd(), timeoutMs: 2000 }).catch(() => undefined)
  // One block per worktree: `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>`.
  const block = r?.exitCode === 0 ? r.stdout.split('\n\n').find(b => b.split('\n')[0]?.endsWith(`/agent-${id}`)) : undefined
  return block?.match(/^branch refs\/heads\/(.+)$/m)?.[1]
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

  // Only where the model can spawn an agent.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return e.tools.includes('Agent') ? { sections: [...composed.sections, LANE_RULE] } : composed
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
      const branch = await branchOf($, e.cwd)
      await touch($, agentId, (s, at) => ({
        model,
        isStar: set !== undefined,
        route: why,
        isDone: false,
        since: at,
        start: s.start ?? at,
        info: info ?? s.info,
        branch: branch ?? s.branch,
      }))
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
    // By an agent's first tool call its worktree exists.
    if (e.agentId !== undefined && !looked.has(e.agentId)) {
      looked.add(e.agentId)
      const branch = await worktreeBranch($, e.agentId).catch(() => undefined)
      if (branch !== undefined) {
        await touch($, e.agentId, () => ({ branch }))
      }
    }
    const ran = await next(e)
    const isFail = ran.deny !== undefined || ran.isError === true
    const isToMain = !isFail && e.agentId !== undefined && e.tool === 'SendMessage' && e.to === MAIN
    // The return stops the call's clock; a failed one also counts and flashes.
    await touch($, id, (s, at) => ({
      last: s.last.map(c => (c.id === call.id ? { ...c, end: at, ...(isFail ? { isError: true } : {}) } : c)),
      ...(isFail ? { fails: s.fails + 1, flashAt: at } : {}),
      ...(isToMain ? { isToMain: true } : {}),
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
    const laneOf = (a: AgentInfo) => a.description.match(LANE)?.[1]
    // Lane 1 takes the first color, lane 6 the first again.
    const edgeOf = (a: AgentInfo) => {
      const n = laneOf(a)
      return n === undefined ? C.muted : LANE_COLORS[(Number(n) + LANE_COLORS.length - 1) % LANE_COLORS.length]!
    }
    // Siblings with each lane together: a lane shows where its first agent started, its agents in start order.
    const byLane = (sibs: AgentInfo[]) => {
      const rank = (a: AgentInfo) => sibs.findIndex(b => b === a || (laneOf(a) !== undefined && laneOf(b) === laneOf(a)))
      return [...sibs].sort((x, y) => rank(x) - rank(y))
    }
    // An agent whose parent left the list hangs under main.
    const kids = (parent?: string) => byLane(list.filter(a => (a.parentId !== undefined && ids.has(a.parentId) ? a.parentId : undefined) === parent))
    // An agent of main's drops its lane from its name: the lane's heading shows it.
    const label = (a: AgentInfo, isTop: boolean) => a.name ?? (isTop ? a.description.replace(LANE, '') : a.description)

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
        // s.tool is set by this turn's calls only: main's list keeps the calls of its earlier turns.
        const call = s.tool === undefined ? undefined : s.last.at(-1)
        const isCalling = call?.at !== undefined && call.end === undefined
        // Since the running call started, the last call returned, or else the turn started.
        const quiet = now - (isCalling ? call.at! : (call?.end ?? s.since ?? now))
        const wait = call === undefined ? undefined : isCalling ? clock(quiet) : `${clock(quiet)} ago`
        const isQuiet = quiet >= QUIET_MS
        const note = s.tool ?? (isQuiet ? `no tool call · ${clock(quiet)}` : undefined)
        return { kind: 'working', glyph, color: C.working, right: time, note, noteColor: isQuiet ? C.soon : undefined, cache: 'warm', wait, isQuiet }
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
    // Each agent of main's draws in a card; the agents it started sit inside, under tree lines.
    // The lanes all start in one column, past the model of the deepest agent shown.
    const inner = width - 4
    const top = kids(undefined).filter(a => !isHidden(a))
    const depth = (id: string, d: number): number => Math.max(d, ...kids(id).filter(a => !isHidden(a)).map(a => depth(a.id, d + 1)))
    const deepest = Math.max(0, ...top.map(a => depth(a.id, 0)))
    const laneX = (deepest === 0 ? 0 : 2 + 2 * deepest) + 2 + MODEL_W + 1
    const laneW = inner - laneX >= LANE_MIN ? inner - laneX : 0
    const clear = () =>
      void update($, view, w => ({ ...w, cleared: [...(w.cleared ?? []), ...list.filter(isDoneTree).map(a => a.id)] })).then(() => show($))
    const toggle = (id: string) => () =>
      void update($, view, w => ({ ...w, open: w.open.includes(id) ? w.open.filter(x => x !== id) : [...w.open, id] }))

    // Text keeps no key, so each keyed piece sits in a Box of its own.
    // The lines under an agent's name: its current tool or idle note, and its details when expanded.
    // In a card each line fills the card between its edges, in `edge`; main's lines have no edges.
    const under = (id: string, cont: string, s: AgentStat, l: Look, edge?: string) => {
      const isCard = edge !== undefined
      const w = isCard ? inner : width
      const cut = (t: string, n: number) => (isCard ? fit(t, n).padEnd(n) : fit(t, n))
      // Dim labels, bright values. `tail` goes last, so the value gives way to it; in a card it sits at the right edge.
      const detail = (key: string, head: string, value: string, color: string = C.text, tail = '') => {
        const lead = `${cont}    ${head.padEnd(8)}`
        return (
          <Box key={key} flexDirection="row">
            {isCard && <Text color={edge}>│ </Text>}
            <Text color={C.muted}>{lead}</Text>
            <Text color={color}>{`${cut(value, w - lead.length - tail.length)}${tail}`}</Text>
            {isCard && <Text color={edge}> │</Text>}
          </Box>
        )
      }
      const words = s.report

      return [
        l.note !== undefined && (
          <Box key={`now-${id}`} flexDirection="row">
            {isCard && <Text color={edge}>│ </Text>}
            <Text color={l.noteColor ?? C.muted}>
              {/* The clock goes last, so the tool's name gives way to it. */}
              {cut(`${cont}  └ ${l.wait === undefined ? l.note : `${fit(l.note, w - cont.length - 7 - l.wait.length)} · ${l.wait}`}`, w)}
            </Text>
            {isCard && <Text color={edge}> │</Text>}
          </Box>
        ),
        v.open.includes(id) && (
          <Box key={`detail-${id}`} flexDirection="column">
            {s.model !== undefined && detail(`model-${id}`, 'model', s.route === undefined ? s.model : `${s.model} · ${s.route}`)}
            {detail(`tokens-${id}`, 'tokens', s.tokens + s.cached > 0 ? `${kilo(s.tokens)} + ${kilo(s.cached)} cached` : '—')}
            {detail(`tools-${id}`, 'tools', `${s.tools}${s.fails > 0 ? `  ✗${s.fails}` : ''}`, s.fails > 0 ? C.failed : undefined)}
            {l.cache !== undefined && detail(`cache-${id}`, 'cache', l.cache, l.kind === 'idle' && l.noteColor === C.soon ? C.soon : undefined)}
            {s.start !== undefined && detail(`started-${id}`, 'started', `${clock(now - s.start)} ago`)}
            {words !== undefined &&
              detail(`report-${id}`, 'report', words === 0 ? 'none' : `${words} words${words > LONG_WORDS ? ' · long' : ''}`)}
            {s.last.map((c, i) => {
              const ago = c.at === undefined ? '' : `  ${clock(now - c.at)} ago`
              return detail(`last-${id}-${i}`, i === 0 ? 'last' : '', `${c.label}${c.isError === true ? '  ✗' : ''}`, c.isError === true ? C.failed : undefined, ago)
            })}
          </Box>
        ),
      ]
    }

    // An agent's lines in a card: glyph, name and time, then model and lane, then the lines under them.
    // `pad` draws the tree in front of the name, `cont` the tree in front of the lines under it.
    // A nested agent's ✉ shows on its name, yellow: it skipped its parent. A card's own ✉ is in its title.
    const rows = (a: AgentInfo, pad: string, cont: string, edge: string) => {
      const id = a.id
      const s = stat(id)
      const l = looks.get(id) ?? look(a.status, s, COLD_MS)
      const isFlash = !v.still && s.flashAt !== undefined && now - s.flashAt < FLASH_MS
      const mark = pad !== '' && s.isToMain === true ? '✉ ' : ''
      const nameW = Math.max(4, inner - pad.length - 2 - mark.length - 1 - RIGHT_W)
      const name = fit(label(a, pad === ''), nameW)
      const lead = fit(`${cont}  ${fit(`${short(s.model)}${s.isStar === true ? '*' : ''}`, MODEL_W)}`, inner)
      const run = spans.get(id)

      return [
        <Box key={`row-${id}`} flexDirection="row">
          <Text color={edge}>│ </Text>
          <Text color={C.muted}>{pad}</Text>
          <Box key={`glyph-${id}`}>
            <Text color={l.color} inverse={isFlash} bold={isFlash}>{l.glyph}</Text>
          </Box>
          <Text> </Text>
          <Button key={`open-${id}`} plain label={name} onPress={toggle(id)}>
            {mark !== '' && <Text color={C.soon}>{mark}</Text>}
            <Text color={l.color}>{name}</Text>
          </Button>
          <Text>{' '.repeat(nameW - name.length + 1)}</Text>
          <Box key={`right-${id}`}>
            <Text color={l.color} inverse={isFlash}>
              {fit(l.right, RIGHT_W).padStart(RIGHT_W)}
            </Text>
          </Box>
          <Text color={edge}> │</Text>
        </Box>,
        <Box key={`meta-${id}`} flexDirection="row">
          <Text color={edge}>│ </Text>
          <Text color={C.muted}>{lead.padEnd(laneW > 0 ? laneX : inner)}</Text>
          {laneW > 0 && (
            <Box key={`lane-${id}`}>
              <Text color={l.color}>{run === undefined ? ' '.repeat(laneW) : lane(run[0], run[1], t0, t1, laneW)}</Text>
            </Box>
          )}
          <Text color={edge}> │</Text>
        </Box>,
        ...under(id, cont, s, l, edge),
      ]
    }

    // A card's title gives its key, its state and what it holds: `╭─ 2: working · 2 agents inside ──╮`.
    const card = (a: AgentInfo, digit?: string) => {
      const s = stat(a.id)
      const l = looks.get(a.id) ?? look(a.status, s, COLD_MS)
      const edge = edgeOf(a)
      const lines = rows(a, '', '', edge)
      const own = lines.length
      let inside = 0
      const walk = (parent: string, pad: string) => {
        const shown = kids(parent).filter(k => !isHidden(k))
        shown.forEach((k, i) => {
          const isLast = i === shown.length - 1
          const cont = `${pad}${isLast ? '  ' : '│ '}`
          inside += 1
          lines.push(...rows(k, `${pad}${isLast ? '└ ' : '├ '}`, cont, edge))
          walk(k.id, cont)
        })
      }
      walk(a.id, '  ')
      if (inside > 0) {
        lines.splice(own, 0, <Box key={`gap-${a.id}`}><Text color={edge}>{`│ ${' '.repeat(inner)} │`}</Text></Box>)
      }
      const state = l.kind === 'other' ? a.status : l.kind
      const what = [inside > 0 ? `${inside} agent${inside === 1 ? '' : 's'} inside` : '', s.isToMain === true ? '✉ sent to main' : '']
        .filter(x => x !== '')
        .map(x => ` · ${x}`)
        .join('')
      const keyW = digit === undefined ? 0 : KEY_W
      const extra = fit(what, Math.max(0, width - keyW - 6 - state.length))

      return (
        <Box key={`card-${a.id}`} flexDirection="column">
          <Box key={`title-${a.id}`} flexDirection="row">
            <Text color={edge}>╭─ </Text>
            {digit === undefined ? (
              <Text color={l.color}>{state}</Text>
            ) : (
              <Button key={`key-${a.id}`} plain hotkey={digit} label={state} onPress={toggle(a.id)}>
                <Text color={l.color}>{state}</Text>
              </Button>
            )}
            <Text color={C.muted}>{extra}</Text>
            <Text color={edge}>{` ${'─'.repeat(Math.max(1, width - keyW - 5 - state.length - extra.length))}╮`}</Text>
          </Box>
          {lines}
          <Box key={`end-${a.id}`}>
            <Text color={edge}>{`╰${'─'.repeat(width - 2)}╯`}</Text>
          </Box>
        </Box>
      )
    }

    // The heading over the first of a lane's agents of main's: `Lane 1 · feat-x`, the branch of the first that has one.
    const heading = (a: AgentInfo, i: number) => {
      const n = laneOf(a)
      if (n === undefined || (i > 0 && laneOf(top[i - 1]!) === n)) {
        return undefined
      }
      const branch = top.map(b => (laneOf(b) === n ? stats[b.id]?.branch : undefined)).find(b => b !== undefined)
      return branch === undefined ? `Lane ${n}` : `Lane ${n} · ${branch}`
    }

    // Main heads the board on one line, outside the cards: key 0, model and time.
    const main = { ...blank(now), isDone: true, ...stats[MAIN], model: await $.session.model() }
    const mainLook = look('running', main, MAIN_COLD_MS)
    const mainFlash = !v.still && main.flashAt !== undefined && now - main.flashAt < FLASH_MS
    const mainModel = short(main.model)
    // Cards take the keys 1 to 9 in the order they show.
    const out = [
      <Box key={`row-${MAIN}`} flexDirection="row">
        <Box key={`glyph-${MAIN}`}>
          <Text color={mainLook.color} inverse={mainFlash} bold={mainFlash}>{mainLook.glyph}</Text>
        </Box>
        <Text> </Text>
        <Button key={`open-${MAIN}`} plain hotkey="0" label={MAIN} onPress={toggle(MAIN)}>
          <Text color={mainLook.color}>{MAIN}</Text>
        </Button>
        <Text color={C.muted}>{`   ${mainModel}${' '.repeat(Math.max(1, width - KEY_W - 9 - mainModel.length - RIGHT_W))}`}</Text>
        <Box key={`right-${MAIN}`}>
          <Text color={mainLook.color} inverse={mainFlash}>
            {fit(mainLook.right, RIGHT_W).padStart(RIGHT_W)}
          </Text>
        </Box>
      </Box>,
      ...under(MAIN, '', main, mainLook),
      top.length > 0 && (
        <Box key="gap">
          <Text> </Text>
        </Box>
      ),
      ...top.flatMap((a, i) => {
        const head = heading(a, i)
        return [
          head !== undefined && (
            <Box key={`heading-${a.id}`}>
              <Text color={edgeOf(a)}>{fit(head, width)}</Text>
            </Box>
          ),
          card(a, i < 9 ? String(i + 1) : undefined),
        ]
      }),
    ]

    // The diagram view: the same tree as boxes, its lines pulsing toward the working agents.
    const meta = (model: string | undefined, right: string) => [short(model), right].filter(x => x !== '').join(' · ')
    // A lane's boxes, and the boxes of the agents they started, take the lane's color.
    const node = (a: AgentInfo, isTop: boolean, edge: string): Node => {
      const l = looks.get(a.id) ?? look(a.status, stat(a.id), COLD_MS)
      const below = kids(a.id).filter(k => !isHidden(k))
      const own = { label: label(a, isTop), glyph: l.glyph, color: l.color, meta: meta(stat(a.id).model, l.right), isLive: l.kind === 'working', edge }
      return { ...own, kids: below.map(k => node(k, false, edge)) }
    }
    const root: Node = {
      label: MAIN,
      glyph: mainLook.glyph,
      color: mainLook.color,
      meta: meta(main.model, mainLook.right),
      isLive: false,
      kids: top.map((a, i) => ({ ...node(a, true, edgeOf(a)), title: heading(a, i) })),
    }
    const dg = v.diagram === true ? diagram(root, width, v.still ? undefined : Math.floor(now / FRAME_MS), C.muted, C.working) : undefined

    const counts = (['working', 'idle', 'failed', 'done'] as const)
      .map(kind => ({ kind, n: [...looks.values()].filter(l => l.kind === kind).length }))
      .filter(c => c.n > 0)
    const color = { working: C.working, idle: C.muted, failed: C.failed, done: C.done }
    const isStarred = list.some(a => stats[a.id]?.isStar === true)
    const isQuiet = [mainLook, ...looks.values()].some(l => l.isQuiet === true)
    const isSkipped = list.some(a => a.parentId !== undefined && ids.has(a.parentId) && stats[a.id]?.isToMain === true && !isHidden(a))

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
        {dg === undefined && isSkipped && (
          <Box key="skipnote">
            <Text color={C.soon}>✉ yellow: sent to main, not to its parent</Text>
          </Box>
        )}
        {dg === undefined && isQuiet && (
          <Box key="quietnote">
            <Text color={C.soon}>{`└ yellow: no tool call or return for ${clock(QUIET_MS)}`}</Text>
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
              <Text color={C.text}>{v.diagram === true ? 'list' : 'diagram'}</Text>
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
