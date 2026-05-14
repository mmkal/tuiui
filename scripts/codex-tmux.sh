#!/usr/bin/env bash

# Source this Bash-compatible file to make `codex` prefer one live tmux-backed TUI:
#
#   source /path/to/tuiui/scripts/codex-tmux.sh
#
# The wrapper only intercepts interactive Codex entry points. Non-interactive
# subcommands such as `codex exec`, `codex login`, and `codex app-server` are
# passed straight through to the real Codex binary.
#
# Useful escape hatches:
#
#   CODEX_TMUX=0 codex ...                 # bypass this wrapper once
#   CODEX_TMUX_CODEX_BIN=/path/to/codex    # pin the real Codex binary
#   CODEX_TMUX_SESSION_NAME=name codex ... # force a tmux session name once
#   CODEX_TMUX_PREFIX=codex-work codex ... # customize generated names
#
# If a Codex session was originally started outside tmux, this wrapper cannot
# attach to that existing terminal process. It will create a tmux-backed resume
# for that thread from this point forward.

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

__codex_tmux_flag_takes_value() {
  case "$1" in
    -a|--ask-for-approval|\
    -c|--config|\
    -C|--cd|\
    -i|--image|\
    -m|--model|\
    -p|--profile|\
    -s|--sandbox|\
    --add-dir|\
    --disable|\
    --enable|\
    --local-provider|\
    --remote|\
    --remote-auth-token-env)
      return 0
      ;;
  esac

  return 1
}

__codex_tmux_has_help_or_version() {
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

__codex_tmux_first_positional() {
  local arg
  local skip_next=0

  for arg in "$@"; do
    if ((skip_next)); then
      skip_next=0
      continue
    fi

    case "$arg" in
      --)
        printf '%s\n' "__prompt__"
        return 0
        ;;
      --*=*)
        continue
        ;;
      -*)
        if __codex_tmux_flag_takes_value "$arg"; then
          skip_next=1
        fi
        continue
        ;;
      *)
        printf '%s\n' "$arg"
        return 0
        ;;
    esac
  done

  return 1
}

__codex_tmux_is_passthrough_subcommand() {
  case "$1" in
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

  return 1
}

__codex_tmux_hash() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{ print substr($1, 1, 12) }'
    return 0
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{ print substr($1, 1, 12) }'
    return 0
  fi

  cksum | awk '{ print $1 }'
}

__codex_tmux_slug() {
  local value=${1:-codex}

  value=$(printf '%s' "$value" | tr -c 'A-Za-z0-9_-' '-' | sed 's/^-*//; s/-*$//; s/--*/-/g')

  if [[ -z "$value" ]]; then
    value=codex
  fi

  printf '%.36s\n' "$value"
}

__codex_tmux_resume_target() {
  local arg
  local saw_resume=0
  local skip_next=0

  for arg in "$@"; do
    if ((skip_next)); then
      skip_next=0
      continue
    fi

    if ((!saw_resume)); then
      case "$arg" in
        resume)
          saw_resume=1
          ;;
        --*=*)
          ;;
        -*)
          if __codex_tmux_flag_takes_value "$arg"; then
            skip_next=1
          fi
          ;;
      esac
      continue
    fi

    case "$arg" in
      --)
        return 1
        ;;
      --all|--include-non-interactive|--last|--no-alt-screen|--oss|--search|--strict-config|\
      --dangerously-bypass-approvals-and-sandbox|--dangerously-bypass-hook-trust|--yolo)
        continue
        ;;
      --*=*)
        continue
        ;;
      -*)
        if __codex_tmux_flag_takes_value "$arg"; then
          skip_next=1
        fi
        continue
        ;;
      *)
        printf '%s\n' "$arg"
        return 0
        ;;
    esac
  done

  return 1
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

__codex_tmux_session_name() {
  local kind=$1
  shift

  if [[ -n "${CODEX_TMUX_SESSION_NAME:-}" ]]; then
    __codex_tmux_slug "$CODEX_TMUX_SESSION_NAME"
    return 0
  fi

  local prefix=${CODEX_TMUX_PREFIX:-codex}
  local label
  local key
  local hash

  case "$kind" in
    resume)
      local target
      if target=$(__codex_tmux_resume_target "$@"); then
        label="resume-$target"
        key="resume:$target"
      else
        label="resume-$(basename "$PWD")"
        key="resume-picker:$PWD"
      fi
      ;;
    fork)
      label="fork-$(basename "$PWD")"
      key="fork:$PWD:$*"
      ;;
    *)
      label="$(basename "$PWD")"
      key="start:$PWD"
      ;;
  esac

  hash=$(printf '%s' "$key" | __codex_tmux_hash)
  printf '%s-%s-%s\n' "$prefix" "$(__codex_tmux_slug "$label")" "$hash"
}

__codex_tmux_attach() {
  local session_name=$1

  if [[ -n "${TMUX:-}" ]]; then
    tmux switch-client -t "$session_name"
    return $?
  fi

  tmux attach-session -t "$session_name"
}

__codex_tmux_run_interactive() {
  local kind=$1
  shift

  local real_codex
  real_codex=$(__codex_tmux_real_codex)
  if [[ -z "$real_codex" ]]; then
    printf 'codex-tmux: could not find the real codex binary. Set CODEX_TMUX_CODEX_BIN.\n' >&2
    return 127
  fi

  if ! command -v tmux >/dev/null 2>&1; then
    printf 'codex-tmux: tmux is not installed; running %s directly.\n' "$real_codex" >&2
    "$real_codex" "$@"
    return $?
  fi

  local session_name
  local command

  session_name=$(__codex_tmux_session_name "$kind" "$@")

  if tmux has-session -t "$session_name" 2>/dev/null; then
    __codex_tmux_attach "$session_name"
    return $?
  fi

  command=$(__codex_tmux_shell_command "$real_codex" "$@")
  tmux new-session -d -s "$session_name" -c "$PWD" "$command" || return $?
  tmux set-option -q -t "$session_name" @codex-tmux-wrapper "1" >/dev/null 2>&1 || true
  tmux set-option -q -t "$session_name" @codex-tmux-cwd "$PWD" >/dev/null 2>&1 || true
  tmux set-option -q -t "$session_name" @codex-tmux-command "$command" >/dev/null 2>&1 || true
  __codex_tmux_attach "$session_name"
}

codex() {
  local real_codex
  local first

  real_codex=$(__codex_tmux_real_codex)
  if [[ -z "$real_codex" ]]; then
    printf 'codex-tmux: could not find the real codex binary. Set CODEX_TMUX_CODEX_BIN.\n' >&2
    return 127
  fi

  if [[ "${CODEX_TMUX:-1}" == "0" ]] || __codex_tmux_has_help_or_version "$@"; then
    "$real_codex" "$@"
    return $?
  fi

  if first=$(__codex_tmux_first_positional "$@"); then
    case "$first" in
      resume)
        __codex_tmux_run_interactive resume "$@"
        return $?
        ;;
      fork)
        __codex_tmux_run_interactive fork "$@"
        return $?
        ;;
      __prompt__)
        __codex_tmux_run_interactive start "$@"
        return $?
        ;;
      *)
        if __codex_tmux_is_passthrough_subcommand "$first"; then
          "$real_codex" "$@"
          return $?
        fi

        __codex_tmux_run_interactive start "$@"
        return $?
        ;;
    esac
  fi

  __codex_tmux_run_interactive start "$@"
}
