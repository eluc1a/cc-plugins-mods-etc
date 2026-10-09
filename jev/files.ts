// jev-files: rank the files of a repo for a task, so an agent reads 10 files instead of grepping 100.
// Keyword search keeps the 255 best candidates (a Jev Choice holds 255 options at most), then Jev picks
// among them. The eval (files.eval.ts) runs the same functions on past commits.
//
// Run: jev/run.sh files "where does the spend gate decide to deny?" [repo dir]
import { JEV_MODEL } from '../agent-board/hooks/route'
import { ask } from './client'

export type File = { path: string; text: string }
export type Ranked = { ranked: string[]; probs?: Record<string, number>; cost: number; ms: number }

export const MAX_OPTIONS = 255
const CARD_CHARS = 200
// Jev takes 32k prompt tokens: keep the options under about 24k at 3 characters a token.
const OPTION_CHARS = 72_000
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|cs|php|sh|sql|toml|ya?ml|css|scss|html|vue|svelte)$/
const SKIP = /(^|\/)(node_modules|dist|build|vendor|\.next|__pycache__)\/|\.min\.|lock\./
const STOP = new Set(
  'the and for with from into via not add fix feat refactor test tests docs chore use make when its are was has this that then than all per new can should does what where which how why'.split(' '),
)

export const isCode = (path: string) => CODE.test(path) && !SKIP.test(path)

export function terms(query: string) {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOP.has(t)))]
}

// The free baseline, and the prefilter: a term in the path counts 3, each term's hits in the text count log2(1 + n).
export function keywordRank(query: string, files: File[]) {
  const ts = terms(query)
  const score = (f: File) => {
    const path = f.path.toLowerCase()
    const text = f.text.toLowerCase()
    return ts.reduce((s, t) => s + (path.includes(t) ? 3 : 0) + Math.log2(1 + text.split(t).length - 1), 0)
  }
  return files.map(f => ({ f, s: score(f) })).sort((a, b) => b.s - a.s).map(x => x.f)
}

// What Jev reads about a file besides its path: the first comment line and the names it defines.
export function card(f: File) {
  const lines = f.text.split('\n')
  const note = lines.find(l => /^\s*(\/\/|#|\/\*|\*|""")\s*\w/.test(l))?.replace(/^\s*(\/\/|#|\/\*+|\*|""")\s*/, '').trim()
  const names = [...f.text.matchAll(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|def|interface|type|struct|fn|func|const|enum)\s+([A-Za-z_]\w*)/gm)]
    .map(m => m[1])
    .slice(0, 12)
  return [note, names.length > 0 ? `defines ${names.join(', ')}` : undefined].filter(Boolean).join('. ').slice(0, CARD_CHARS) || null
}

const shortlist = (query: string, files: File[]) => keywordRank(query, files).slice(0, MAX_OPTIONS)

// Jev's probability per candidate, best first; ties keep the keyword order.
export async function jevRank(query: string, files: File[], withCards = true): Promise<Ranked> {
  const cands = shortlist(query, files)
  const budget = Math.floor(OPTION_CHARS / Math.max(1, cands.length)) - 60
  const criteria = Object.fromEntries(cands.map(f => [f.path, withCards ? (card(f)?.slice(0, Math.max(0, budget)) ?? null) : null]))
  const { body, cost, ms } = await ask({
    model: JEV_MODEL,
    state: { task: query },
    questions: { file: { type: 'choice', instructions: 'Which file most likely needs to be read or changed to do `task`?', criteria } },
  })
  const probs: Record<string, number> = body.answers.file.probabilities
  const order = new Map(cands.map((f, i) => [f.path, i]))
  const ranked = cands.map(f => f.path).sort((a, b) => (probs[b] ?? 0) - (probs[a] ?? 0) || (order.get(a) ?? 0) - (order.get(b) ?? 0))
  return { ranked, probs, cost, ms }
}

// The baseline Jev must beat: Haiku reads the same shortlist and the same cards.
export async function haikuRank(query: string, files: File[]): Promise<Ranked> {
  const cands = shortlist(query, files)
  const list = cands.map(f => `${f.path}${card(f) ? `: ${card(f)}` : ''}`).join('\n')
  const t0 = performance.now()
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'anthropic/claude-haiku-5.5',
      // Haiku 5.5 thinks first: a small cap can end the reply before the list.
      max_tokens: 2000,
      usage: { include: true },
      messages: [
        {
          role: 'user',
          content: `Task: ${query}\n\nCandidate files (path: summary):\n${list}\n\nReturn the 10 files most likely to be read or changed to do the task, most likely first, as a JSON array of paths. Output only the JSON array.`,
        },
      ],
    }),
  })
  const body: any = await res.json()
  const ms = performance.now() - t0
  const text: string = body.choices?.[0]?.message?.content ?? ''
  let ranked: unknown
  try {
    ranked = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1))
  } catch {}
  if (!Array.isArray(ranked)) {
    throw new Error(`Haiku gave no list (HTTP ${res.status}, finish ${body.choices?.[0]?.finish_reason}): ${text.slice(0, 120)}`)
  }
  return { ranked: ranked.filter(p => typeof p === 'string'), cost: body.usage?.cost ?? 0, ms }
}

if (import.meta.main) {
  const [query, dir = '.'] = process.argv.slice(2)
  if (!query) {
    console.error('usage: jev/run.sh files "<task>" [repo dir]')
    process.exit(2)
  }
  const paths = (await Bun.$`git -C ${dir} ls-files --cached --others --exclude-standard`.text()).split('\n').filter(isCode)
  const files = await Promise.all(paths.map(async path => ({ path, text: await Bun.file(`${dir}/${path}`).text().catch(() => '') })))
  const { ranked, probs, cost, ms } = await jevRank(query, files)
  for (const p of ranked.slice(0, 10)) {
    console.log(`${(probs?.[p] ?? 0).toFixed(2)}  ${p}`)
  }
  console.error(`${files.length} files, ${Math.min(files.length, MAX_OPTIONS)} asked · $${cost.toFixed(5)} · ${ms.toFixed(0)} ms`)
}
