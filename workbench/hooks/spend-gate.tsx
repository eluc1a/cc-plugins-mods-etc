import type { EngineInterface, On } from 'claude-code'

const SPEND = /\bgh\s+(pr\s+(create|merge)|run\s+rerun|workflow\s+run)\b/
const FILM = /\b(git\s+)?rm\b.*\/dev\/video-gen\/.*\.(mp4|mov|webm|mkv)\b/

// The text of spend-guard.sh, shown when no one is attached to answer. Its retry line is
// replaced: with no one attached, the gate denies every retry.
const UNATTENDED = `SPEND GUARD: this command spends the user's money (CI minutes, deploy, or provider budget).
The user has said: "do you not care about my money that you're wasting?"
Before you run it again, do all of this in your reply to the user:
  1. State exactly what this triggers (which workflows / deploys) and the rough cost.
  2. Confirm every pending change is batched into this one PR. If not, batch first.
  3. Confirm a local check cannot answer the same question.
  4. Confirm the user asked for this spend, or ask them now.
No one is attached to approve it now, so the spend gate denies every retry. Do not retry. Stop and report this to the user.`

function triggers(command: string) {
  if (/\bpr\s+create\b/.test(command)) return `CI on ${command.match(/--base[ =](\S+)/)?.[1] ?? 'the PR base'}`
  if (/\bpr\s+merge\b/.test(command)) return 'merge and any deploy on the base branch'
  if (/\brun\s+rerun\b/.test(command)) return 'CI rerun'
  return 'workflow dispatch'
}

async function medianMinutes($: EngineInterface) {
  try {
    const ran = await $.process.run(['gh', 'run', 'list', '--limit', '5', '--json', 'startedAt,updatedAt'])
    const rows = JSON.parse(ran.stdout) as { startedAt: string; updatedAt: string }[]
    const minutes = rows.map(r => (Date.parse(r.updatedAt) - Date.parse(r.startedAt)) / 60_000).sort((a, b) => a - b)
    if (ran.exitCode !== 0 || minutes.length === 0 || minutes.some(Number.isNaN)) return 'unknown'
    return `about ${Math.round(minutes[Math.floor(minutes.length / 2)] ?? 0)} runner-minutes (median of last 5 runs)`
  } catch {
    return 'unknown'
  }
}

async function ghCard($: EngineInterface, command: string) {
  const { value } = await $.state.get({ plugin: 'workbench', key: 'gateChecks' })
  const mark = (n: number | undefined) => ((n ?? 0) > 0 ? '✓ this session' : '✗ not run')
  return [
    `Spend check   ${command}`,
    `Triggers      ${triggers(command)} · ${await medianMinutes($)}`,
    `Checked       pip-audit ${mark(value?.pipAudit)} · pytest ${mark(value?.pytest)}`,
    'Run it once?',
  ].join('\n')
}

function higgsfieldCard(params: unknown) {
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>
  const prompt = String(p.prompt ?? '')
  const cut = prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt
  return [
    `Paid generation   ${[p.model ?? '?', p.aspect_ratio ?? '?', p.duration === undefined ? '?' : `${p.duration} s`].join(' · ')}`,
    `Prompt            "${cut}"`,
    'Rule  One yes for each generation (owner, 27 Sep)',
    'Run it once?',
  ].join('\n')
}

// Asks the owner once. Anything but "Run once" (Cancel, free text, a dismissed card) cancels.
async function hold<E>($: EngineInterface, card: string, what: string, run: () => Promise<E>) {
  if ((await $.session.surfaces()).length === 0) return { deny: UNATTENDED }
  const answer = await $.ui.ask(card, { options: ['Run once', 'Cancel'], header: 'Spend check' }).catch(() => 'Cancel')
  if (answer === 'Run once') return run()
  return { deny: `The owner cancelled ${what} at the spend gate. Do not retry it. Ask the owner what to do next.` }
}

async function countCheck($: EngineInterface, name: 'pipAudit' | 'pytest') {
  const { value = { pipAudit: 0, pytest: 0 } } = await $.state.get({ plugin: 'workbench', key: 'gateChecks' })
  await $.state.set({ plugin: 'workbench', key: 'gateChecks' }, { ...value, [name]: value[name] + 1 })
}

export function spendGate(on: On) {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (FILM.test(e.command)) return { deny: 'Owner rule: never delete generated films.' }
    if (SPEND.test(e.command)) return hold($, await ghCard($, e.command), e.command, () => next(e))

    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      if (/\bpip-audit\b/.test(e.command)) await countCheck($, 'pipAudit')
      if (/\bpytest\b/.test(e.command)) await countCheck($, 'pytest')
    }
    return ran
  })

  on('tool.call', { tool: /^mcp__claude_ai_Higgsfield__.*generate/ }, async ($, e, next) =>
    hold($, higgsfieldCard((e as { params?: unknown }).params), e.tool, () => next(e)),
  )
}
