#!/usr/bin/env bash
# One entry point for the Jev experiments. The OpenRouter key comes from OPENROUTER_API_KEY, else from
# $JEV_ENV (default ~/dev/tmp/.env).
#
#   jev/run.sh test                                      agent-board unit tests: offline, free
#   jev/run.sh route [--limit N] [--rebuild]             routing eval: about $0.015
#   jev/run.sh files-eval [--n 25] [--repos a,b] [--no-haiku]
#                                                        file eval: about $0.09, $0.02 with --no-haiku
#   jev/run.sh files "<task>" [repo dir]                 rank a repo's files for a task: about $0.0003
#   jev/run.sh all                                       test, then both evals: about $0.11
#
# Reports go to ~/.cache/jev-evals/.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bun=${BUN:-$HOME/.bun/bin/bun}
env_file=${JEV_ENV:-$HOME/dev/tmp/.env}
env_args=()
[[ -f $env_file ]] && env_args=(--env-file="$env_file")

run() { "$bun" "${env_args[@]}" "$here/$1" "${@:2}"; }

case ${1:-} in
  test) claude plugin test "$here/../agent-board" ;;
  route) run route.eval.ts "${@:2}" ;;
  files-eval) run files.eval.ts "${@:2}" ;;
  files) run files.ts "${@:2}" ;;
  all)
    claude plugin test "$here/../agent-board"
    run route.eval.ts
    run files.eval.ts
    ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
