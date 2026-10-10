import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The engine beneath the relay: context size, prompts, commands and toasts, all recorded.
function world(on: On, context: { tokens: number }) {
  const seen = { commands: [] as string[], prompts: [] as string[], toasts: [] as string[] }
  const clock = mock.clock(on)

  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: context.tokens, window: 1_000_000 }, rateLimits: [] } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.run', ($, e) => {
    seen.commands.push(e.command)
    return { text: '' }
  })
  on('prompt.submit', ($, e) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } as const }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  return { seen, clock }
}

const relayOn = {
  command: 'relay',
  args: 'on',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

const answer = { durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

test('past 180K, one soft stop note, then handoff, /clear and restart', async ($, on) => {
  const context = { tokens: 100_000 }
  const { seen, clock } = world(on, context)
  await $.command.run(relayOn)

  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context).toBeUndefined()

  context.tokens = 185_000
  // A subagent's tool call: the engine stamps agentId, which a plugin's own call cannot spell.
  const fromSubagent = { tool: 'Bash', command: 'ls', agentId: 'sub-1' } as const
  expect((await $.tool.call(fromSubagent)).context).toBeUndefined()
  const first = await $.tool.call({ tool: 'Bash', command: 'ls' })
  const second = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(first.context?.[0]).toContain('next logical breakpoint')
  expect(second.context).toBeUndefined()

  await $.turn.complete({ ...answer, answer: 'Stopped.\nHANDOFF: /repo/docs/h.md' })
  await clock.settle()
  expect(seen.commands).toEqual(['clear'])
  expect(seen.prompts[0]).toContain('/repo/docs/h.md')
})

test('stops after 5 cycles and on RELAY: DONE', async ($, on) => {
  const { seen, clock } = world(on, { tokens: 190_000 })
  await $.command.run(relayOn)

  for (let i = 0; i < 6; i += 1) {
    await $.turn.complete({ ...answer, answer: 'HANDOFF: /repo/docs/h.md' })
    await clock.settle()
  }
  expect(seen.commands.length).toBe(5)
  expect(seen.toasts.at(-1)).toContain('after 5 cycles')

  await $.command.run(relayOn)
  await $.turn.complete({ ...answer, answer: 'All tests pass.\nRELAY: DONE' })
  await clock.settle()
  expect(seen.commands.length).toBe(5)
  expect(seen.toasts.at(-1)).toContain('task complete')
})

test('/relay now with the relay off: one note, one handoff cycle, then off again', async ($, on) => {
  const { seen, clock } = world(on, { tokens: 20_000 })
  const now = { ...relayOn, args: 'now' }

  expect((await $.command.run(now)).text).toContain('next breakpoint')
  await $.command.run(now)
  await clock.settle()
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('asked for a handoff now')

  // A turn that ends without the handoff line changes nothing.
  await $.turn.complete({ ...answer, answer: 'Tests pass.' })
  await clock.settle()
  expect(seen.commands).toEqual([])

  await $.turn.complete({ ...answer, answer: 'HANDOFF: /repo/docs/h.md' })
  await clock.settle()
  expect(seen.commands).toEqual(['clear'])
  expect(seen.prompts[1]).toBe('[relay] Continue the task. First read the handoff at /repo/docs/h.md.')

  await $.turn.complete({ ...answer, answer: 'HANDOFF: /repo/docs/h.md' })
  await clock.settle()
  expect(seen.commands).toEqual(['clear'])
})

test('/relay now past the cycle limit still runs, and /relay off cancels it', async ($, on) => {
  const { seen, clock } = world(on, { tokens: 190_000 })
  await $.command.run(relayOn)
  for (let i = 0; i < 6; i += 1) {
    await $.turn.complete({ ...answer, answer: 'HANDOFF: /repo/docs/h.md' })
    await clock.settle()
  }
  expect(seen.commands.length).toBe(5)

  await $.command.run({ ...relayOn, args: 'now' })
  await $.turn.complete({ ...answer, answer: 'HANDOFF: /repo/docs/h.md' })
  await clock.settle()
  expect(seen.commands.length).toBe(6)

  await $.command.run({ ...relayOn, args: 'now' })
  await $.command.run({ ...relayOn, args: 'off' })
  await $.turn.complete({ ...answer, answer: 'HANDOFF: /repo/docs/h.md' })
  await clock.settle()
  expect(seen.commands.length).toBe(6)
})
