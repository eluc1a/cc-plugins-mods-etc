import { expect, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

// The engine beneath the gate: the runner, the owner's answer, who is attached.
function world(on: On, owner: { choice: string; surfaces: RenderSurface[] }) {
  const seen = { cards: [] as string[], ran: [] as string[], argv: [] as string[][] }
  on('session.surfaces', () => ({ value: owner.surfaces }))
  on('process.run', ($, e) => {
    seen.argv.push([...e.argv])
    const rows = [1, 2, 3, 4, 5].map(i => ({ startedAt: '2026-10-03T10:00:00Z', updatedAt: `2026-10-03T10:0${i + 1}:00Z` }))
    return { value: { exitCode: 0, stdout: JSON.stringify(rows), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]?.question ?? ''
    seen.cards.push(question)
    return { result: { questions: e.questions, answers: { [question]: owner.choice } } } as never
  })
  on('tool.call', { tool: /^(Bash|mcp__)/ }, ($, e) => {
    seen.ran.push(e.tool)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } } as never
  })
  return seen
}

const owner = (choice = 'Run once', surfaces: RenderSurface[] = ['terminal']) => ({ choice, surfaces })
const pr = { tool: 'Bash', command: 'gh pr create --base dev --head fix/x' } as const

test('hold and Run once runs the call after one card with the command, the median and the checks', async ($, on) => {
  const seen = world(on, owner())
  const ran = await $.tool.call(pr)
  expect(ran.deny).toBeUndefined()
  expect(seen.ran).toEqual(['Bash'])
  expect(seen.cards.length).toBe(1)
  expect(seen.cards[0]).toContain('gh pr create --base dev --head fix/x')
  expect(seen.cards[0]).toContain('CI on dev')
  expect(seen.cards[0]).toContain('median of last 5 runs')
  expect(seen.cards[0]).toContain('4 runner-minutes')
  expect(seen.cards[0]).toContain('pip-audit ✗ not run')
  expect(seen.argv[0]?.slice(0, 3)).toEqual(['gh', 'run', 'list'])
})

test('Cancel denies with the reason and runs nothing', async ($, on) => {
  const seen = world(on, owner('Cancel'))
  const ran = await $.tool.call(pr)
  expect(ran.deny).toBe(`The owner cancelled ${pr.command} at the spend gate. Do not retry it. Ask the owner what to do next.`)
  expect(seen.ran).toEqual([])
})

test('a plain command passes with no card', async ($, on) => {
  const seen = world(on, owner())
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 3' })
  expect(seen.cards).toEqual([])
  expect(seen.ran).toEqual(['Bash'])
})

test('a Higgsfield generate call holds with the rule line', async ($, on) => {
  const seen = world(on, owner())
  const params = { model: 'seedance_2_5', aspect_ratio: '9:16', duration: 10, prompt: 'x'.repeat(100) }
  await $.tool.call({ tool: 'mcp__claude_ai_Higgsfield__generate_video', params })
  expect(seen.cards.length).toBe(1)
  expect(seen.cards[0]).toContain('seedance_2_5 · 9:16 · 10 s')
  expect(seen.cards[0]).toContain('x'.repeat(79) + '…')
  expect(seen.cards[0]).not.toContain('x'.repeat(81))
  expect(seen.cards[0]).toContain('Rule  One yes for each generation (owner, 27 Sep)')
  await $.tool.call({ tool: 'mcp__claude_ai_Higgsfield__balance', params: {} })
  expect(seen.cards.length).toBe(1)
})

test('with no one attached the gate denies with the spend guard text', async ($, on) => {
  const seen = world(on, owner('Run once', []))
  const ran = await $.tool.call(pr)
  expect(ran.deny).toContain('SPEND GUARD: this command spends the user')
  expect(ran.deny).toContain('Do not retry')
  expect(ran.deny).not.toContain('re-run the identical command')
  expect(seen.cards).toEqual([])
  expect(seen.ran).toEqual([])
})

test('rm of a film under video-gen denies', async ($, on) => {
  const seen = world(on, owner())
  for (const command of ['rm /home/elucia/dev/video-gen/out/a.mp4', 'git rm ~/dev/video-gen/b.mov']) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBe('Owner rule: never delete generated films.')
  }
  expect((await $.tool.call({ tool: 'Bash', command: 'rm /home/elucia/dev/video-gen/notes.txt' })).deny).toBeUndefined()
  expect(seen.cards).toEqual([])
})

test('the card shows pip-audit and pytest from this session', async ($, on) => {
  const seen = world(on, owner())
  await $.tool.call({ tool: 'Bash', command: 'pip-audit -r req.txt' })
  await $.tool.call({ tool: 'Bash', command: 'cd api && pytest -q' })
  await $.tool.call(pr)
  expect(seen.cards[0]).toContain('pip-audit ✓ this session')
  expect(seen.cards[0]).toContain('pytest ✓ this session')
})
