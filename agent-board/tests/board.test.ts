import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, AgentSpawnArgs, AgentStatus, On, PaneOpenArgs } from 'claude-code'

import { diagram } from '../hooks/diagram'
import type { Node } from '../hooks/diagram'
import { LANE_COLORS, PALETTE, short } from '../hooks/register'
import { JEV_MODEL, JEV_URL, pick, question } from '../hooks/route'

const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ')
const done = { durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
const WIDTH = 44
const paneProps = {
  title: 'Agents',
  isFocused: false,
  bodyColumns: WIDTH,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

// The engine beneath the mod: the agent list, spawns, pane calls and the render sites, all recorded.
function world(on: On) {
  const seen = { spawned: [] as (string | undefined)[], opened: [] as PaneOpenArgs[], commands: [] as string[], spinner: [] as string[] }
  const agents: AgentInfo[] = []
  const clock = mock.clock(on)
  let count = 0

  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', (_$, e) => {
    seen.spawned.push(e.model)
    count += 1
    return { model: e.model ?? 'sonnet', agentId: `a${count}` }
  })
  on('command.register', (_$, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', (_$, e) => {
    seen.opened.push(e)
    return { value: { isPlaced: true } }
  })
  const panes: { id: string }[] = []
  on('ui.panes', () => ({ value: panes as any }))
  on('ui.render', { component: 'Spinner' }, (_$, e) => {
    seen.spinner.push((e.props as { suffix: string }).suffix)
    return { type: 'engine', ref: 0 }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // A Bash call whose command is `false` fails, as the shell would; one that starts `sleep` runs until `release()`.
  let release = () => {}
  const held = new Promise<void>(r => (release = r))
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Bash' && e.command.startsWith('sleep')) {
      await held
    }
    return e.tool === 'Bash' && e.command === 'false' ? { result: 'exit 1', isError: true } : { result: 'ok' }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  return { seen, agents, clock, panes, release: () => release() }
}

// The engine's own $ takes the whole spawn input: fill what the Agent tool would.
const spawn = ($: Engine, args: AgentSpawnArgs) =>
  $.agent.spawn({
    tool_use_id: 't1',
    description: 'd',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'sonnet',
    background: true,
    fork: false,
    ...args,
  })
// A subagent's calls: the engine stamps agentId.
const call = (agentId: string) => ({ tool: 'Bash', command: 'ls', agentId }) as const
const inLoop = <T extends object>(agentId: string, input: T) => ({ ...input, agentId })
const finish = (agentId: string, answer: string) => ({ ...done, answer, agentId }) as const
const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0, model: 'sonnet' }

const info = (id: string, description: string, status: AgentStatus, type = 'general-purpose'): AgentInfo => ({ id, description, status, type })

const mount = ($: Engine) => $.ui.mount({ plugin: 'agent-board', surface: 'terminal', component: 'Pane', props: paneProps, requestId: 'agent-board' })
// Only find: the terminal's and the desktop's drawings both have it.
type Ui = Pick<Awaited<ReturnType<typeof mount>>, 'find'>
const text = async (ui: Ui, key: string) => (await ui.find({ key }))?.text ?? ''
// Text keeps no key: a keyed Box holds it, so its props are the Box's first child's (or the i-th's).
const prop = async (ui: Ui, key: string, name: string, i = 0) =>
  ((await ui.find({ key }))?.children[i] as { props?: Record<string, unknown> } | undefined)?.props?.[name]
// The engine draws a row's hotkey (`1: `) before its name, outside the tree's text.
const KEY_W = 3

test('Explore without a model gets haiku; every other spawn passes unchanged', async ($, on) => {
  const { seen } = world(on)

  expect((await spawn($, { prompt: 'p', subagentType: 'Explore' })).model).toBe('haiku')
  expect((await spawn($, { prompt: 'p', subagentType: 'Explore', model: 'opus' })).model).toBe('opus')
  expect((await spawn($, { prompt: 'p', subagentType: 'general-purpose' })).model).toBe('sonnet')
  expect((await spawn($, { prompt: 'p', subagentType: 'general-purpose', model: 'opus' })).model).toBe('opus')
  expect(seen.spawned).toEqual(['haiku', 'opus', undefined, 'opus'])
})

// Jev beneath the mod: the key in the environment (null: unset), each request recorded and answered
// by `reply` (undefined: it never answers).
type Reply = { status: number; text: string } | undefined
function jev(on: On, reply: (body: any) => Reply, key: string | null = 'k') {
  const asked: { url: string; auth?: string; body: any }[] = []
  on('env.get', (_$, e) => ({ value: e.name === 'OPENROUTER_API_KEY' ? (key ?? undefined) : undefined }))
  on('http.fetch', (_$, e) => {
    const body = JSON.parse(e.init?.body ?? '{}')
    asked.push({ url: e.url, auth: e.init?.headers?.Authorization, body })
    const r = reply(body)
    return r === undefined ? new Promise<never>(() => {}) : { value: { ...r, ok: r.status < 300, headers: {} } }
  })
  return asked
}
const answer = (choice: string, confidence: number): Reply => ({
  status: 200,
  text: JSON.stringify({ answers: { tier: { type: 'choice', choice, probabilities: {}, confidence } } }),
})

test('Jev picks the model of an Explore or general-purpose spawn that names none', async ($, on) => {
  const { seen } = world(on)
  const asked = jev(on, () => answer('sonnet', 0.9))

  expect((await spawn($, { prompt: 'find the hooks', subagentType: 'Explore' })).model).toBe('sonnet')
  expect((await spawn($, { prompt: 'p', subagentType: 'general-purpose' })).model).toBe('sonnet')
  expect((await spawn($, { prompt: 'p', subagentType: 'Explore', model: 'opus' })).model).toBe('opus')
  expect((await spawn($, { prompt: 'p', subagentType: 'claude-code-guide' })).model).toBe('sonnet')
  expect(seen.spawned).toEqual(['sonnet', 'sonnet', 'opus', undefined])

  expect(asked.length).toBe(2)
  expect(asked[0]?.url).toBe(JEV_URL)
  expect(asked[0]?.auth).toBe('Bearer k')
  expect(asked[0]?.body.model).toBe(JEV_MODEL)
  expect(asked[0]?.body.state).toEqual({ agent_type: 'Explore', description: 'd', task: 'find the hooks' })
  expect(Object.keys(asked[0]?.body.questions.tier.criteria)).toEqual(['haiku', 'sonnet', 'opus'])
})

test('low confidence, an HTTP error, a bad answer or no key leaves the rule: Explore haiku, the rest inherit', async ($, on) => {
  const { seen } = world(on)
  const replies: Reply[] = [answer('opus', 0.3), answer('opus', 0.3), { status: 500, text: '' }, { status: 200, text: 'nope' }]
  jev(on, () => replies.shift())

  await spawn($, { prompt: 'p', subagentType: 'Explore' })
  await spawn($, { prompt: 'p', subagentType: 'general-purpose' })
  await spawn($, { prompt: 'p', subagentType: 'Explore' })
  await spawn($, { prompt: 'p', subagentType: 'Explore' })
  expect(seen.spawned).toEqual(['haiku', undefined, 'haiku', 'haiku'])
})

test('with no key anywhere Jev is never asked', async ($, on) => {
  const { seen } = world(on)
  const asked = jev(on, () => answer('opus', 1), null)
  on('fs.read', () => {
    throw new Error('ENOENT')
  })

  await spawn($, { prompt: 'p', subagentType: 'Explore' })
  expect(asked.length).toBe(0)
  expect(seen.spawned).toEqual(['haiku'])
})

test('a .env in the session directory gives the key when the environment has none', async ($, on) => {
  world(on)
  const asked = jev(on, () => answer('haiku', 0.8), null)
  // The engine hands the hook the path made absolute against the working directory.
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('/.env') ? 'FOO=1\nOPENROUTER_API_KEY="abc"\n' : '' }))

  expect((await spawn($, { prompt: 'p', subagentType: 'general-purpose' })).model).toBe('haiku')
  expect(asked[0]?.auth).toBe('Bearer abc')
})

test('a Jev that has not answered in 3 s leaves the rule', async ($, on) => {
  const { seen, clock } = world(on)
  jev(on, () => undefined)

  const ran = spawn($, { prompt: 'p', subagentType: 'Explore' })
  await clock.set(3000)
  expect((await ran).model).toBe('haiku')
  expect(seen.spawned).toEqual(['haiku'])
})

test('the expanded row says who picked the model and why', async ($, on) => {
  const { agents } = world(on)
  const replies: Reply[] = [answer('sonnet', 0.87), { status: 529, text: '' }]
  jev(on, () => replies.shift())
  await spawn($, { prompt: 'p', subagentType: 'general-purpose', description: 'review' }) // a1
  await spawn($, { prompt: 'p', subagentType: 'Explore', description: 'find' }) // a2
  agents.push(info('a1', 'review', 'running'), info('a2', 'find', 'running', 'Explore'))

  const ui = await mount($)
  await ui.press({ key: 'open-a1' })
  await ui.press({ key: 'open-a2' })
  expect(await text(ui, 'model-a1')).toContain('model   sonnet · jev sonnet at 0.87')
  expect(await text(ui, 'model-a2')).toContain('model   haiku · haiku, jev: http 529')
  expect(await text(ui, 'meta-a1')).toMatch(/^│   sonnet\*/)
  await ui.unmount()
})

test('the question lists the tiers in the order asked, and pick refuses what is not an answer', () => {
  const t = { subagentType: 'Explore', description: 'd', prompt: 'x'.repeat(5000) }
  expect(Object.keys(question(t, ['opus', 'sonnet', 'haiku']).questions.tier.criteria)).toEqual(['opus', 'sonnet', 'haiku'])
  expect(question(t).state.task.length).toBe(4000)
  expect(pick(answer('haiku', 0.7)?.text ?? '')).toEqual({ tier: 'haiku', confidence: 0.7 })
  expect(pick(answer('gpt', 0.9)?.text ?? '')).toBeUndefined()
  expect(pick('{"answers":{}}')).toBeUndefined()
  expect(pick('not json')).toBeUndefined()
})

test('/board registers at session start and opens the pane at the narrow width', async ($, on) => {
  const { seen, agents } = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(seen.commands).toEqual(['board'])
  expect(seen.opened).toEqual([])

  agents.push(info('a1', 'one', 'running'), info('a2', 'two', 'completed'))
  await $.command.run({ command: 'board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(seen.opened.map(o => [o.id, o.title, o.columns])).toEqual([['agent-board', 'Agents · 2', 46]])
})

test('each agent of main gets a card that fills the dock: glyph, name and time, then model and lane', async ($, on) => {
  const { agents, clock } = world(on)
  await spawn($, { prompt: 'p', subagentType: 'Explore', description: 'explore logs' }) // a1: haiku*
  await spawn($, { prompt: 'p', model: 'opus' }) // a2
  await spawn($, { prompt: 'p', model: 'sonnet' }) // a3
  agents.push(info('a1', 'explore logs', 'completed', 'Explore'), info('a2', 'task two', 'running'), info('a3', 'task three', 'running'))

  await $.tool.call(call('a1'))
  await $.tool.call(call('a1'))
  await $.turn.complete(finish('a1', words(120)))
  await $.tool.call(call('a2'))
  await $.turn.complete(finish('a3', words(3)))
  await clock.set(6 * 60_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-board', surface, component: 'Pane', props: paneProps, requestId: 'agent-board' })

    expect(await text(ui, 'row-main')).toMatch(/^○ main   opus 5\.5\s+$/)
    expect(await text(ui, 'title-a1')).toMatch(/^╭─ done ─+╮$/)
    expect(await text(ui, 'row-a1')).toMatch(/^│ ✓ explore logs\s+0:00 │$/)
    expect(await text(ui, 'meta-a1')).toMatch(/^│   haiku\*\s+▆\s+│$/)
    expect(await text(ui, 'row-a2')).toMatch(/^│ ⠋ task two\s+6:00 │$/)
    expect(await text(ui, 'meta-a2')).toMatch(/^│   opus\s+▆{26} │$/)
    expect(await text(ui, 'now-a2')).toMatch(/^│   └ Bash: ls · 6:00 ago\s+│$/)
    expect(await text(ui, 'row-a3')).toMatch(/^│ ○ task three\s+/)
    expect(await text(ui, 'meta-a3')).toMatch(/^│   sonnet\s/)
    expect(await text(ui, 'end-a3')).toBe(`╰${'─'.repeat(WIDTH - 2)}╯`)
    expect(await text(ui, 'now-a3')).toContain('idle · cache cold')
    expect(await prop(ui, 'glyph-a1', 'color')).toBe(PALETTE.done)
    expect(await prop(ui, 'glyph-a2', 'color')).toBe(PALETTE.working)
    expect(await prop(ui, 'glyph-a3', 'color')).toBe(PALETTE.soon)
    expect(await prop(ui, 'right-a1', 'color')).toBe(PALETTE.done)
    expect(await prop(ui, 'right-a2', 'color')).toBe(PALETTE.working)
    for (const key of ['row-main', 'title-a1', 'title-a2', 'title-a3']) {
      expect((await text(ui, key)).length + KEY_W).toBe(WIDTH)
    }
    for (const id of ['a1', 'a2', 'a3']) {
      for (const key of [`row-${id}`, `meta-${id}`, `now-${id}`, `end-${id}`]) {
        expect([key, (await text(ui, key)).length]).toEqual([key, (await ui.find({ key })) === undefined ? 0 : WIDTH])
      }
    }
    expect(await text(ui, 'summary')).toBe('1 working · 1 idle · 1 done')
    expect(await text(ui, 'footnote')).toBe('* model set by mod: click the row for why')
    expect(await text(ui, 'footer')).toContain('esc close')
    await ui.unmount()
  }
})

test('pressing a name expands its details and pressing again folds them', async ($, on) => {
  const { agents, clock } = world(on)
  await spawn($, { prompt: 'p' }) // a1
  agents.push(info('a1', 'build', 'completed'))
  await $.tool.call(inLoop('a1', { tool: 'Read', file_path: '/repo/hooks/register.tsx' } as const))
  await $.tool.call(inLoop('a1', { tool: 'Bash', command: 'false' } as const))
  await $.turn.complete({ ...finish('a1', words(120)), usage })
  await clock.set(65_000)

  const ui = await mount($)
  expect(await ui.find({ key: 'detail-a1' })).toBeUndefined()

  await ui.press({ key: 'open-a1' })
  expect(await text(ui, 'tokens-a1')).toContain('1.2k + 40k cached')
  expect(await text(ui, 'tools-a1')).toContain('2  ✗1')
  expect(await text(ui, 'report-a1')).toContain('120 words · long')
  expect(await text(ui, 'started-a1')).toContain('started 1:05 ago')
  // Each call with how long ago it started, at the card's right edge.
  expect(await text(ui, 'last-a1-0')).toMatch(/last    Read: register\.tsx\s+1:05 ago │$/)
  expect(await text(ui, 'last-a1-1')).toContain('Bash: false  ✗')
  // A detail line: the card's edge, the dim label, the bright value.
  expect(await prop(ui, 'last-a1-1', 'color', 2)).toBe(PALETTE.failed)
  expect(await prop(ui, 'tokens-a1', 'color', 1)).toBe(PALETTE.muted)
  expect(await prop(ui, 'tokens-a1', 'color', 2)).toBe(PALETTE.text)

  await ui.press({ key: 'open-a1' })
  expect(await ui.find({ key: 'detail-a1' })).toBeUndefined()
})

test('keys 1 to 9 go to the cards in the order they show; an agent inside a card and the 10th card get none', async ($, on) => {
  const { agents } = world(on)
  for (let i = 1; i <= 11; i++) {
    agents.push(i === 2 ? { ...info('a2', 'child', 'running'), parentId: 'a1' } : info(`a${i}`, `agent ${i}`, 'running'))
  }

  const ui = await mount($)
  expect((await ui.find({ key: 'open-main' }))?.props.hotkey).toBe('0')
  const hotkey = async (id: string) => (await ui.find({ key: `key-${id}` }))?.props.hotkey
  expect(await hotkey('a1')).toBe('1')
  expect(await hotkey('a2')).toBeUndefined()
  expect(await hotkey('a3')).toBe('2')
  expect(await hotkey('a10')).toBe('9')
  expect(await hotkey('a11')).toBeUndefined()
  expect(await text(ui, 'title-a11')).toMatch(/^╭─ working ─+╮$/)
  expect((await text(ui, 'title-a11')).length).toBe(WIDTH)
  await ui.press({ key: 'key-a10' })
  expect(await ui.find({ key: 'detail-a10' })).toBeDefined()
  await ui.press({ key: 'open-a2' })
  expect(await ui.find({ key: 'detail-a2' })).toBeDefined()
})

test('an agent sits inside the card of its parent; an agent whose parent left gets a card', async ($, on) => {
  const { agents } = world(on)
  for (let i = 0; i < 4; i++) {
    await spawn($, { prompt: 'p' }) // a1 to a4: sonnet, each with its lane
  }
  agents.push(
    { ...info('a1', 'research', 'running'), name: 'research' },
    { ...info('a2', 'scan', 'running'), parentId: 'a1' },
    info('a3', 'build', 'running'),
    { ...info('a4', 'orphan', 'running'), parentId: 'gone' },
  )

  const ui = await mount($)
  expect(await text(ui, 'row-main')).toMatch(/^○ main\s+opus\s/)
  expect(await text(ui, 'title-a1')).toMatch(/^╭─ working · 1 agent inside ─+╮$/)
  expect(await text(ui, 'row-a1')).toMatch(/^│ \S research/)
  expect(await text(ui, 'gap-a1')).toMatch(/^│\s+│$/)
  expect(await text(ui, 'row-a2')).toMatch(/^│   └ \S scan/)
  expect(await text(ui, 'meta-a2')).toMatch(/^│       sonnet\s/)
  expect(await ui.find({ key: 'card-a2' })).toBeUndefined()
  expect(await text(ui, 'row-a3')).toMatch(/^│ \S build/)
  expect(await text(ui, 'row-a4')).toMatch(/^│ \S orphan/)
  // One lane column for every card, past the nested model.
  expect((await text(ui, 'meta-a3')).indexOf('▆')).toBeGreaterThan(0)
  expect((await text(ui, 'meta-a3')).indexOf('▆')).toBe((await text(ui, 'meta-a2')).indexOf('▆'))
})

test('rows show the current tool while working; a failed call flashes for a second', async ($, on) => {
  const { agents, clock } = world(on)
  await spawn($, { prompt: 'p', model: 'sonnet' }) // a1
  agents.push(info('a1', 'build', 'running'))

  await $.turn.start({ text: 'go', turnId: 'm1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })
  await $.tool.call(inLoop('a1', { tool: 'Read', file_path: '/repo/hooks/register.tsx' } as const))
  await $.tool.call(inLoop('a1', { tool: 'Bash', command: 'false' } as const))

  let ui = await mount($)
  expect(await text(ui, 'now-main')).toBe('  └ Bash: Run the tests · 0:00 ago')
  expect(await text(ui, 'now-a1')).toContain('└ Bash: false')
  expect(await prop(ui, 'glyph-a1', 'inverse')).toBe(true)
  expect(await prop(ui, 'glyph-main', 'inverse')).toBe(false)
  await ui.unmount()

  await clock.set(1500)
  ui = await mount($)
  expect(await prop(ui, 'glyph-a1', 'inverse')).toBe(false)
  await ui.unmount()

  await $.tool.call(inLoop('a1', { tool: 'Read', file_path: '/repo/hooks/register.tsx' } as const))
  await $.turn.complete({ ...finish('a1', 'done'), usage })
  await $.turn.complete({ ...done, answer: 'ok', usage })

  ui = await mount($)
  expect(await text(ui, 'now-a1')).toContain('idle · cache 5m left')
  expect(await text(ui, 'now-main')).toContain('idle · cache 60m left')
  await ui.press({ key: 'open-a1' })
  expect(await text(ui, 'tokens-a1')).toContain('1.2k + 40k cached')
  expect(await text(ui, 'tools-a1')).toContain('3  ✗1')
  await ui.press({ key: 'open-main' })
  expect(await text(ui, 'tokens-main')).toContain('1.2k + 40k cached')
})

test('the current tool names a file by its last segment', async ($, on) => {
  const { agents } = world(on)
  await spawn($, { prompt: 'p' }) // a1
  agents.push(info('a1', 'edit', 'running'))
  await $.tool.call(inLoop('a1', { tool: 'Read', file_path: '/repo/hooks/register.tsx' } as const))

  const ui = await mount($)
  expect(await text(ui, 'now-a1')).toMatch(/Read: register\.tsx · 0:00 ago\s+│$/)
})

test('a tool call shows its clock while it runs, cut so the clock fits; once it returns, the time since', async ($, on) => {
  const { agents, clock, release } = world(on)
  await spawn($, { prompt: 'p' }) // a1
  await spawn($, { prompt: 'p' }) // a2
  agents.push(info('a1', 'short', 'running'), info('a2', 'long', 'running'))
  const short = $.tool.call(inLoop('a1', { tool: 'Bash', command: 'sleep 90' } as const))
  const long = $.tool.call(inLoop('a2', { tool: 'Bash', command: 'sleep 90 && echo a command too long for the dock' } as const))
  await clock.set(42_000)

  let ui = await mount($)
  expect(await text(ui, 'now-a1')).toMatch(/^│   └ Bash: sleep 90 · 0:42\s+│$/)
  expect(await text(ui, 'now-a2')).toMatch(/^│   └ Bash: sleep 90 && .*… · 0:42 │$/)
  expect((await text(ui, 'now-a2')).length).toBe(WIDTH)
  await ui.unmount()

  release()
  await Promise.all([short, long])
  await clock.set(50_000)
  ui = await mount($)
  expect(await text(ui, 'now-a1')).toMatch(/^│   └ Bash: sleep 90 · 0:08 ago\s+│$/)
})

test('a working agent with no tool call or return for 3 minutes turns its tool line yellow', async ($, on) => {
  const { agents, clock } = world(on)
  await spawn($, { prompt: 'p' }) // a1 calls a tool
  await spawn($, { prompt: 'p' }) // a2 calls none
  agents.push(info('a1', 'build', 'running'), info('a2', 'think', 'running'))
  await $.tool.call(inLoop('a1', { tool: 'Read', file_path: '/repo/hooks/register.tsx' } as const))
  await clock.set(179_000)

  let ui = await mount($)
  expect(await prop(ui, 'now-a1', 'color', 1)).toBe(PALETTE.muted)
  expect(await ui.find({ key: 'now-a2' })).toBeUndefined()
  expect(await ui.find({ key: 'quietnote' })).toBeUndefined()
  await ui.unmount()

  await clock.set(180_000)
  ui = await mount($)
  expect(await text(ui, 'now-a1')).toContain('└ Read: register.tsx · 3:00 ago')
  expect(await prop(ui, 'now-a1', 'color', 1)).toBe(PALETTE.soon)
  expect(await text(ui, 'now-a2')).toContain('└ no tool call · 3:00')
  expect(await text(ui, 'quietnote')).toBe('└ yellow: no tool call or return for 3:00')
})

test('a message to main shows in the card title from an agent of main, and yellow on the name of a nested agent', async ($, on) => {
  const { agents } = world(on)
  agents.push(
    info('a1', 'parent', 'running'),
    { ...info('a2', 'skips', 'running'), parentId: 'a1' },
    { ...info('a3', 'reports up', 'running'), parentId: 'a1' },
  )
  await $.tool.call(inLoop('a1', { tool: 'SendMessage', to: 'main', message: 'P1: done' } as const))
  await $.tool.call(inLoop('a2', { tool: 'SendMessage', to: 'main', message: 'P1.a: done' } as const))
  await $.tool.call(inLoop('a3', { tool: 'SendMessage', to: 'a1', message: 'P1.b: done' } as const))

  const ui = await mount($)
  expect(await text(ui, 'now-a1')).toContain('└ SendMessage: main')
  expect(await text(ui, 'now-a3')).toContain('└ SendMessage: a1')
  expect(await text(ui, 'title-a1')).toMatch(/^╭─ working · 2 agents inside · ✉.*╮$/)
  expect(await text(ui, 'row-a1')).toMatch(/^│ \S parent/)
  expect(await text(ui, 'row-a2')).toMatch(/^│   ├ \S ✉ skips/)
  expect(await prop(ui, 'open-a2', 'color')).toBe(PALETTE.soon)
  expect(await text(ui, 'row-a3')).toMatch(/^│   └ \S reports up/)
  expect(await text(ui, 'skipnote')).toBe('✉ yellow: sent to main, not to its parent')
  expect((await text(ui, 'title-a1')).length + KEY_W).toBe(WIDTH)
  for (const key of ['row-a1', 'row-a2', 'row-a3']) {
    expect((await text(ui, key)).length).toBe(WIDTH)
  }
})

test('main turns cache cold after an hour, a subagent after 5 minutes; the last minute is yellow', async ($, on) => {
  const { agents, clock } = world(on)
  await spawn($, { prompt: 'p' }) // a1
  agents.push(info('a1', 'one', 'running'))
  await $.turn.start({ text: 'go', turnId: 'm1' })
  await $.turn.complete({ ...done, answer: 'ok' })
  await $.turn.complete(finish('a1', 'ok'))

  await clock.set(3 * 60_000)
  let ui = await mount($)
  expect(await prop(ui, 'glyph-a1', 'color')).toBe(PALETTE.muted)
  await ui.unmount()

  await clock.set(4.5 * 60_000)
  ui = await mount($)
  expect(await text(ui, 'now-a1')).toContain('idle · cache 1m left')
  expect(await prop(ui, 'glyph-a1', 'color')).toBe(PALETTE.soon)
  await ui.unmount()

  await clock.set(10 * 60_000)
  ui = await mount($)
  expect(await text(ui, 'now-main')).toContain('idle · cache 50m left')
  expect(await text(ui, 'now-a1')).toContain('idle · cache cold')
  await ui.unmount()

  await clock.set(61 * 60_000)
  ui = await mount($)
  expect(await text(ui, 'now-main')).toContain('idle · cache cold')
})

test('time runs while an agent works and holds the turn time after', async ($, on) => {
  const { agents, clock } = world(on)
  await spawn($, { prompt: 'p' }) // a1
  agents.push(info('a1', 'one', 'running'))
  await clock.set(30_000)

  let ui = await mount($)
  expect(await text(ui, 'row-a1')).toMatch(/one.*0:30 │$/)
  await ui.unmount()

  await $.turn.complete({ ...finish('a1', 'ok'), durationMs: 45_000 })
  agents.splice(0, 1, info('a1', 'one', 'completed'))
  await clock.set(90_000)
  ui = await mount($)
  expect(await text(ui, 'row-a1')).toMatch(/✓ one.*0:45 │$/)
})

test('a bad end shows its reason in red; pending, waiting and idle show no ✗', async ($, on) => {
  const { agents } = world(on)
  await spawn($, { prompt: 'p' }) // a1
  await spawn($, { prompt: 'p' }) // a2
  await $.turn.complete({ ...finish('a1', ''), reason: 'error' })
  await $.turn.complete({ ...finish('a2', ''), reason: 'aborted', isAborted: true })
  agents.push(
    info('a1', 'err', 'failed'),
    info('a2', 'stop', 'completed'),
    info('a3', 'gone', 'killed'),
    info('t1', 'mate', 'idle', 'teammate'),
    info('a4', 'queued', 'pending'),
    info('a5', 'held', 'waiting'),
  )

  const ui = await mount($)
  expect(await text(ui, 'row-a1')).toMatch(/✗ err.*error │$/)
  expect(await text(ui, 'row-a2')).toMatch(/✗ stop.*aborted │$/)
  expect(await text(ui, 'row-a3')).toMatch(/✗ gone.*killed │$/)
  expect(await text(ui, 'title-a1')).toMatch(/^╭─ failed /)
  expect(await text(ui, 'title-a4')).toMatch(/^╭─ pending /)
  expect(await prop(ui, 'right-a1', 'color')).toBe(PALETTE.failed)
  expect(await text(ui, 'summary')).toBe('1 idle · 3 failed')
  for (const [id, word] of [['t1', 'idle'], ['a4', 'pending'], ['a5', 'waiting']] as const) {
    expect(await text(ui, `row-${id}`) + (await text(ui, `now-${id}`))).toContain(word)
    expect(await text(ui, `row-${id}`)).not.toContain('✗')
  }
})

test('h hides returned agents, but keeps failed ones and a returned parent of a live child', async ($, on) => {
  const { agents } = world(on)
  agents.push(
    info('a1', 'returned', 'completed'),
    info('a2', 'broke', 'failed'),
    info('a3', 'parent', 'completed'),
    { ...info('a4', 'child', 'running'), parentId: 'a3' },
  )

  const ui = await mount($)
  expect(await text(ui, 'hide')).toContain('hide done')
  await ui.press({ key: 'hide' })
  expect(await ui.find({ key: 'row-a1' })).toBeUndefined()
  expect(await ui.find({ key: 'row-a2' })).toBeDefined()
  expect(await ui.find({ key: 'row-a3' })).toBeDefined()
  expect(await ui.find({ key: 'row-a4' })).toBeDefined()
  expect(await text(ui, 'hide')).toContain('show done')

  await ui.press({ key: 'hide' })
  expect(await ui.find({ key: 'row-a1' })).toBeDefined()
})

test('a returned agent keeps its row after the engine drops it; c clears returned ones', async ($, on) => {
  const { agents, seen } = world(on)
  agents.push(
    info('a1', 'returned', 'running'),
    info('a2', 'broke', 'running'),
    info('a3', 'parent', 'completed'),
    { ...info('a4', 'child', 'running'), parentId: 'a3' },
    info('a5', 'listed', 'completed'),
  )
  await $.turn.complete(finish('a1', 'ok'))
  await $.turn.complete({ ...finish('a2', ''), reason: 'error' })
  agents.splice(0, 2) // the engine drops both tasks

  const ui = await mount($)
  expect(await text(ui, 'row-a1')).toMatch(/✓ returned/)
  expect(await text(ui, 'row-a2')).toMatch(/✗ broke.*error │$/)
  await ui.press({ key: 'clear' })
  expect(await ui.find({ key: 'row-a1' })).toBeUndefined()
  expect(await ui.find({ key: 'row-a5' })).toBeUndefined()
  for (const id of ['a2', 'a3', 'a4']) {
    expect(await ui.find({ key: `row-${id}` })).toBeDefined()
  }
  expect(seen.opened.at(-1)?.title).toBe('Agents · 3')
})

test('the spinner turns with the clock; m stops the motion and the flash', async ($, on) => {
  const { agents, clock } = world(on)
  await spawn($, { prompt: 'p' }) // a1
  agents.push(info('a1', 'one', 'running'))
  await $.tool.call(inLoop('a1', { tool: 'Bash', command: 'false' } as const))

  let ui = await mount($)
  expect(await text(ui, 'glyph-a1')).toBe('⠋')
  expect(await prop(ui, 'glyph-a1', 'inverse')).toBe(true)
  await ui.unmount()

  await clock.set(125)
  ui = await mount($)
  expect(await text(ui, 'glyph-a1')).toBe('⠙')
  await ui.press({ key: 'motion' })
  expect(await text(ui, 'glyph-a1')).toBe('●')
  expect(await prop(ui, 'glyph-a1', 'inverse')).toBe(false)
  expect(await text(ui, 'motion')).toContain('motion on')
})

test('the spinner suffix counts running agents and keeps the engine spinner', async ($, on) => {
  const { seen, agents } = world(on)
  const props = { word: 'Thinking', message: null, suffix: '…', mode: 'thinking' } as const
  const draw = () => $.ui.render({ surface: 'terminal', component: 'Spinner', requestId: 'main', props })

  await draw()
  agents.push(info('a1', 'one', 'running'), info('a2', 'two', 'running'), info('a3', 'three', 'completed'))
  const drawn = await draw()
  expect(seen.spinner).toEqual(['…', ' · 2 agents running…'])
  expect(drawn).toEqual({ type: 'engine', ref: 0 })
})

test('the 10 s refresh keeps esc close and the asked width on the open board', async ($, on) => {
  const { seen, agents, clock, panes } = world(on)
  agents.push(info('a1', 'one', 'running'))
  await $.command.run({ command: 'board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  panes.push({ id: 'agent-board' })
  await clock.set(10_000)

  expect(seen.opened.length).toBe(2)
  expect(seen.opened.map(o => [o.closeOnEscape, o.columns])).toEqual([[true, 46], [true, 46]])
})

test('the open board redraws 8 times a second while something moves, then stops', async ($, on) => {
  const { agents, clock, panes } = world(on)
  let draws = 0
  on('ui.invalidate', () => {
    draws += 1
    return { value: undefined }
  })
  panes.push({ id: 'agent-board' })
  await spawn($, { prompt: 'p' }) // a1
  agents.push(info('a1', 'one', 'running'))
  await $.command.run({ command: 'board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

  await clock.set(1000)
  expect(draws).toBe(8)

  // The return flashes until 2000; the first tick after it finds nothing moving and stops.
  await $.turn.complete(finish('a1', 'ok'))
  agents.splice(0, 1, info('a1', 'one', 'completed'))
  await clock.set(2200)
  const stopped = draws
  await clock.set(9000)
  expect(draws).toBe(stopped)
})

test('r runs /relay now from its own footer line', async ($, on) => {
  world(on)
  const asked: string[] = []
  on('command.run', { command: 'relay' }, (_$, e) => {
    asked.push(e.args)
    return { text: '' }
  })
  const ui = await mount($)
  expect(await text(ui, 'keys')).toBe('hide done  clear done  diagram')
  expect(await text(ui, 'keys2')).toBe('motion off  handoff  esc close')
  await ui.press({ key: 'handoff' })
  expect(asked).toEqual(['now'])
  await ui.unmount()
})

test('each lane puts its agent on one time axis, in the color of its status', async ($, on) => {
  const { agents, clock } = world(on)
  await spawn($, { prompt: 'p' }) // a1 runs from 0:00 to 0:30
  await clock.set(30_000)
  await $.turn.complete(finish('a1', 'ok'))
  await spawn($, { prompt: 'p' }) // a2 runs from 0:30 on
  agents.push(info('a1', 'first', 'completed'), info('a2', 'second', 'running'))
  await clock.set(60_000)

  const ui = await mount($)
  expect(await text(ui, 'lane-a1')).toBe(`${'▆'.repeat(13)}${' '.repeat(13)}`)
  expect(await text(ui, 'lane-a2')).toBe(`${' '.repeat(13)}${'▆'.repeat(13)}`)
  expect(await ui.find({ key: 'lane-main' })).toBeUndefined()
  expect(await prop(ui, 'lane-a1', 'color')).toBe(PALETTE.done)
  expect(await prop(ui, 'lane-a2', 'color')).toBe(PALETTE.working)
})

test('v swaps the rows for the box diagram and back; the boxes branch right from main', async ($, on) => {
  const { agents } = world(on)
  agents.push({ ...info('a1', 'research', 'running'), name: 'research' }, { ...info('a2', 'scan', 'running'), parentId: 'a1' }, info('a3', 'build', 'completed'))

  const ui = await mount($)
  expect(await text(ui, 'view')).toBe('diagram')
  await ui.press({ key: 'view' })
  expect(await ui.find({ key: 'row-a1' })).toBeUndefined()
  expect(await ui.find({ key: 'footnote' })).toBeUndefined()
  expect(await text(ui, 'view')).toBe('list')
  // Three levels in 44: boxes of 12, so "research" breaks; build sits under research's box.
  const lines = await Promise.all(Array.from({ length: 11 }, (_, y) => text(ui, `dg-${y}`)))
  expect(lines[1]).toMatch(/main.*resear.*scan/)
  expect(lines[2]).toContain('opus')
  expect(lines[7]).toContain('build')
  expect(await ui.find({ key: 'dg-11' })).toBeUndefined()
  for (const l of lines) {
    expect(l.length <= WIDTH).toBe(true)
  }

  await ui.press({ key: 'view' })
  expect(await ui.find({ key: 'row-a1' })).toBeDefined()
})

test('a lane keeps its agents together under one heading, with the branch of an agent that runs in its own directory', async ($, on) => {
  const { agents } = world(on)
  const runs: { argv: readonly string[]; cwd?: string }[] = []
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd })
    return { value: { exitCode: 0, stdout: 'feat-x\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The review starts after Lane 2, yet sits with Lane 1's implement.
  agents.push(info('a1', 'Lane 1: implement acc-vc9', 'completed'), info('a2', 'lane 2: write plan', 'running'), info('a3', 'Lane 1: review', 'running'))
  agents.push(info('a4', 'scan', 'running'))
  await spawn($, { prompt: 'p', cwd: '/repo/.worktrees/feat-x' })
  await spawn($, { prompt: 'p', cwd: '/repo' })
  await spawn($, { prompt: 'p' })
  await spawn($, { prompt: 'p' })
  expect(runs).toEqual([{ argv: ['git', 'branch', '--show-current'], cwd: '/repo/.worktrees/feat-x' }])

  const ui = await mount($)
  const hotkey = async (id: string) => (await ui.find({ key: `key-${id}` }))?.props.hotkey
  expect([await hotkey('a1'), await hotkey('a3'), await hotkey('a2'), await hotkey('a4')]).toEqual(['1', '2', '3', '4'])
  expect(await text(ui, 'heading-a1')).toBe('Lane 1 · feat-x')
  expect(await ui.find({ key: 'heading-a3' })).toBeUndefined()
  expect(await text(ui, 'heading-a2')).toBe('Lane 2')
  expect(await ui.find({ key: 'heading-a4' })).toBeUndefined()
  expect(await text(ui, 'open-a1')).toBe('implement acc-vc9')
  expect(await text(ui, 'open-a4')).toBe('scan')

  await ui.press({ key: 'view' })
  expect(await text(ui, 'dg-0')).toContain('Lane 1 · feat-x')
  expect(await text(ui, 'dg-2')).toMatch(/main.*implement/)
})

test('each lane colors its heading and its card edges; lane 6 takes the color of lane 1', async ($, on) => {
  const { agents } = world(on)
  agents.push(...[1, 2, 3, 4, 5, 6].map(n => info(`a${n}`, `Lane ${n}: work`, 'running')), info('a7', 'scan', 'running'))

  const ui = await mount($)
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const color = LANE_COLORS[(n - 1) % LANE_COLORS.length]
    expect([n, await prop(ui, `heading-a${n}`, 'color'), await prop(ui, `end-a${n}`, 'color')]).toEqual([n, color, color])
  }
  expect(await prop(ui, 'end-a6', 'color')).toBe(LANE_COLORS[0])
  expect(await prop(ui, 'end-a7', 'color')).toBe(PALETTE.muted)
})

test("a worktree agent's branch heads its lane, from git's list of worktrees at the agent's first tool call", async ($, on) => {
  const { agents } = world(on)
  const runs: string[] = []
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_$, e) => {
    runs.push(`${e.argv.join(' ')} in ${e.init?.cwd}`)
    const stdout = [
      'worktree /repo\nHEAD 1\nbranch refs/heads/main',
      'worktree /repo/.claude/worktrees/agent-a10\nHEAD 2\nbranch refs/heads/other',
      'worktree /repo/.claude/worktrees/agent-a1\nHEAD 3\nbranch refs/heads/worktree-agent-a1',
    ].join('\n\n')
    return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  agents.push(info('a1', 'Lane 1: implement', 'running'), info('a2', 'Lane 2: write', 'running'))
  await $.tool.call(call('a1'))
  await $.tool.call(call('a1'))
  await $.tool.call(call('a2'))
  // Once per agent, whether or not it has a worktree.
  expect(runs).toEqual(['git worktree list --porcelain in /repo', 'git worktree list --porcelain in /repo'])

  const ui = await mount($)
  expect(await text(ui, 'heading-a1')).toBe('Lane 1 · worktree-agent-a1')
  expect(await text(ui, 'heading-a2')).toBe('Lane 2')
})

const leaf = (label: string, isLive: boolean): Node => ({ label, glyph: '·', color: 'c', meta: 'haiku · 0:12', isLive, kids: [] })
const tree = (...kids: Node[]): Node => ({ label: 'main', glyph: '○', color: 'c', meta: 'opus · 1:00', isLive: false, kids })
const row = (rows: { text: string }[][], y: number) => (rows[y] ?? []).map(r => r.text).join('')
// The lit cells of a diagram, as "row:column".
const lit = (rows: { text: string; color: string }[][]) =>
  rows.flatMap((runs, y) => {
    const cells = runs.flatMap(r => [...r.text].map(() => r.color))
    return cells.flatMap((color, x) => (color === 'pulse' ? [`${y}:${x}`] : []))
  })

test('a line toward a working agent pulses away from main, one cell a frame; motion off holds the path lit', () => {
  // Boxes of 20 in 44: main in columns 0-19, the children from column 23, the done box in rows 0-4, the live
  // box in rows 6-10. Main's stub is column 20, the bus column 21 from row 2 to row 8, the live box's joint 8:23.
  const root = tree(leaf('done', false), leaf('live', true))
  const at = (frame: number | undefined) => diagram(root, 44, frame, 'line', 'pulse').rows

  expect(lit(at(0))).toEqual(['2:20', '5:21', '8:22'])
  expect(lit(at(1))).toEqual(['2:21', '6:21', '8:23'])
  expect([...row(at(0), 5)][21]).toBe('┃')

  // Motion off: the stub, the bus down to the live box, and its joint, all lit; none toward the done box.
  const still = lit(at(undefined))
  expect(still).toContain('2:20')
  expect(still).toContain('8:23')
  expect(still.filter(c => c.endsWith(':21')).length).toBe(7)
  expect(still).not.toContain('2:22')
})

test('a box holds the name in up to two lines and the model and time under it', () => {
  const rows = diagram(tree(leaf('Verify Snowflake Cortex capabilities', false)), 60, 0, 'line', 'pulse').rows
  // Two boxes of 24 side by side, joined at their middle row.
  expect(row(rows, 1).trim()).toBe('│ ○ main               │   │ · Verify Snowflake   │')
  expect(row(rows, 2).trim()).toBe('│   opus · 1:00        ├───┤   Cortex capabiliti… │')
  expect(row(rows, 3).trim()).toBe('│                      │   │   haiku · 0:12       │')
})

test('a lane heading sits over its first box, and the parent stays level with that box', () => {
  const rows = diagram(tree({ ...leaf('implement', false), title: 'Lane 1 · feat-x' }, leaf('review', false), { ...leaf('write', false), title: 'Lane 2' }), 44, 0, 'line', 'pulse').rows
  // Boxes of 20: the children from column 23, the bus in column 21. Heading, box, gap, box, gap, heading, box.
  expect(rows.length).toBe(1 + 5 + 1 + 5 + 1 + 1 + 5)
  expect(row(rows, 0).trim()).toBe('Lane 1 · feat-x')
  expect(row(rows, 1)).toMatch(/^╭─+╮   ╭─+╮$/)
  expect(row(rows, 3)).toContain('├─┬─┤')
  expect(row(rows, 9)).toContain('├─┤')
  expect(row(rows, 13).trimEnd()).toBe(`${' '.repeat(21)}│ Lane 2`)
  expect(row(rows, 16)).toContain('└─┤')
})

test("a lane's box and heading take its color; main's box keeps the lines' color", () => {
  const rows = diagram(tree({ ...leaf('implement', false), title: 'Lane 1', edge: 'violet' }), 44, 0, 'line', 'pulse').rows
  expect(rows[0]!.find(r => r.text.includes('Lane 1'))?.color).toBe('violet')
  expect(rows[1]!.map(r => r.color)).toEqual(['line', 'violet'])
})

test('a wide tree grows down; a deep tree narrows its boxes to fit the pane, then cuts at its edge', () => {
  const kids = (n: number) => Array.from({ length: n }, (_, i) => leaf(`agent ${i}`, false))
  const chain = (n: number): Node => (n === 0 ? leaf('end', false) : { ...leaf(`level ${n}`, false), kids: [chain(n - 1)] })
  const width = (rows: { text: string }[][]) => Math.max(...rows.map(r => r.map(x => x.text).join('').length))

  const wide = diagram(tree(...kids(8)), 44, 0, 'line', 'pulse')
  expect(wide.isCut).toBe(false)
  expect(wide.rows.length).toBe(8 * 5 + 7)

  const fits = diagram(tree(chain(1)), 44, 0, 'line', 'pulse')
  expect(fits.isCut).toBe(false)
  expect(width(fits.rows) <= 44).toBe(true)

  const cut = diagram(tree(chain(2)), 44, 0, 'line', 'pulse')
  expect(cut.isCut).toBe(true)
  expect(width(cut.rows)).toBe(44)
  expect(cut.rows.some(r => r.map(x => x.text).join('').endsWith('…'))).toBe(true)
})

test('a model shows as its family and version; an alias shows as it is', () => {
  expect(short('claude-sonnet-5-5')).toBe('sonnet 5.5')
  expect(short('claude-opus-5-5[1m]')).toBe('opus 5.5')
  expect(short('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
  expect(short('claude-sonnet-4-20250514')).toBe('sonnet 4')
  expect(short('haiku')).toBe('haiku')
  expect(short('gpt-x')).toBe('gpt-x')
  expect(short(undefined)).toBe('')
})

// WCAG contrast: 4.5:1 is the floor for normal text.
test('every text color in the palette reads on its background', () => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const { bg, ...text } = PALETTE
  for (const [name, hex] of [...Object.entries(text), ...LANE_COLORS.map((hex, i) => [`lane ${i + 1}`, hex] as const)]) {
    expect([name, (lum(hex) + 0.05) / (lum(bg) + 0.05) >= 4.5]).toEqual([name, true])
  }
})
