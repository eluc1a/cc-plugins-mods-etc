// The state contract of the workbench mod. Each feature owns the keys
// under its own marker line, and each key starts with the feature prefix.

// types: spend gate
export type GateChecks = { pipAudit: number; pytest: number }

// types: turn receipt

declare module 'claude-code' {
  interface PluginState {
    workbench: {
      // keys: spend gate (prefix gate)
      gateChecks: GateChecks
      // keys: turn receipt (prefix receipt)
    }
  }
}
