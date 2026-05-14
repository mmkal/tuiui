#!/usr/bin/env bash

# Source this file to make interactive Codex sessions resumable through tmux:
#
#   source /path/to/tuiui/scripts/codex-tmux.sh
#
# The wrapper keeps a small mapping from Codex session id to tmux session name.
# A new interactive Codex launch creates a fresh tmux session, then a background
# watcher reads `session id: ...` from the tmux pane and stores the mapping.
# Later, `codex resume <session-id>` attaches to the mapped tmux session instead
# of starting a second Codex process.
#
# This intentionally does not try to model the full Codex CLI grammar. It only:
#
#   - detects an exact `resume` token and reads the following token as the id
#   - passes known non-interactive top-level commands straight through
#   - otherwise treats the invocation as an interactive Codex TUI launch
#
# Escape hatches:
#
#   CODEX_TMUX=0 codex ...                 # bypass this wrapper once
#   CODEX_TMUX_CODEX_BIN=/path/to/codex    # pin the real Codex binary
#   CODEX_TMUX_PREFIX=codex-work codex ... # customize generated tmux names
#   CODEX_TMUX_MAP_FILE=/path/to/map.tsv   # customize the mapping file

__codex_tmux_real_codex() {
  if [[ -n "${CODEX_TMUX_CODEX_BIN:-}" ]]; then
    printf '%s\n' "$CODEX_TMUX_CODEX_BIN"
    return 0
  fi

  if type -P codex >/dev/null 2>&1; then
    type -P codex
    return 0
  fi

  if command -v whence >/dev/null 2>&1 && whence -p codex >/dev/null 2>&1; then
    whence -p codex
    return 0
  fi

  return 1
}

__codex_tmux_state_dir() {
  if [[ -n "${CODEX_TMUX_STATE_DIR:-}" ]]; then
    printf '%s\n' "$CODEX_TMUX_STATE_DIR"
  elif [[ -n "${XDG_STATE_HOME:-}" ]]; then
    printf '%s\n' "$XDG_STATE_HOME/codex-tmux"
  else
    printf '%s\n' "$HOME/.local/state/codex-tmux"
  fi
}

__codex_tmux_map_file() {
  if [[ -n "${CODEX_TMUX_MAP_FILE:-}" ]]; then
    printf '%s\n' "$CODEX_TMUX_MAP_FILE"
  else
    printf '%s\n' "$(__codex_tmux_state_dir)/sessions.tsv"
  fi
}

__codex_tmux_shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

__codex_tmux_shell_command() {
  local arg
  local space=""

  for arg in "$@"; do
    printf '%s' "$space"
    __codex_tmux_shell_quote "$arg"
    space=" "
  done
  printf '\n'
}

__codex_tmux_slug() {
  local value=${1:-codex}

  value=$(printf '%s' "$value" | tr -c 'A-Za-z0-9_-' '-' | sed 's/^-*//; s/-*$//; s/--*/-/g')
  if [[ -z "$value" ]]; then
    value=codex
  fi

  printf '%.40s\n' "$value"
}

__codex_tmux_new_session_name() {
  local prefix=${CODEX_TMUX_PREFIX:-codex}
  local cwd_name
  local stamp

  cwd_name=$(__codex_tmux_slug "$(basename "$PWD")")
  stamp=$(date +%Y%m%d%H%M%S)
  printf '%s-%s-%s-%s\n' "$prefix" "$cwd_name" "$stamp" "$$"
}

__codex_tmux_resume_id() {
  local arg
  local previous_was_resume=0

  for arg in "$@"; do
    if ((previous_was_resume)); then
      case "$arg" in
        ""|-*)
          return 1
          ;;
        *)
          printf '%s\n' "$arg"
          return 0
          ;;
      esac
    fi

    if [[ "$arg" == "resume" ]]; then
      previous_was_resume=1
    fi
  done

  return 1
}

__codex_tmux_contains_noninteractive_command() {
  local arg

  for arg in "$@"; do
    case "$arg" in
      a|apply|\
      app|\
      app-server|\
      cloud|cloud-tasks|\
      completion|\
      debug|\
      doctor|\
      e|exec|\
      exec-server|\
      execpolicy|\
      features|\
      login|logout|\
      mcp|mcp-server|\
      plugin|\
      remote-control|\
      responses-api-proxy|\
      review|\
      sandbox|\
      stdio-to-uds|\
      update)
        return 0
        ;;
    esac
  done

  return 1
}

__codex_tmux_contains_help_or_version() {
  local arg

  for arg in "$@"; do
    case "$arg" in
      -h|--help|-V|--version)
        return 0
        ;;
    esac
  done

  return 1
}

__codex_tmux_lookup_session() {
  local codex_session_id=$1
  local map_file
  local tmux_session

  map_file=$(__codex_tmux_map_file)
  if [[ ! -f "$map_file" ]]; then
    return 1
  fi

  tmux_session=$(awk -F '\t' -v id="$codex_session_id" '$1 == id { session = $2 } END { if (session != "") print session }' "$map_file")
  if [[ -z "$tmux_session" ]]; then
    return 1
  fi

  if tmux has-session -t "$tmux_session" 2>/dev/null; then
    printf '%s\n' "$tmux_session"
    return 0
  fi

  return 1
}

__codex_tmux_store_mapping() {
  local codex_session_id=$1
  local tmux_session=$2
  local map_file

  map_file=$(__codex_tmux_map_file)
  mkdir -p "$(dirname "$map_file")" || return 1
  printf '%s\t%s\t%s\t%s\n' "$codex_session_id" "$tmux_session" "$(date +%s)" "$PWD" >> "$map_file"
}

__codex_tmux_extract_session_id() {
  local tmux_session=$1

  tmux capture-pane -p -S -200 -t "$tmux_session" 2>/dev/null \
    | sed -nE 's/.*session[ _-]?id:[[:space:]]*([0-9a-fA-F-]{36}).*/\1/p' \
    | tail -n 1
}

__codex_tmux_watch_session_id() {
  local tmux_session=$1
  local attempts=${CODEX_TMUX_DISCOVERY_ATTEMPTS:-100}
  local interval=${CODEX_TMUX_DISCOVERY_INTERVAL:-0.1}
  local codex_session_id
  local i=0

  while ((i < attempts)); do
    if ! tmux has-session -t "$tmux_session" 2>/dev/null; then
      return 1
    fi

    codex_session_id=$(__codex_tmux_extract_session_id "$tmux_session")
    if [[ -n "$codex_session_id" ]]; then
      __codex_tmux_store_mapping "$codex_session_id" "$tmux_session"
      return 0
    fi

    i=$((i + 1))
    sleep "$interval"
  done

  return 1
}

__codex_tmux_attach() {
  local tmux_session=$1

  if [[ -n "${TMUX:-}" ]]; then
    tmux switch-client -t "$tmux_session"
  else
    tmux attach-session -t "$tmux_session"
  fi
}

__codex_tmux_start() {
  local real_codex=$1
  shift

  local tmux_session
  local shell_command

  tmux_session=$(__codex_tmux_new_session_name)
  shell_command=$(__codex_tmux_shell_command "$real_codex" "$@")

  tmux new-session -d -s "$tmux_session" -c "$PWD" "$shell_command" || return $?
  tmux set-option -q -t "$tmux_session" @codex-tmux-wrapper "1" >/dev/null 2>&1 || true
  tmux set-option -q -t "$tmux_session" @codex-tmux-cwd "$PWD" >/dev/null 2>&1 || true
  tmux set-option -q -t "$tmux_session" @codex-tmux-command "$shell_command" >/dev/null 2>&1 || true

  (__codex_tmux_watch_session_id "$tmux_session") >/dev/null 2>&1 &
  __codex_tmux_attach "$tmux_session"
}

codex() {
  local real_codex
  local codex_session_id
  local tmux_session

  real_codex=$(__codex_tmux_real_codex)
  if [[ -z "$real_codex" ]]; then
    printf 'codex-tmux: could not find the real codex binary. Set CODEX_TMUX_CODEX_BIN.\n' >&2
    return 127
  fi

  if [[ "${CODEX_TMUX:-1}" == "0" ]] \
    || __codex_tmux_contains_help_or_version "$@" \
    || __codex_tmux_contains_noninteractive_command "$@"; then
    "$real_codex" "$@"
    return $?
  fi

  if codex_session_id=$(__codex_tmux_resume_id "$@"); then
    if tmux_session=$(__codex_tmux_lookup_session "$codex_session_id"); then
      __codex_tmux_attach "$tmux_session"
      return $?
    fi
  fi

  if ! command -v tmux >/dev/null 2>&1; then
    printf 'codex-tmux: tmux is not installed; running %s directly.\n' "$real_codex" >&2
    "$real_codex" "$@"
    return $?
  fi

  __codex_tmux_start "$real_codex" "$@"
}
