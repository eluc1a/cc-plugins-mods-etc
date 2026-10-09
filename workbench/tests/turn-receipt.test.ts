import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The engine beneath the receipt: tools, git status, and Claude Code's own TurnDuration line.
function world(on: On, git: { porcelain: string }) {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: git.porcelain, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.render', { component: 'TurnDuration' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['✻ Worked for 4m 12s'] })
  })
}

const done = { durationMs: 252_000, isAborted: false, turnId: 't1', reason: 'answer' } as const
const props = { word: 'Worked', durationMs: 252_000 } as const
const prompt = { text: 'go', wait: false, origin: { kind: 'composer' } } as const

async function line($: any, durationMs: number = props.durationMs) {
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', component: 'TurnDuration', props: { ...props, durationMs } })
  const texts = await ui.findAll({ type: 'Text' })
  return texts.map((t: { text: string }) => t.text).join('')
}

const edit = (file_path: string, extra = {}) => ({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b', ...extra }) as any
const bash = (command: string, extra = {}) => ({ tool: 'Bash', command, ...extra }) as any

test('counts files, commits, pushes and uncommitted; drawn beside the engine line', async ($, on) => {
  const git = { porcelain: ' M a.ts\n?? b.ts\n' }
  world(on, git)
  await $.prompt.submit(prompt)
  await $.tool.call(edit('/r/a.ts'))
  await $.tool.call(edit('/r/a.ts'))
  await $.tool.call({ tool: 'Write', file_path: '/r/b.ts', content: 'x' } as any)
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/r/n.ipynb', new_source: 'x' } as any)
  await $.tool.call(bash('git add -A && git commit -m x'))
  await $.turn.complete({ ...done, answer: 'Done.' })

  expect(await line($)).toBe('✻ Worked for 4m 12s · edited 3 files · 1 commit, not pushed · 2 uncommitted')
})

test('a push clears not pushed; zero groups are omitted', async ($, on) => {
  world(on, { porcelain: '' })
  await $.prompt.submit(prompt)
  await $.tool.call(bash('git commit -m x'))
  await $.tool.call(bash('git push'))
  await $.tool.call(bash('ls'))
  await $.turn.complete({ ...done, answer: 'Done.' })

  expect(await line($)).toBe('✻ Worked for 4m 12s · 1 commit')
})

test('prompt.submit resets the counters', async ($, on) => {
  world(on, { porcelain: '' })
  await $.prompt.submit(prompt)
  await $.tool.call(edit('/r/a.ts'))
  await $.turn.complete({ ...done, answer: 'Done.' })
  await $.prompt.submit(prompt)
  await $.turn.complete({ ...done, answer: 'Done.' })

  expect(await line($)).toBe('✻ Worked for 4m 12s')
})

test('events from a subagent are skipped', async ($, on) => {
  world(on, { porcelain: '' })
  await $.prompt.submit(prompt)
  await $.tool.call(edit('/r/a.ts', { agentId: 'sub-1' }))
  await $.tool.call(bash('git commit -m x', { agentId: 'sub-1' }))
  await $.turn.complete({ ...done, answer: 'Which one do you want?', agentId: 'sub-1' })

  expect(await line($)).toBe('✻ Worked for 4m 12s')
})

test('a failed command does not count', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'fatal', isError: true }) as any)
  world(on, { porcelain: '' })
  await $.prompt.submit(prompt)
  await $.tool.call(bash('git commit -m x'))
  await $.turn.complete({ ...done, answer: 'Done.' })

  expect(await line($)).toBe('✻ Worked for 4m 12s')
})

test('asks you 1 question when the last paragraph ends with a question mark', async ($, on) => {
  world(on, { porcelain: '' })
  await $.prompt.submit(prompt)
  await $.turn.complete({ ...done, answer: 'Is this fine? Maybe.\n\nShould I continue?\n' })
  expect(await line($)).toBe('✻ Worked for 4m 12s · asks you 1 question')

  await $.prompt.submit(prompt)
  await $.turn.complete({ ...done, answer: 'Should I continue?\n\nI will continue.' })
  expect(await line($)).toBe('✻ Worked for 4m 12s')
})

test('each row keeps the receipt of its own turn', async ($, on) => {
  world(on, { porcelain: '' })
  await $.prompt.submit(prompt)
  await $.tool.call(edit('/r/a.ts'))
  await $.turn.complete({ ...done, answer: 'Done.' })
  await $.prompt.submit(prompt)
  await $.tool.call(bash('git commit -m x && git push'))
  await $.turn.complete({ ...done, durationMs: 9_000, answer: 'Done.' })

  expect(await line($)).toBe('✻ Worked for 4m 12s · edited 1 file')
  expect(await line($, 9_000)).toBe('✻ Worked for 4m 12s · 1 commit')
  expect(await line($, 5_000)).toBe('✻ Worked for 4m 12s')
})
