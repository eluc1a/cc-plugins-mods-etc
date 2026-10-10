// The state contract of the agent-board mod: one record per agent loop,
// keyed by agentId, the main loop under 'main', and the board's own view.

// One recent tool call of an agent, by its tool_use_id: when it started, and when it returned.
export type Call = { id: string; label: string; isError?: boolean; at?: number; end?: number }

export type AgentStat = {
  model?: string
  // The mod set the model: Jev's pick, or its own rule when Jev did not answer.
  isStar?: boolean
  // Who picked the model and why, as the expanded row shows it: "jev haiku at 0.93", "haiku, jev: timeout".
  route?: string
  tools: number
  fails: number
  tool?: string
  last: Call[]
  at: number
  isDone: boolean
  report?: number
  // New tokens (input, output, cache writes) apart from cache reads, which cost a tenth.
  tokens: number
  cached: number
  // Time of the finished turns, plus the start of the one that runs now.
  ms: number
  since?: number
  // When the board first saw the agent run: its spawn, else its first tool call. The time lanes start here.
  start?: number
  // turn.complete's reason; the contract may not import, so the union is spelled here.
  end?: 'answer' | 'aborted' | 'refusal' | 'error'
  // When a tool call failed or the agent returned: the row flashes for a second.
  flashAt?: number
  // The agent sent a message to main: its row shows ✉, yellow when the agent is nested and so skipped its parent.
  isToMain?: boolean
  // The agent's list entry, kept so its row outlives the engine's task.
  info?: { description: string; type: string; name?: string; parentId?: string }
}

// Which rows are expanded, whether returned agents hide, whether motion is off, which returned agents `c` cleared,
// and whether `v` shows the box diagram instead of the rows. `cleared` and `diagram` are absent from an older save.
export type BoardView = { open: string[]; hideDone: boolean; still: boolean; cleared?: string[]; diagram?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'agent-board': { agents: Record<string, AgentStat>; view: BoardView }
  }
}
