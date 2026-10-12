# claude-mods

Claude Code mods (hook plugins), published as the `claude-mods` marketplace.

## Install

The repo is private: the machine needs git access to GitHub first (`gh auth login`, then `gh auth setup-git`, or an SSH key).

```
/plugin marketplace add eluc1a/cc-plugins-mods-etc
/plugin install relay@claude-mods
/plugin install agent-board@claude-mods
```

Update:

```
/plugin marketplace update claude-mods
/plugin update relay@claude-mods
/plugin update agent-board@claude-mods
```

## Plugins

### relay

Keeps a long task going across context resets. Arm it per session with `/relay on`.

- Past 180K context tokens, the model gets a soft stop: finish to the next breakpoint, wait for running subagents, write a handoff.
- Past 180K, new subagents from the main loop are denied. Running ones continue.
- `/clear` waits until no background agent is running, then the session restarts from the handoff.
- Up to 10 cycles. `RELAY: DONE` ends it.

Commands: `/relay on`, `/relay off`, `/relay now` (one handoff cycle at once).

### agent-board

`/board` opens a pane with a live tree of the session's agents: current tool, call times, fails, tokens.

- Lanes: an agent whose description starts with `Lane N: ` is grouped under a colored `Lane N` heading. The plugin adds this rule to the system prompt.
- Model routing: a spawn that names no model gets one from Jev (TypeSafe, through OpenRouter) when `OPENROUTER_API_KEY` is set in the environment or in a `.env` in the session's directory. Otherwise Explore agents get haiku and the rest inherit.
- `/agent-board:board-test <test>` launches cheap Haiku agents to exercise the pane. With no argument it lists the tests.

## Not in the marketplace

- `workbench/`: spend gate on paid commands, turn receipt on each turn. Load with `claude --plugin-dir workbench`.
- `jev/`: Jev experiments and evals. Run with `jev/run.sh`.

## Development

From the repo root:

```
claude plugin test <plugin>
bunx -p typescript tsc -p <plugin>
claude plugin validate <plugin>
claude plugin validate .
```

A change reaches marketplace installs only with a push and a `version` bump in that plugin's `.claude-plugin/plugin.json`.
