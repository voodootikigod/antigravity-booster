#!/bin/sh
# hook-runner.sh — Dedicated fail-safe wrapper for agy PreToolUse hooks.
# agy fails open on non-zero exits. This wrapper guarantees exit 0 under all conditions!

# Initialize status variables early
CHILD_STATUS=0
EMITTED=0
CHILD_PID=""
WATCHDOG_PID=""
STDIN_PID=""
FALLBACK_DECISION="deny"
WAIT_TIMEOUT=9

# Prepare log destination under user plugin data directory (anchored to PASSWD_HOME)
RUNNER_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
RUNNER_ROOT="$(dirname -- "$RUNNER_DIR")"

PASSWD_HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
if [ -z "$PASSWD_HOME" ] && command -v dscl >/dev/null 2>&1; then
  PASSWD_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
fi

EFF_HOME=""
case "$RUNNER_ROOT" in
  */.gemini/config/plugins/*)
    EFF_HOME="$PASSWD_HOME"
    if [ -z "$EFF_HOME" ]; then
      _cand_home="${RUNNER_ROOT%%/.gemini/*}"
      if [ -n "$_cand_home" ] && [ -O "$_cand_home" ]; then
        EFF_HOME="$_cand_home"
      fi
    fi
    ;;
  *)
    if [ -n "$AGB_TEST_PASSWD_HOME" ] && [ -f "$RUNNER_ROOT/test/hook-runner.test.mjs" ]; then
      EFF_HOME="$AGB_TEST_PASSWD_HOME"
    elif [ -n "$HOME" ]; then
      EFF_HOME="$HOME"
    else
      EFF_HOME="$PASSWD_HOME"
    fi
    ;;
esac
while [ "${EFF_HOME%/}" != "$EFF_HOME" ] && [ "$EFF_HOME" != "/" ]; do
  EFF_HOME="${EFF_HOME%/}"
done

resolve_no_symlink_root() {
  _target="$1"
  case "$_target" in
    /*) ;;
    *) return 1 ;;
  esac
  case "/$_target/" in
    */./*|*/../*) return 1 ;;
  esac
  while [ "${_target%/}" != "$_target" ] && [ "$_target" != "/" ]; do
    _target="${_target%/}"
  done
  _rem="${_target#/}"
  _prefix=""
  _existing="/"
  _trailing=""
  _in_existing=1
  while [ -n "$_rem" ]; do
    case "$_rem" in
      */*)
        _seg="${_rem%%/*}"
        _rem="${_rem#*/}"
        ;;
      *)
        _seg="$_rem"
        _rem=""
        ;;
    esac
    [ -n "$_seg" ] || continue
    _prefix="$_prefix/$_seg"
    if [ -e "$_prefix" ] || [ -L "$_prefix" ]; then
      [ ! -L "$_prefix" ] || return 1
    fi
    if [ "$_in_existing" -eq 1 ]; then
      if [ -d "$_prefix" ]; then
        _existing="$_prefix"
      elif [ -e "$_prefix" ]; then
        return 1
      else
        _in_existing=0
        _trailing="$_seg"
      fi
    else
      _trailing="$_trailing/$_seg"
    fi
  done
  _resolved_existing="$(CDPATH='' cd -- "$_existing" 2>/dev/null && pwd -P)" || return 1
  if [ -n "$_trailing" ]; then
    if [ "$_resolved_existing" = "/" ]; then
      printf '/%s\n' "$_trailing"
    else
      printf '%s/%s\n' "$_resolved_existing" "$_trailing"
    fi
  else
    printf '%s\n' "$_resolved_existing"
  fi
}

DATA_ROOT="${EFF_HOME}/.gemini/antigravity-cli/plugin_data/antigravity-booster"
if [ -n "$PLUGIN_DATA" ]; then
  _resolved_pd="$(resolve_no_symlink_root "$PLUGIN_DATA" 2>/dev/null || true)"
  case "$_resolved_pd" in
    "${EFF_HOME}/.gemini/antigravity-cli/plugin_data/antigravity-booster" | \
    "${EFF_HOME}/.gemini/antigravity/plugin_data/antigravity-booster" | \
    "${EFF_HOME}/.gemini/antigravity-ide/plugin_data/antigravity-booster" | \
    "${EFF_HOME}/.config/antigravity-booster")
      DATA_ROOT="$_resolved_pd"
      ;;
  esac
fi

umask 0077
HOOK_LOG_DIR="$DATA_ROOT/logs"
HOOK_LOG_FILE="$HOOK_LOG_DIR/hooks.log"
LOG_TAMPERED=0
LOG_DEGRADED=0
DEGRADED_MARKER="${EFF_HOME}/.gemini/antigravity-cli/.agb-hook-log-degraded"

# Spec §3.6: audit log lives under OS account home of id -u (PASSWD_HOME), so any symlink (-L)
# or foreign UID (! -O) on log components is tampering. Read-only bwrap mounts remain owned by
# id -u (-O true) and take the non-tampered LOG_DEGRADED path below instead.
if [ -L "${EFF_HOME}/.gemini" ] || [ -L "${EFF_HOME}/.gemini/antigravity-cli" ] || [ -L "${EFF_HOME}/.gemini/antigravity" ] || [ -L "${EFF_HOME}/.gemini/antigravity-ide" ] || [ -L "${EFF_HOME}/.config" ] || [ -L "$DATA_ROOT" ] || [ -L "$HOOK_LOG_DIR" ] || [ -L "$HOOK_LOG_FILE" ] || { [ -e "$DATA_ROOT" ] && [ ! -O "$DATA_ROOT" ]; } || { [ -e "$HOOK_LOG_DIR" ] && [ ! -O "$HOOK_LOG_DIR" ]; } || { [ -e "$HOOK_LOG_FILE" ] && [ ! -O "$HOOK_LOG_FILE" ]; }; then
  LOG_TAMPERED=1
fi

write_degraded_marker() {
  _msg="$1"
  if [ -L "${EFF_HOME}/.gemini" ] || [ -L "${EFF_HOME}/.gemini/antigravity-cli" ] || [ -L "$DEGRADED_MARKER" ]; then
    return 0
  fi
  mkdir -p "${EFF_HOME}/.gemini/antigravity-cli" 2>/dev/null || true
  if [ -L "${EFF_HOME}/.gemini" ] || [ -L "${EFF_HOME}/.gemini/antigravity-cli" ] || [ -L "$DEGRADED_MARKER" ]; then
    return 0
  fi
  if [ -e "$DEGRADED_MARKER" ] && [ ! -O "$DEGRADED_MARKER" ]; then
    return 0
  fi
  ( set -C; : >"$DEGRADED_MARKER" ) 2>/dev/null || true
  chmod 0600 "$DEGRADED_MARKER" 2>/dev/null || true
  printf '%s: %s\n' "$(date)" "$_msg" >"$DEGRADED_MARKER" 2>/dev/null || true
}

if [ "$LOG_TAMPERED" -eq 1 ]; then
  LOG_DEGRADED=1
  HOOK_LOG_FILE="/dev/null"
  write_degraded_marker "hook audit log tampered"
  printf 'agb hook runner: [warn] hook audit log tampered; logging degraded.\n' >&2
  if [ -n "$AGB_WORKER_TICKET" ] || [ -n "$AGB_WORKER_MODE" ]; then
    printf '{"decision":"deny","reason":"agb hook audit log tampered in headless worker"}\n'
    exit 0
  fi
else
  mkdir -p "$HOOK_LOG_DIR" 2>/dev/null || true
  ( set -C; : >"$HOOK_LOG_FILE" ) 2>/dev/null || true
  if ! ( : >>"$HOOK_LOG_FILE" ) 2>/dev/null; then
    LOG_DEGRADED=1
    HOOK_LOG_FILE="/dev/null"
    write_degraded_marker "hook audit log degraded (unwritable)"
  fi
fi

# Emergency killswitch: Parent process launch environment variable
# (Immutable from child subshells spawned by in-session agents)
# Or operator disables hook via: agy plugin disable antigravity-booster
if [ -n "$AGB_HOOK_DISABLE" ]; then
  printf '%s: [CRITICAL NOTICE] AGB_HOOK_DISABLE is active; PreToolUse rails guard bypassed by operator request.\n' "$(date)" >>"$HOOK_LOG_FILE" 2>/dev/null || true
  printf 'agb hook runner: [CRITICAL NOTICE] AGB_HOOK_DISABLE is active; rails guard bypassed.\n' >&2
  exit 0
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --fallback)
      shift
      FALLBACK_DECISION="$1"
      shift
      ;;
    --timeout)
      shift
      WAIT_TIMEOUT="$1"
      shift
      ;;
    *)
      break
      ;;
  esac
done

case "$FALLBACK_DECISION" in
  ask|deny) ;;
  *) FALLBACK_DECISION="deny" ;;
esac

# Create secure temporary working directory with 0700 permissions
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hook-runner.XXXXXX" 2>/dev/null || mktemp -d "/tmp/hook-runner.$$.XXXXXX")"
chmod 0700 "$TMP_DIR" 2>/dev/null || true
TMP_IN="$TMP_DIR/in"
TMP_FLAT="$TMP_DIR/flat"
TMP_OUT="$TMP_DIR/out"
TMP_PID="$TMP_DIR/pid"
TMP_STDIN_PID="$TMP_DIR/stdin_pid"

cleanup_tmp() {
  exec 3<&- 2>/dev/null || true
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
}

emit_fallback() {
  # Disarm all traps immediately to prevent duplicate execution upon exit 0
  trap - EXIT HUP INT TERM
  exec 3<&- 2>/dev/null || true
  if [ "$EMITTED" -eq 1 ]; then
    cleanup_tmp
    exit 0
  fi
  EMITTED=1

  # Terminate stdin background reader if active
  if [ -n "$STDIN_PID" ] && kill -0 "$STDIN_PID" 2>/dev/null; then
    kill -TERM "$STDIN_PID" 2>/dev/null || true
  fi
  # Terminate child process if active
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill -TERM "$CHILD_PID" 2>/dev/null || true
  fi
  if [ -n "$WATCHDOG_PID" ]; then
    kill "$WATCHDOG_PID" 2>/dev/null || true
  fi

  # Two-tier fail-safe: check if target repository contains active ticket shards
  # IMPORTANT: The hook runs with cwd set to the staged plugin root (~/.gemini/config/plugins/antigravity-booster).
  # We MUST extract candidate roots from the payload (workspacePaths and Cwd) and walk up from THEM, never from pwd!
  HAS_ADLC_TICKETS=0
  HAS_ADLC_DIR=0
  PARSE_SUCCESS=0

  if [ -f "$TMP_IN" ]; then
    # Flatten newlines to handle multi-line/pretty-printed JSON robustly
    tr '\r\n' '  ' <"$TMP_IN" >"$TMP_FLAT" 2>/dev/null || cp "$TMP_IN" "$TMP_FLAT" 2>/dev/null || true

    # Extract strings inside workspacePaths: [ "...", "..." ] preserving spaces
    WS_RAW="$(sed -n 's/.*"workspacePaths"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' "$TMP_FLAT" 2>/dev/null)"
    # Extract Cwd / cwd
    CWD_VAL="$(sed -n 's/.*"[Cc]wd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP_FLAT" 2>/dev/null | head -n 1)"

    if [ -n "$WS_RAW" ] || [ -n "$CWD_VAL" ]; then
      PARSE_SUCCESS=1
    fi

    # The greedy extraction above takes the LAST match, so a second
    # "workspacePaths" or "Cwd" injected into the tool's own arguments could
    # steer the fallback (P5 round 3 F1). Ambiguous payloads are unparseable.
    WS_COUNT="$(grep -o '"workspacePaths"' "$TMP_FLAT" 2>/dev/null | wc -l | tr -d ' ')"
    CWD_COUNT="$(grep -o '"[Cc]wd"[[:space:]]*:' "$TMP_FLAT" 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$WS_COUNT" -gt 1 ] || [ "$CWD_COUNT" -gt 1 ]; then
      PARSE_SUCCESS=0
    fi

    # Iterate line by line over extracted paths preserving spaces
    {
      if [ -n "$WS_RAW" ]; then
        # Output each quoted string on its own line without the enclosing quotes
        printf '%s\n' "$WS_RAW" | grep -o '"[^"]*"' 2>/dev/null | sed 's/^"//; s/"$//'
      fi
      if [ -n "$CWD_VAL" ]; then
        printf '%s\n' "$CWD_VAL"
      fi
      if [ ! -s "$TMP_IN" ]; then
        printf '%s\n' "$PWD"
      fi
    } | while IFS= read -r _target; do
      [ -n "$_target" ] || continue
      _curr="$_target"
      while [ -n "$_curr" ] && [ "$_curr" != "/" ] && [ "$_curr" != "." ]; do
        case "$_curr" in
          "${HOME%/}" | "${AGB_USER_HOME%/}" | "${TMPDIR%/}" | /tmp | /private/tmp | /var/tmp)
            ;;
          *)
            if [ -d "$_curr/.adlc" ]; then
              touch "$TMP_DIR/has_adlc_dir"
            fi
            if [ -d "$_curr/.adlc/tickets" ]; then
              for _shard in "$_curr/.adlc/tickets"/*.json; do
                if [ -f "$_shard" ]; then
                  # Active ticket: status NOT in completed, closed, or archived (fail closed)
                  if ! grep -Eq '"status"[[:space:]]*:[[:space:]]*"(completed|closed|archived)"' "$_shard" 2>/dev/null; then
                    # Signal active in-flight ticket to outer scope
                    touch "$TMP_DIR/has_active_tickets"
                    break 2
                  fi
                fi
              done
            fi
            ;;
        esac
        _curr="$(dirname -- "$_curr")"
      done
    done

    HAS_ADLC_DIR=0
    if [ -f "$TMP_DIR/has_adlc_dir" ]; then
      HAS_ADLC_DIR=1
    fi

    if [ -f "$TMP_DIR/has_active_tickets" ]; then
      HAS_ADLC_TICKETS=1
    fi

    # Heuristic check: if active tickets are mentioned in payload
    if [ "$HAS_ADLC_TICKETS" -eq 0 ]; then
      if grep -q '\.adlc/tickets/' "$TMP_IN" 2>/dev/null; then
        HAS_ADLC_TICKETS=1
      fi
    fi
  fi

  # Fail closed on unparseable or empty payload or ambiguous context
  UNPARSEABLE=0
  if [ "$PARSE_SUCCESS" -eq 0 ]; then
    HAS_ADLC_TICKETS=1
    HAS_ADLC_DIR=1
    UNPARSEABLE=1
  fi

  DEGRADED_SUFFIX=""
  if [ "$LOG_DEGRADED" -eq 1 ]; then
    DEGRADED_SUFFIX=" [audit-log-degraded]"
  fi

  if [ "$HAS_ADLC_TICKETS" -eq 1 ] || [ "$HAS_ADLC_DIR" -eq 1 ]; then
    # Extract tool name from payload to allow read-only diagnostic tools during fallback
    TOOL_NAME="$(sed -n 's/.*"toolCall"[^{]*{[^}]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP_FLAT" 2>/dev/null | head -n 1)"
    if [ -z "$TOOL_NAME" ]; then
      TOOL_NAME="$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP_FLAT" 2>/dev/null | head -n 1)"
    fi
    # The greedy extraction above can be steered by a second "toolCall"/"name"
    # injected into the tool's own arguments (P5 prosecution H5). Only an
    # unambiguous payload may earn the read-only pass-through.
    TOOLCALL_COUNT="$(grep -o '"toolCall"' "$TMP_FLAT" 2>/dev/null | wc -l | tr -d ' ')"
    NAME_COUNT="$(grep -o '"name"[[:space:]]*:' "$TMP_FLAT" 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$TOOLCALL_COUNT" != "1" ] || [ "$NAME_COUNT" != "1" ]; then
      TOOL_NAME=""
    fi

    IS_READ_ONLY=0
    case "$TOOL_NAME" in
      view_file|read_file|grep_search|code_search|file_search|list_directory|list_dir|list_permissions|search_in_file|wait|wait_5_seconds|read_url_content|read_browser_page|search_web|list_resources|read_resource|ask_question|view_file_outline|read_terminal|read_notebook|command_status|find_by_name)
        IS_READ_ONLY=1
        ;;
      manage_task)
        ACTION_COUNT="$(grep -io '"action"[[:space:]]*:' "$TMP_FLAT" 2>/dev/null | wc -l | tr -d ' ')"
        if [ "$ACTION_COUNT" = "1" ] && grep -Eq '"[Aa]ction"[[:space:]]*:[[:space:]]*"(list|status)"' "$TMP_FLAT" 2>/dev/null && ! grep -Eq '\\u' "$TMP_IN" 2>/dev/null; then
          IS_READ_ONLY=1
        fi
        ;;
    esac

    TARGETS_PROTECTED=0
    if grep -Eq '\.migration\.lock|antigravity-booster|plugin_data|/\.\.(/|\"|$)|\\u00' "$TMP_IN" 2>/dev/null; then
      TARGETS_PROTECTED=1
    fi

    if [ "$IS_READ_ONLY" -eq 1 ] && [ "$TARGETS_PROTECTED" -eq 0 ]; then
      printf '%s: [warn] hook runner: fallback active in ADLC repo, passing through read-only tool: %s\n' "$(date)" "$TOOL_NAME" >>"$HOOK_LOG_FILE" 2>/dev/null || true
      cleanup_tmp
      exit 0
    fi

    # In headless fleet worker mode (AGB_WORKER_TICKET or AGB_WORKER_MODE set), never prompt 'ask' (fails closed to deny)
    if [ -n "$AGB_WORKER_TICKET" ] || [ -n "$AGB_WORKER_MODE" ]; then
      printf '{"decision":"deny","reason":"Hook runner fail-safe in headless worker mode — failing closed%s"}\n' "$DEGRADED_SUFFIX"
      cleanup_tmp
      exit 0
    fi

    # Unparseable payload: fail closed for every non-read tool, including run_command (Fallback table)
    if [ "$UNPARSEABLE" -eq 1 ]; then
      printf '{"decision":"deny","reason":"Hook runner fail-safe — unparseable payload; failing closed%s"}\n' "$DEGRADED_SUFFIX"
      cleanup_tmp
      exit 0
    fi

    # For shell commands (run_command): fall back to interactive operator prompt (ask)
    # rather than hard-denying all shell commands when the hook is degraded
    if [ "$TOOL_NAME" = "run_command" ]; then
      printf '{"decision":"ask","reason":"Hook runner fail-safe in ADLC repository — shell command requires operator confirmation while hook is degraded%s"}\n' "$DEGRADED_SUFFIX"
      cleanup_tmp
      exit 0
    fi

    # In an ADLC repository with tickets or .adlc directory, rail protection takes absolute precedence on file mutations: fail closed
    printf '{"decision":"deny","reason":"Hook runner fail-safe in ADLC repository — frozen rails require denial (run agb doctor to verify runtime health)%s"}\n' "$DEGRADED_SUFFIX"
  else
    # In non-ADLC repositories or workspaces without active tickets:
    # If node-launcher exited with 86 (Node >= 22.19 not found), yield to neutral pass-through ("" with exit 0)
    # regardless of worker mode (Fallback table: Missing Node Runtime / Non-ADLC / Any)
    if [ "$CHILD_STATUS" -eq 86 ]; then
      printf '%s: [warn] hook runner: Node runtime missing in non-ADLC workspace (exit 86); passing through\n' "$(date)" >>"$HOOK_LOG_FILE" 2>/dev/null || true
      cleanup_tmp
      exit 0
    fi

    # If in headless worker mode, never prompt 'ask':
    if [ -n "$AGB_WORKER_TICKET" ] || [ -n "$AGB_WORKER_MODE" ]; then
      printf '{"decision":"deny","reason":"Hook runner fail-safe in headless worker mode — failing closed%s"}\n' "$DEGRADED_SUFFIX"
      cleanup_tmp
      exit 0
    fi
    case "$FALLBACK_DECISION" in
      deny) printf '{"decision":"ask","reason":"Hook runner fail-safe — falling back to user confirmation%s"}\n' "$DEGRADED_SUFFIX" ;;
      *)    printf '{"decision":"%s","reason":"Hook runner fail-safe — falling back to default policy%s"}\n' "$FALLBACK_DECISION" "$DEGRADED_SUFFIX" ;;
    esac
  fi

  cleanup_tmp
  exit 0
}

trap emit_fallback EXIT HUP INT TERM

LAUNCHER_DIR="$RUNNER_DIR"
PLUGIN_ROOT="$RUNNER_ROOT"
[ -n "$PLUGIN_ROOT" ] || emit_fallback

MAIN_PID=$$

# Internal watchdog: Started BEFORE reading stdin to enforce absolute deadline on input + child
# Sized with WAIT_TIMEOUT=9s plus parallel 1s SIGTERM->SIGKILL escalation plus <500ms emit_fallback,
# ensuring response emission well within 10.5s, strictly below the 15s platform deadline with >4s safety margin.
(
  exec >/dev/null 2>&1
  sleep "$WAIT_TIMEOUT"
  _SPID=""
  _CPID=""
  [ -f "$TMP_STDIN_PID" ] && _SPID="$(cat "$TMP_STDIN_PID" 2>/dev/null || true)"
  [ -f "$TMP_PID" ] && _CPID="$(cat "$TMP_PID" 2>/dev/null || true)"
  if [ -n "$_SPID" ] && kill -0 "$_SPID" 2>/dev/null; then
    kill -TERM "$_SPID" 2>/dev/null || true
  fi
  if [ -n "$_CPID" ] && kill -0 "$_CPID" 2>/dev/null; then
    kill -TERM "$_CPID" 2>/dev/null || true
  fi
  sleep 1
  # Re-read: main removes each pidfile right after reaping that pid, so a pid
  # whose file is gone or changed may already belong to an unrelated process.
  _SPID2=""
  _CPID2=""
  [ -f "$TMP_STDIN_PID" ] && _SPID2="$(cat "$TMP_STDIN_PID" 2>/dev/null || true)"
  [ -f "$TMP_PID" ] && _CPID2="$(cat "$TMP_PID" 2>/dev/null || true)"
  if [ -n "$_SPID" ] && [ "$_SPID" = "$_SPID2" ] && kill -0 "$_SPID" 2>/dev/null; then
    kill -KILL "$_SPID" 2>/dev/null || true
  fi
  if [ -n "$_CPID" ] && [ "$_CPID" = "$_CPID2" ] && kill -0 "$_CPID" 2>/dev/null; then
    kill -KILL "$_CPID" 2>/dev/null || true
  fi
  # Signal parent hook runner to trigger emit_fallback immediately
  kill -TERM "$MAIN_PID" 2>/dev/null || true
) &
WATCHDOG_PID=$!

# Duplicate stdin to file descriptor 3 before launching background jobs
# (POSIX 2.9.3.1: asynchronous list `cmd &` receives /dev/null as stdin if job control is disabled)
exec 3<&0

# Read stdin in background with pidfile and wait on it so watchdog and traps can interrupt immediately
cat <&3 >"$TMP_IN" &
STDIN_PID=$!
echo "$STDIN_PID" > "$TMP_STDIN_PID"
wait "$STDIN_PID" 2>/dev/null || true
rm -f "$TMP_STDIN_PID" 2>/dev/null || true
exec 3<&- 2>/dev/null || true

# Execute launcher as child process via /bin/sh with redirected stdin and stdout
/bin/sh "$PLUGIN_ROOT/bin/node-launcher.sh" "$@" <"$TMP_IN" >"$TMP_OUT" 2>>"$HOOK_LOG_FILE" &
CHILD_PID=$!
echo "$CHILD_PID" > "$TMP_PID"

wait "$CHILD_PID" 2>/dev/null || CHILD_STATUS=$?
rm -f "$TMP_PID" 2>/dev/null || true
kill "$WATCHDOG_PID" 2>/dev/null || true
wait "$WATCHDOG_PID" 2>/dev/null || true

OUTPUT="$(cat "$TMP_OUT" 2>/dev/null || true)"

# If child process exited non-zero or crashed, trigger fail-safe fallback decision immediately
if [ "$CHILD_STATUS" -ne 0 ]; then
  emit_fallback
fi

# Neutral pass-through handling: if child emitted empty stdout, pass through immediately
if [ -z "$OUTPUT" ]; then
  trap - EXIT HUP INT TERM
  EMITTED=1
  cleanup_tmp
  exit 0
fi

# Validate that output is exactly one line matching the strict anchored decision schema
LINE_COUNT="$(printf '%s\n' "$OUTPUT" | wc -l | tr -d ' ')"
if [ "$LINE_COUNT" -eq 1 ]; then
  case "$OUTPUT" in
    '{"decision":"ask"'*|'{"decision": "ask"'*|'{"decision":"deny"'*|'{"decision": "deny"'*)
      case "$OUTPUT" in
        *\}*)
          trap - EXIT HUP INT TERM
          EMITTED=1
          cleanup_tmp
          printf '%s\n' "$OUTPUT"
          exit 0
          ;;
      esac
      ;;
    '{"decision":"allow"'*|'{"decision": "allow"'*)
      # Booster doctrine strictly forbids in-session allow. Convert to fallback decision!
      printf '%s: [warn] hook runner: child emitted forbidden allow decision; converting to fallback\n' "$(date)" >>"$HOOK_LOG_FILE" 2>/dev/null || true
      emit_fallback
      ;;
  esac
fi

emit_fallback
