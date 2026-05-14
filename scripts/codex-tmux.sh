#!/usr/bin/env bash

# Source this file to shadow `codex` with the tmux-backed tuiui command:
#
#   source /path/to/tuiui/scripts/codex-tmux.sh
#
# By default every Codex invocation runs inside tmux. Use `CODEX_TMUX=0 codex ...`
# to bypass the wrapper once. If you shadow `codex` with an alias instead, capture
# the real executable first:
#
#   export REALCODEX="$(command -v codex)"
#   alias codex='npx tuiui codex'

if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  __codex_tmux_source="${BASH_SOURCE[0]}"
elif [[ -n "${ZSH_VERSION:-}" ]]; then
  __codex_tmux_source="${(%):-%x}"
else
  __codex_tmux_source="$0"
fi

__codex_tmux_dir="$(cd -- "$(dirname -- "$__codex_tmux_source")" && pwd -P)"

codex() {
  local node_bin="${CODEX_TMUX_NODE:-node}"
  "$node_bin" "$__codex_tmux_dir/../bin/tuiui.ts" codex "$@"
}
