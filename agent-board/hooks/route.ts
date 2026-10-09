// Jev picks the model of a subagent that names none: one Choice question over three tiers.
// No engine here, so evals/route.eval.ts asks Jev the same question the mod asks.

export const JEV_URL = 'https://openrouter.ai/api/v1/systemone'
// Pinned, so an eval run and the live mod ask the same model.
export const JEV_MODEL = 'typesafe/jev-1.13'
// Under this confidence the mod keeps its own rule. The routing eval prints accuracy per confidence band.
export const MIN_CONFIDENCE = 0.5
// Jev reads worse as unrelated state grows (its docs, "jaggedness"): the head of a prompt states the task.
const PROMPT_CHARS = 4000

export type Tier = 'haiku' | 'sonnet' | 'opus'
export type Pick = { tier: Tier; confidence: number }

// "Model economy" in ~/.claude/CLAUDE.md, one rubric line per tier.
export const TIERS: Record<Tier, string> = {
  haiku:
    'Read-heavy work where only the conclusion matters: look something up, list or search files, search the web, read logs or docs, run a fixed command and report. No design and no code edits.',
  sonnet:
    'Needs judgment: review or compare code, debug a failure, research with trade-offs, write or edit a contained piece of code, follow a written plan.',
  opus: 'Hard, open-ended reasoning: design an architecture, write a plan or a spec, build a large feature across many files, find a subtle root cause.',
}

export type Task = { subagentType: string; description: string; prompt: string }

// Jev leans toward the first option (its docs, "Choice option order"): the eval asks again in reverse.
export function question(t: Task, order: Tier[] = ['haiku', 'sonnet', 'opus']) {
  return {
    model: JEV_MODEL,
    state: { agent_type: t.subagentType, description: t.description, task: t.prompt.slice(0, PROMPT_CHARS) },
    questions: {
      tier: {
        type: 'choice',
        instructions: 'Which is the cheapest model tier that can do `task` well?',
        criteria: Object.fromEntries(order.map(tier => [tier, TIERS[tier]])),
      },
    },
  }
}

// The tier Jev chose, or undefined for a reply that is not a usable answer.
export function pick(body: string): Pick | undefined {
  try {
    const a = JSON.parse(body)?.answers?.tier
    const tier = typeof a?.choice === 'string' && a.choice in TIERS ? (a.choice as Tier) : undefined
    return tier !== undefined && typeof a.confidence === 'number' ? { tier, confidence: a.confidence } : undefined
  } catch {
    return undefined
  }
}
