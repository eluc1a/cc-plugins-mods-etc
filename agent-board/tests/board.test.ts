import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, AgentSpawnArgs, AgentStatus, On, PaneOpenArgs } from 'claude-code'

import { diagram } from '../hooks/diagram'
import type { Node } from '../hooks/diagram'
import { PALETTE } from '../hooks/register'
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
// Text keeps no key: a keyed Box holds it, so its props are the Box's first child's.
const prop = async (ui: Ui, key: string, name: string) =>
  ((await ui.find({ key }))?.children[0] as { props?: Record<string, unknown> } | undefined)?.props?.[name]

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
  expect(await text(ui, 'route-a1')).toContain('model   jev sonnet at 0.87')
  expect(await text(ui, 'route-a2')).toContain('model   haiku, jev: http 529')
  expect(await text(ui, 'row-a1')).toMatch(/sonnet\*/)
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

test('each line fits the dock and shows glyph, name, model and time on every surface', async ($, on) => {
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

    expect(await text(ui, 'row-a1')).toMatch(/^├ ✓ explore logs\s+haiku\*\s+━\s+0:00$/)
    expect(await text(ui, 'row-a2')).toMatch(/^├ ⠋ task two\s+opus\s+━{8}\s+6:00$/)
    expect(await text(ui, 'now-a2')).toContain('└ Bash: ls')
    expect(await text(ui, 'row-a3')).toMatch(/^└ ○ task three\s+sonnet/)
    expect(await text(ui, 'now-a3')).toContain('idle · cache cold')
    expect(await prop(ui, 'glyph-a1', 'color')).toBe(PALETTE.done)
    expect(await prop(ui, 'glyph-a2', 'color')).toBe(PALETTE.working)
    expect(await prop(ui, 'glyph-a3', 'color')).toBe(PALETTE.soon)
    expect(await prop(ui, 'right-a1', 'color')).toBe(PALETTE.done)
    expect(await prop(ui, 'right-a2', 'color')).toBe(PALETTE.working)
    for (const key of ['row-main', 'row-a1', 'row-a2', 'row-a3']) {
      expect((await text(ui, key)).length <= WIDTH).toBe(true)
    }
    expect(await text(ui, 'summary')).toBe('1 working · 1 idle · 1 done')
    expect(await text(ui, 'footnote')).toBe('* model set by mod: click the row for why')
    expect(await text(ui, 'footer')).toContain('esc close')
    await ui.unmount()
  }
})

test('pressing a name expands its details and pressing again folds them', async ($, on) => {
  const { agents } = world(on)
  await spawn($, { prompt: 'p' }) // a1
  agents.push(info('a1', 'build', 'completed'))
  await $.tool.call(inLoop('a1', { tool: 'Read', file_path: '/repo/hooks/register.tsx' } as const))
  await $.tool.call(inLoop('a1', { tool: 'Bash', command: 'false' } as const))
  await $.turn.complete({ ...finish('a1', words(120)), usage })

  const ui = await mount($)
  expect(await ui.find({ key: 'detail-a1' })).toBeUndefined()

  await ui.press({ key: 'open-a1' })
  expect(await text(ui, 'tokens-a1')).toContain('1.2k + 40k cached')
  expect(await text(ui, 'tools-a1')).toContain('2  ✗1')
  expect(await text(ui, 'report-a1')).toContain('120 words · long')
  expect(await text(ui, 'last-a1-0')).toContain('last    Read: register.tsx')
  expect(await text(ui, 'last-a1-1')).toContain('Bash: false  ✗')
  expect(await prop(ui, 'last-a1-1', 'color')).toBe(PALETTE.failed)

  await ui.press({ key: 'open-a1' })
  expect(await ui.find({ key: 'detail-a1' })).toBeUndefined()
})

test('the tree nests each agent under its parent, under main', async ($, on) => {
  const { agents } = world(on)
  agents.push(
    { ...info('a1', 'research', 'running'), name: 'research' },
    { ...info('a2', 'scan', 'running'), parentId: 'a1' },
    info('a3', 'build', 'running'),
    { ...info('a4', 'orphan', 'running'), parentId: 'gone' },
  )

  const ui = await mount($)
  expect(await text(ui, 'row-main')).toMatch(/^○ main\s+opus-5-5/)
  expect(await text(ui, 'row-a1')).toMatch(/^├ \S research/)
  expect(await text(ui, 'row-a2')).toMatch(/^│ └ \S scan/)
  expect(await text(ui, 'row-a3')).toMatch(/^├ \S build/)
  expect(await text(ui, 'row-a4')).toMatch(/^└ \S orphan/)
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
  expect(await text(ui, 'now-main')).toBe('  └ Bash: Run the tests')
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
  expect(await text(ui, 'now-a1')).toMatch(/Read: register\.tsx$/)
})

test('a tool call shows its clock while it runs, cut so the clock fits; the clock goes when it returns', async ($, on) => {
  const { agents, clock, release } = world(on)
  await spawn($, { prompt: 'p' }) // a1
  await spawn($, { prompt: 'p' }) // a2
  agents.push(info('a1', 'short', 'running'), info('a2', 'long', 'running'))
  const short = $.tool.call(inLoop('a1', { tool: 'Bash', command: 'sleep 90' } as const))
  const long = $.tool.call(inLoop('a2', { tool: 'Bash', command: 'sleep 90 && echo a command too long for the dock' } as const))
  await clock.set(42_000)

  let ui = await mount($)
  expect(await text(ui, 'now-a1')).toBe('│   └ Bash: sleep 90 · 0:42')
  expect(await text(ui, 'now-a2')).toMatch(/^    └ Bash: sleep 90 && .*… · 0:42$/)
  expect((await text(ui, 'now-a2')).length).toBe(WIDTH)
  await ui.unmount()

  release()
  await Promise.all([short, long])
  ui = await mount($)
  expect(await text(ui, 'now-a1')).toBe('│   └ Bash: sleep 90')
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
  expect(await text(ui, 'row-a1')).toMatch(/one.*0:30$/)
  await ui.unmount()

  await $.turn.complete({ ...finish('a1', 'ok'), durationMs: 45_000 })
  agents.splice(0, 1, info('a1', 'one', 'completed'))
  await clock.set(90_000)
  ui = await mount($)
  expect(await text(ui, 'row-a1')).toMatch(/✓ one.*0:45$/)
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
  expect(await text(ui, 'row-a1')).toMatch(/✗ err.*error$/)
  expect(await text(ui, 'row-a2')).toMatch(/✗ stop.*aborted$/)
  expect(await text(ui, 'row-a3')).toMatch(/✗ gone.*killed$/)
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
  expect(await text(ui, 'row-a2')).toMatch(/✗ broke.*error$/)
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
  expect(await text(ui, 'lane-a1')).toMatch(/^━{4}\s*$/)
  expect(await text(ui, 'lane-a2')).toMatch(/^\s*━{4}$/)
  expect((await text(ui, 'lane-a2')).length).toBe(8)
  expect(await text(ui, 'lane-main')).toMatch(/^\s*$/)
  expect(await prop(ui, 'lane-a1', 'color')).toBe(PALETTE.done)
  expect(await prop(ui, 'lane-a2', 'color')).toBe(PALETTE.working)
})

test('v swaps the rows for the box diagram and back; the boxes nest under main', async ($, on) => {
  const { agents } = world(on)
  agents.push({ ...info('a1', 'research', 'running'), name: 'research' }, { ...info('a2', 'scan', 'running'), parentId: 'a1' }, info('a3', 'build', 'completed'))

  const ui = await mount($)
  expect(await text(ui, 'view')).toBe('diagram')
  await ui.press({ key: 'view' })
  expect(await ui.find({ key: 'row-a1' })).toBeUndefined()
  expect(await ui.find({ key: 'footnote' })).toBeUndefined()
  expect(await text(ui, 'view')).toBe('lanes')
  const lines = await Promise.all(Array.from({ length: 13 }, (_, y) => text(ui, `dg-${y}`)))
  expect(lines[1]).toContain('main')
  expect(lines[6]).toMatch(/research.*build/)
  expect(lines[11]).toContain('scan')
  for (const l of lines) {
    expect(l.length <= WIDTH).toBe(true)
  }

  await ui.press({ key: 'view' })
  expect(await ui.find({ key: 'row-a1' })).toBeDefined()
})

const leaf = (label: string, isLive: boolean): Node => ({ label, glyph: '·', color: 'c', isLive, kids: [] })
const tree = (...kids: Node[]): Node => ({ label: 'main', glyph: '○', color: 'c', isLive: false, kids })
// The lit cells of a diagram, as "row:column".
const lit = (rows: { text: string; color: string }[][]) =>
  rows.flatMap((runs, y) => {
    const cells = runs.flatMap(r => [...r.text].map(() => r.color))
    return cells.flatMap((color, x) => (color === 'pulse' ? [`${y}:${x}`] : []))
  })

test('a line toward a working agent pulses away from main, one cell a frame; motion off holds the path lit', () => {
  // Two boxes of 16 under main: 33 columns, centered in 44 from column 5; main's center is column 21.
  const root = tree(leaf('done', false), leaf('live', true))
  const at = (frame: number | undefined) => diagram(root, 44, frame, 'line', 'pulse').rows

  expect(lit(at(0))).toEqual(['3:21', '4:24', '4:28'])
  expect(lit(at(1))).toEqual(['4:21', '4:25', '4:29'])
  expect([...(at(0)[4] ?? []).map(r => r.text).join('')][24]).toBe('━')

  // Motion off: the stub, the bus from main's center to the live box, and its joint, all lit; none toward the done box.
  const still = lit(at(undefined))
  expect(still).toContain('3:21')
  expect(still).toContain('5:30')
  expect(still.filter(c => c.startsWith('4:')).length).toBe(10)
  expect(still.some(c => c.startsWith('4:') && Number(c.split(':')[1]) < 21)).toBe(false)
})

test('a wide tree narrows its boxes to fit the pane, then cuts at its edge', () => {
  const kids = (n: number) => Array.from({ length: n }, (_, i) => leaf(`agent ${i}`, false))
  const width = (rows: { text: string }[][]) => Math.max(...rows.map(r => r.map(x => x.text).join('').length))

  const fits = diagram(tree(...kids(4)), 44, 0, 'line', 'pulse')
  expect(fits.isCut).toBe(false)
  expect(width(fits.rows) <= 44).toBe(true)

  const cut = diagram(tree(...kids(8)), 44, 0, 'line', 'pulse')
  expect(cut.isCut).toBe(true)
  expect(width(cut.rows)).toBe(44)
  expect(cut.rows.some(r => r.map(x => x.text).join('').endsWith('…'))).toBe(true)
})

// WCAG contrast: 4.5:1 is the floor for normal text.
test('every text color in the palette reads on its background', () => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const { bg, ...text } = PALETTE
  for (const [name, hex] of Object.entries(text)) {
    expect([name, (lum(hex) + 0.05) / (lum(bg) + 0.05) >= 4.5]).toEqual([name, true])
  }
})
