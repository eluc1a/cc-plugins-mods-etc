// Routing eval: for real subagent tasks, does Jev pick the tier the main loop picked, and does it beat the
// mod's old rule (Explore gets haiku, the rest inherit opus)?
//
// Cases: the Agent calls in ~/.claude/projects transcripts, Explore and general-purpose only, deduplicated,
// prompts that look like they hold a secret left out. A call that named a model is a labeled case; the rest
// only show what Jev would pick. The cases freeze on the first run in ~/.cache/jev-evals/route-cases.jsonl,
// so later runs compare; --rebuild mines them again. Jev answers each case twice, the tiers in order and
// reversed, since it leans toward the first option.
//
// Run: jev/run.sh route [--limit N] [--rebuild]
import { Glob } from 'bun'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { JEV_MODEL, MIN_CONFIDENCE, pick, question } from '../agent-board/hooks/route'
import type { Pick, Task, Tier } from '../agent-board/hooks/route'
import { ask, CACHE, pct, pool, quantile } from './client'

type Case = Task & { label?: Tier }
type Result = { c: Case; fwd?: Pick; rev?: Pick; ms: number; cost: number; error?: string }

const TIERS: Tier[] = ['haiku', 'sonnet', 'opus']
const RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2 }
const SECRET = /sk-[\w-]{16,}|ghp_\w{20,}|xox[abp]-|BEGIN [A-Z ]*PRIVATE KEY|(api[_-]?key|password|token)\s*[:=]\s*['"]?[\w-]{12,}/i
const ROUTED = ['Explore', 'general-purpose']
const tierOf = (model?: string) => TIERS.find(t => model?.includes(t))
// The old rule, and what the mod does now: Jev at or over the floor, else the old rule.
const rule = (c: Case): Tier => (c.subagentType === 'Explore' ? 'haiku' : 'opus')
const mod = (r: Result): Tier => (r.fwd !== undefined && r.fwd.confidence >= MIN_CONFIDENCE ? r.fwd.tier : rule(r.c))

async function mine(): Promise<Case[]> {
  const root = `${process.env.HOME}/.claude/projects`
  const seen = new Set<string>()
  const cases: Case[] = []
  for (const pattern of ['*/*.jsonl', '*/*/subagents/*.jsonl']) {
    for await (const f of new Glob(pattern).scan(root)) {
      for (const line of (await Bun.file(`${root}/${f}`).text()).split('\n')) {
        if (!line.includes('"tool_use"') || !(line.includes('"Agent"') || line.includes('"Task"'))) {
          continue
        }
        let d: any
        try {
          d = JSON.parse(line)
        } catch {
          continue
        }
        for (const b of d?.message?.content ?? []) {
          const i = b?.input ?? {}
          const prompt: string = i.prompt ?? ''
          const type: string = i.subagent_type ?? 'general-purpose'
          if (b?.type !== 'tool_use' || !['Agent', 'Task'].includes(b.name) || !ROUTED.includes(type)) {
            continue
          }
          if (prompt.trim() === '' || seen.has(prompt.slice(0, 200)) || SECRET.test(prompt)) {
            continue
          }
          seen.add(prompt.slice(0, 200))
          cases.push({ subagentType: type, description: i.description ?? '', prompt: prompt.slice(0, 4000), label: tierOf(i.model) })
        }
      }
    }
  }
  return cases
}

const args = process.argv.slice(2)
const at = args.indexOf('--limit')
const limit = at >= 0 ? Number(args[at + 1]) : Infinity
mkdirSync(CACHE, { recursive: true })
const file = `${CACHE}/route-cases.jsonl`
if (args.includes('--rebuild') || !existsSync(file)) {
  writeFileSync(file, `${(await mine()).map(c => JSON.stringify(c)).join('\n')}\n`)
}
const cases = (readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)) as Case[]).slice(0, limit)

console.log(`Asking Jev about ${cases.length} subagent tasks, twice each...`)
const results: Result[] = await pool(cases, 8, async c => {
  try {
    const [a, b] = await Promise.all([ask(question(c)), ask(question(c, [...TIERS].reverse()))])
    return { c, fwd: pick(a.text), rev: pick(b.text), ms: a.ms, cost: a.cost + b.cost }
  } catch (err) {
    return { c, ms: 0, cost: 0, error: String(err) }
  }
})

const ok = results.filter(r => r.fwd !== undefined)
const labeled = ok.filter(r => r.c.label !== undefined)
const share = (rs: Result[], f: (r: Result) => boolean) => (rs.length === 0 ? 0 : rs.filter(f).length / rs.length)
const cost = results.reduce((s, r) => s + r.cost, 0)
const ms = ok.map(r => r.ms)

console.log(`\nRouting eval · ${JEV_MODEL} · ${cases.length} tasks, ${labeled.length} labeled`)
console.log(`cost $${cost.toFixed(4)} · latency p50 ${quantile(ms, 0.5).toFixed(0)} ms, p95 ${quantile(ms, 0.95).toFixed(0)} ms · errors ${results.length - ok.length}`)

console.log(`\nAgreement with the tier the main loop chose (labeled tasks):`)
console.log(`  Jev alone              ${pct(share(labeled, r => r.fwd?.tier === r.c.label))}`)
console.log(`  mod now (Jev ≥ ${MIN_CONFIDENCE}, else rule) ${pct(share(labeled, r => mod(r) === r.c.label))}`)
console.log(`  old rule               ${pct(share(labeled, r => rule(r.c) === r.c.label))}`)
console.log(`  Jev cheaper than main  ${pct(share(labeled, r => RANK[r.fwd?.tier ?? 'haiku'] < RANK[r.c.label ?? 'haiku']))}`)
console.log(`  Jev pricier than main  ${pct(share(labeled, r => RANK[r.fwd?.tier ?? 'haiku'] > RANK[r.c.label ?? 'haiku']))}`)

console.log(`\nConfusion (rows: main loop chose, columns: Jev chose)`)
console.log(`          ${TIERS.map(t => t.padStart(7)).join('')}`)
for (const row of TIERS) {
  console.log(`  ${row.padEnd(8)}${TIERS.map(col => String(labeled.filter(r => r.c.label === row && r.fwd?.tier === col).length).padStart(7)).join('')}`)
}

console.log(`\nBy confidence (labeled)        share  agree`)
for (const [lo, hi] of [[0, MIN_CONFIDENCE], [MIN_CONFIDENCE, 0.7], [0.7, 0.9], [0.9, 1.01]] as const) {
  const band = labeled.filter(r => (r.fwd?.confidence ?? 0) >= lo && (r.fwd?.confidence ?? 0) < hi)
  const name = `${lo.toFixed(1)}–${Math.min(hi, 1).toFixed(1)}${hi <= MIN_CONFIDENCE ? ' (mod uses rule)' : ''}`
  console.log(`  ${name.padEnd(28)}${pct(band.length / Math.max(1, labeled.length))}  ${band.length === 0 ? '   —' : pct(share(band, r => r.fwd?.tier === r.c.label))}`)
}

console.log(`\nSame tier with the options reversed: ${pct(share(ok, r => r.fwd?.tier === r.rev?.tier))} of tasks`)
const free = ok.filter(r => r.c.label === undefined)
console.log(`Unlabeled tasks (the live mod routes these): ${TIERS.map(t => `${t} ${free.filter(r => r.fwd?.tier === t).length}`).join(' · ')}`)

const off = labeled.filter(r => r.fwd?.tier !== r.c.label).sort((a, b) => (b.fwd?.confidence ?? 0) - (a.fwd?.confidence ?? 0))
console.log(`\nDisagreements, most confident first (${off.length}; all in ${CACHE}/route-report.json):`)
for (const r of off.slice(0, 10)) {
  console.log(`  ${r.fwd?.confidence.toFixed(2)}  ${`${r.c.label}→${r.fwd?.tier}`.padEnd(13)} ${r.c.subagentType.padEnd(16)} ${r.c.description.slice(0, 50)}`)
}
for (const r of results.filter(r => r.error !== undefined).slice(0, 3)) {
  console.log(`  error: ${r.error?.slice(0, 160)}`)
}

writeFileSync(
  `${CACHE}/route-report.json`,
  JSON.stringify(results.map(r => ({ ...r, c: { ...r.c, prompt: r.c.prompt.slice(0, 400) } })), null, 1),
)
