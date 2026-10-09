// File-ranking eval: for past commits, does a ranker put the files the commit changed in its top 10?
// The task is the commit subject; the candidates are the code files at the parent commit; the gold files are
// the ones the commit modified (a file it added was not there to find). Every method gets the same keyword
// shortlist of 255, so the table compares rankers, and the shortlist line shows what the prefilter loses.
//
// Run: jev/run.sh files-eval [--repos ~/dev/a,~/dev/b] [--n 25] [--no-haiku]
import { mkdirSync, writeFileSync } from 'node:fs'

import { CACHE, pct, pool, quantile } from './client'
import { haikuRank, isCode, jevRank, keywordRank, MAX_OPTIONS } from './files'
import type { File, Ranked } from './files'

type Case = { repo: string; sha: string; query: string; gold: string[]; files: File[] }

const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const home = process.env.HOME ?? ''
const repos = (flag('--repos') ?? `${home}/dev/jina-clone,${home}/dev/themorningfox`).split(',').map(r => r.replace(/^~/, home))
const n = Number(flag('--n') ?? 25)
const withHaiku = !args.includes('--no-haiku')
const NOISE = /^(merge|revert|translations|bump|wip|release|docs[:(]|chore\(deps)/i

// The text of each path at `rev`, through one `git cat-file --batch`.
async function blobs(repo: string, rev: string, paths: string[]): Promise<File[]> {
  const proc = Bun.spawn(['git', '-C', repo, 'cat-file', '--batch'], { stdin: 'pipe', stdout: 'pipe' })
  proc.stdin.write(paths.map(p => `${rev}:${p}\n`).join(''))
  proc.stdin.end()
  const buf = Buffer.from(await new Response(proc.stdout).arrayBuffer())
  const out: File[] = []
  let pos = 0
  for (const path of paths) {
    const nl = buf.indexOf(10, pos)
    const header = buf.toString('utf8', pos, nl)
    pos = nl + 1
    const size = Number(header.split(' ')[2])
    if (header.endsWith('missing') || Number.isNaN(size)) {
      continue
    }
    out.push({ path, text: buf.toString('utf8', pos, pos + Math.min(size, 200_000)) })
    pos += size + 1
  }
  return out
}

async function cases(repo: string): Promise<Case[]> {
  const out: Case[] = []
  const log = (await Bun.$`git -C ${repo} log --no-merges --format=%H%x09%P%x09%s -n 2000`.text()).trim().split('\n')
  for (const line of log) {
    const [sha = '', parents = '', query = ''] = line.split('\t')
    const parent = parents.split(' ')[0]
    if (out.length >= n || parent === undefined || parent === '' || query.length < 20 || NOISE.test(query)) {
      continue
    }
    const changed = (await Bun.$`git -C ${repo} diff --name-status --no-renames ${parent} ${sha}`.text()).trim().split('\n')
    const code = changed.map(l => l.split('\t')).filter(([, p]) => p !== undefined && isCode(p))
    const gold = code.filter(([s]) => s === 'M').map(([, p]) => p as string)
    if (gold.length === 0 || code.length > 6) {
      continue
    }
    const paths = (await Bun.$`git -C ${repo} ls-tree -r --name-only ${parent}`.text()).split('\n').filter(isCode)
    out.push({ repo: repo.split('/').pop() ?? repo, sha: sha.slice(0, 9), query, gold, files: await blobs(repo, parent, paths) })
  }
  return out
}

const all = (await Promise.all(repos.map(cases))).flat()
const methods: Record<string, (c: Case) => Promise<Ranked>> = {
  keyword: async c => ({ ranked: keywordRank(c.query, c.files).map(f => f.path), cost: 0, ms: 0 }),
  'jev paths': c => jevRank(c.query, c.files, false),
  'jev cards': c => jevRank(c.query, c.files, true),
  ...(withHaiku ? { 'haiku cards': (c: Case) => haikuRank(c.query, c.files) } : {}),
}
const names = Object.keys(methods)
console.log(`Ranking files for ${all.length} past commits with: ${names.join(', ')}...`)

const rows = await pool(all, 4, async c => {
  const shortlist = new Set(keywordRank(c.query, c.files).slice(0, MAX_OPTIONS).map(f => f.path))
  const got = await Promise.all(
    names.map(m => (methods[m] as (c: Case) => Promise<Ranked>)(c).catch(err => ({ ranked: [], cost: 0, ms: 0, error: String(err) }))),
  )
  return { c, inShortlist: c.gold.some(g => shortlist.has(g)), got: Object.fromEntries(names.map((m, i) => [m, got[i] as Ranked & { error?: string }])) }
})

const hit = (r: (typeof rows)[number], m: string, k: number) => r.c.gold.some(g => r.got[m]?.ranked.slice(0, k).includes(g))
const share = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length / Math.max(1, rows.length)
const byRepo = [...new Set(all.map(c => c.repo))].map(r => `${r} ${all.filter(c => c.repo === r).length}`).join(', ')

console.log(`\nFile-ranking eval · ${rows.length} past commits (${byRepo}) · gold = the code files each commit modified`)
console.log(`Keyword shortlist of ${MAX_OPTIONS} holds a gold file in ${pct(share(r => r.inShortlist))} of commits\n`)
console.log(`  method        hit@1  hit@5  hit@10   $/query    p50 ms  errors`)
for (const m of names) {
  const cost = rows.reduce((s, r) => s + (r.got[m]?.cost ?? 0), 0) / Math.max(1, rows.length)
  const ms = quantile(rows.map(r => r.got[m]?.ms ?? 0), 0.5)
  const errors = rows.filter(r => r.got[m]?.error !== undefined).length
  console.log(
    `  ${m.padEnd(12)}  ${pct(share(r => hit(r, m, 1)))}   ${pct(share(r => hit(r, m, 5)))}    ${pct(share(r => hit(r, m, 10)))}   ${cost.toFixed(5).padStart(8)}  ${ms.toFixed(0).padStart(7)}  ${errors}`,
  )
}
for (const r of rows.flatMap(r => names.map(m => r.got[m]?.error)).filter(Boolean).slice(0, 3)) {
  console.log(`  error: ${r?.slice(0, 160)}`)
}

mkdirSync(CACHE, { recursive: true })
writeFileSync(
  `${CACHE}/files-report.json`,
  JSON.stringify(
    rows.map(r => ({ repo: r.c.repo, sha: r.c.sha, query: r.c.query, gold: r.c.gold, inShortlist: r.inShortlist, top10: Object.fromEntries(names.map(m => [m, r.got[m]?.ranked.slice(0, 10)])) })),
    null,
    1,
  ),
)
console.log(`\nPer-commit top 10s: ${CACHE}/files-report.json`)
