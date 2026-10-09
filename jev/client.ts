// One Jev request through OpenRouter, timed and priced. The evals and the jev-files CLI share it.
import { JEV_URL } from '../agent-board/hooks/route'

export type Asked = { body: any; text: string; ms: number; cost: number }

export async function ask(request: object, tries = 4): Promise<Asked> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) {
    throw new Error('OPENROUTER_API_KEY is not set: run through jev/run.sh, or export it')
  }
  for (let i = 0; ; i++) {
    const t0 = performance.now()
    const res = await fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    const text = await res.text()
    const ms = performance.now() - t0
    // 429 and 529 are the docs' "back off and retry".
    if ((res.status === 429 || res.status >= 500) && i < tries - 1) {
      await Bun.sleep(500 * 2 ** i)
      continue
    }
    if (!res.ok) {
      throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    const body = JSON.parse(text)
    return { body, text, ms, cost: body.usage?.cost ?? 0 }
  }
}

// Runs fn over items, n at a time, and keeps their order.
export async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

export const pct = (x: number) => `${(100 * x).toFixed(0)}%`.padStart(4)

export function quantile(xs: number[], q: number) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : (s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0)
}

export const CACHE = `${process.env.HOME}/.cache/jev-evals`
