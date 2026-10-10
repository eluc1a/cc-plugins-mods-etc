---
name: board-test
description: Launch cheap Haiku subagents that exercise the /board pane (agent-board mod) - staggered finishes, bursts, tool fails, kills, resumes, nesting. User-invoked only.
disable-model-invocation: true
argument-hint: "[stagger|burst|fail|cancel|resume|haiku-default|tree|nest ...]"
---

# Board test

Throwaway agents for testing the `/board` pane. What they do does not matter, only how the board shows them.

Arguments: `$ARGUMENTS`

## No arguments

Print the test table below (name, agents, what to watch) and ask which test to run. Launch nothing.

## Tests

| Test | Agents | Watch on the board |
|---|---|---|
| `stagger` | 3, wait 10s / 20s / 30s | finish one at a time, in that order |
| `burst` | 5, all wait 15s | 5 working at once, then 5 done within a few seconds |
| `fail` | 1, runs 4 tools, 2 fail | tools `4  ✗2`, agent still ends done, not failed |
| `cancel` | 2, wait 10s and 90s | when the 10s agent reports, stop the 90s one: it shows `✗ killed` |
| `resume` | 1, wait 5s, then resumed for 5s more | same row goes done/idle, working, done again |
| `haiku-default` | 1 Explore, NO model param | footer shows `* haiku: set by mod` |
| `tree` | 1 parent + 2 children | 2 child rows nested under the parent. Main gets 1 message, from the parent |
| `nest` | 2 parents started 5s apart, 3 children: P1 has 1, P2 has 2 started 4s apart | 1 row under P1, 2 rows under P2, rows appear at different times. Main gets 2 messages, none from a child |

## Run

1. Before launching, state the test, the agent count, and the cost: about 48k Haiku tokens per agent (mostly startup context).
2. Launch all agents of one test in a single message so they start together. Exception: `nest`. Several tests: run them in the order given, one test at a time.
3. Every Agent call: `subagent_type: "general-purpose"`, `model: "haiku"`, `description: "board-test <test> <detail>"` (the board shows the description). Exception: `haiku-default`.
4. Wait command for every agent: `python3 -c 'import time; time.sleep(N)'`. Foreground `sleep` can be blocked. Keep N at 90 or less (Bash timeout is 120s).
5. Every agent that main launches gets a prompt in this shape:

   ```
   This is a board test. Do only these steps, then stop.
   1. <steps for this test>
   N. Send your report to "main" with SendMessage: "<test> <detail>: done" plus anything that failed. Under 20 words.
   ```

6. Nested tests (`tree`, `nest`): a child reports only to its parent, never to main (its grandparent).
   - Put each child prompt in a labeled block at the end of the parent prompt (`CHILD PROMPT A:` then the text between `<<<` and `>>>`). Tell the parent that the block is text for the Agent tool, not steps for the parent. Without this, Haiku takes the child steps as its own and stops early.
   - Parent steps after the spawns: wait, then wait for the final reply of every child (if one has not arrived, end the turn: the task notification wakes the parent), then report to main with each child reply included.
   - Child prompt shape. No numbered steps. Keep the word `SendMessage`: without it, `~/.claude/hooks/require-agent-return.sh` appends a report-to-main line.

     ```
     This is a board test. Run this Bash command once: python3 -c 'import time; time.sleep(N)'. Then stop and give a final reply of under 15 words: "<test> <detail>: done" plus anything that failed. Do not use SendMessage. Your final reply returns to your parent.
     ```

### Per-test steps

- **stagger**: agent K waits 10/20/30s.
- **burst**: each of 5 agents waits 15s.
- **fail**: wait 5s. Read `/nonexistent/board-test.txt` (fails). Bash `exit 3` (fails). Wait 5s. Tell the agent the 2 fails are expected and to keep going.
- **cancel**: agent A waits 10s, agent B waits 90s. When A's report arrives, load `TaskStop` with ToolSearch (`select:TaskStop`) and stop B.
- **resume**: wait 5s, report. After the report arrives, SendMessage the same agent: "Wait 5 more seconds with the same command, then report again to main."
- **haiku-default**: `subagent_type: "Explore"` and omit `model` (the mod must set haiku). Task: list the file names in `${CLAUDE_PLUGIN_ROOT}/hooks` and report them.
- **tree**: the parent spawns 2 children in one message (each waits 10s), then waits 20s so the tree stays visible, then waits for both child replies and reports. If the parent has no Agent tool, it reports that instead.
- **nest**: launch P1, run the wait command in main for 5s, then launch P2.
  - P1: wait 2s, spawn P1.a (waits 9s), wait 12s, then wait for the reply and report.
  - P2: spawn P2.a (waits 13s), wait 4s, spawn P2.b (waits 5s), wait 10s, then wait for both replies and report with the order they arrived in.
  - Pass: main gets exactly 2 messages (P1, P2), and each one includes its children's replies.

## Report

When every agent has finished, give one table: agent, expected board state, total time, tokens (from the task notifications). A child's notification goes to its parent, so for a child write `not reported to main`. The order in which a parent lists child replies is not reliable (replies can arrive together): use the board for the finish order. Then ask the user if the board matched.
