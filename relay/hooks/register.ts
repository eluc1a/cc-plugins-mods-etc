import type { AgentInfo, AgentStatus, EngineInterface, Register } from 'claude-code'

const SOFT_LIMIT = 180_000
const MAX_CYCLES = 10

const stopNote = (why: string) =>
  `[relay] ${why} ` +
  'Continue only to the next logical breakpoint, then stop. Do not start new work. ' +
  'If background agents still run, wait for each to report and record its result first. ' +
  'Then write a handoff with the writing-handoffs skill. ' +
  'End your final message with one line: "HANDOFF: <absolute path of the handoff file>". ' +
  'If the whole task is complete, end with the line "RELAY: DONE" instead.'

const waitNote = (live: AgentInfo[]) =>
  `[relay] Do not clear yet: ${live.length} background agent(s) still run (${live.map(a => a.description).join('; ')}). ` +
  '/clear would lose their results. End this turn without the HANDOFF line. ' +
  'When each agent reports, record its result in the handoff. After the last one reports, end with the HANDOFF line again.'

// Statuses whose result a /clear would lose.
// ponytail: background Bash tasks are not in $.agent.list(); guard them too if a handoff ever loses one
const LIVE: AgentStatus[] = ['pending', 'running', 'waiting']

const pastLimit = (tokens: number) =>
  `The context is at ${Math.round(tokens / 1000)}K tokens, past the ${SOFT_LIMIT / 1000}K soft limit.`

// ponytail: module variables, so a save of this mod or a restart disarms the relay and resets the count
let isArmed = false
let cycles = 0
let isStopAsked = false
// One cycle the person asked for with /relay now, armed or not.
let isOnce = false
// The wait note goes out once per handoff, so a repeated HANDOFF line cannot loop prompts.
let isWaitAsked = false

function showStatus($: EngineInterface) {
  const text = isArmed ? `relay ${cycles}/${MAX_CYCLES}` : isOnce ? 'relay once' : undefined
  $.ui.status(text !== undefined && isStopAsked ? `${text} · stopping` : text)
}

function disarm($: EngineInterface) {
  isArmed = false
  isOnce = false
  showStatus($)
}

async function contextTokens($: EngineInterface) {
  return (await $.session.usage()).context.tokens ?? 0
}

async function restart($: EngineInterface, path: string) {
  await $.command.run({ command: 'clear' })
  await $.prompt.submit({ text: `[relay${isArmed ? ` ${cycles}/${MAX_CYCLES}` : ''}] Continue the task. First read the handoff at ${path}.` })
  showStatus($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'relay',
      description: `Soft stop past ${SOFT_LIMIT / 1000}K context, hand off, /clear, continue (max ${MAX_CYCLES} cycles); now = one cycle at once`,
      argumentHint: 'on | off | now',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'relay' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'on') {
      isArmed = true
      cycles = 0
      isStopAsked = false
    }
    if (arg === 'off') {
      isArmed = false
      isOnce = false
    }
    if (arg === 'now') {
      isOnce = true
      if (!isStopAsked) {
        isStopAsked = true
        // Idle, the note starts a turn; mid-turn, the engine queues it into the running turn.
        $.clock.after(0, () => void $.prompt.submit({ text: stopNote('The owner asked for a handoff now.') }))
      }
      showStatus($)
      return { text: 'Relay: handoff at the next breakpoint, then /clear and continue.' }
    }
    showStatus($)

    return { text: isArmed ? `Relay on: cycle ${cycles}/${MAX_CYCLES}, soft limit ${SOFT_LIMIT / 1000}K.` : 'Relay off.' }
  })

  // Mid-turn: the first tool result past the limit carries the soft stop note to the model.
  on('tool.call', async ($, e, next) => {
    // Past the limit, the main loop starts no new subagent: it waits for the live ones, then hands off.
    if (e.tool === 'Agent' && e.agentId === undefined && (isStopAsked || (isArmed && (await contextTokens($)) >= SOFT_LIMIT))) {
      return { deny: `[relay] No new subagents past the ${SOFT_LIMIT / 1000}K soft limit. Wait for the running agents, then write the handoff.` }
    }
    const ran = await next(e)
    if (!isArmed || isStopAsked || e.agentId !== undefined || ran.deny !== undefined) {
      return ran
    }
    const tokens = await contextTokens($)
    if (tokens < SOFT_LIMIT) {
      return ran
    }
    isStopAsked = true
    showStatus($)

    return { ...ran, context: [...(ran.context ?? []), stopNote(pastLimit(tokens))] }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!(isArmed || isOnce) || e.agentId !== undefined || e.isAborted) {
      return done
    }

    if (/^RELAY: DONE\s*$/m.test(e.answer)) {
      disarm($)
      $.ui.toast('Relay: task complete.')
      return done
    }

    const path = e.answer.match(/^HANDOFF:\s*(\S+)\s*$/m)?.[1]
    if (path === undefined) {
      // The turn ended past the limit before any tool call saw it: the turn's end is the breakpoint.
      const tokens = await contextTokens($)
      if (!isStopAsked && tokens >= SOFT_LIMIT) {
        isStopAsked = true
        showStatus($)
        $.clock.after(0, () => void $.prompt.submit({ text: stopNote(pastLimit(tokens)) }))
      }
      return done
    }

    const isFile = await $.fs.stat(path).then(
      stat => stat.kind === 'file',
      () => false,
    )
    if (!isFile) {
      disarm($)
      $.ui.toast(`Relay stopped: no handoff file at ${path}`)
      return done
    }
    if (!isOnce && cycles >= MAX_CYCLES) {
      disarm($)
      $.ui.toast(`Relay stopped after ${MAX_CYCLES} cycles. Handoff: ${path}`)
      return done
    }

    const live = (await $.agent.list()).filter(a => LIVE.includes(a.status))
    if (live.length > 0) {
      $.ui.toast(`Relay waits: ${live.length} background agent(s) still run`)
      if (!isWaitAsked) {
        isWaitAsked = true
        $.clock.after(0, () => void $.prompt.submit({ text: waitNote(live) }))
      }
      return done
    }

    if (isArmed) {
      cycles += 1
    }
    isWaitAsked = false
    isStopAsked = false
    isOnce = false
    // After the turn: $.command.run rejects inside a hook the turn waits on.
    $.clock.after(0, () => void restart($, path))

    return done
  })
}
