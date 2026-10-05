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

# Prepare log destination under user plugin data directory
HOOK_LOG_DIR="${HOME}/.gemini/antigravity-cli/plugin_data/antigravity-booster/logs"
mkdir -p "$HOOK_LOG_DIR" 2>/dev/null || true
HOOK_LOG_FILE="$HOOK_LOG_DIR/hooks.log"

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
    } | while IFS= read -r _target; do
      [ -n "$_target" ] || continue
      _curr="$_target"
      while [ -n "$_curr" ] && [ "$_curr" != "/" ] && [ "$_curr" != "." ]; do
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

  # Fail closed on unparseable payload or ambiguous context
  UNPARSEABLE=0
  if [ "$PARSE_SUCCESS" -eq 0 ] && [ -s "$TMP_IN" ]; then
    HAS_ADLC_TICKETS=1
    HAS_ADLC_DIR=1
    UNPARSEABLE=1
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
      view_file|grep_search|code_search|list_directory|read_url_content|read_browser_page|search_web|list_resources|read_resource|ask_question|view_file_outline|read_terminal|read_notebook|command_status)
        IS_READ_ONLY=1
        ;;
    esac

    TARGETS_PROTECTED=0
    if grep -Eq '\.migration\.lock|plugin_data/(\.?/)*antigravity-booster|\.config/(\.?/)*antigravity-booster' "$TMP_IN" 2>/dev/null; then
      TARGETS_PROTECTED=1
    fi

    if [ "$IS_READ_ONLY" -eq 1 ] && [ "$TARGETS_PROTECTED" -eq 0 ]; then
      printf '%s: [warn] hook runner: fallback active in ADLC repo, passing through read-only tool: %s\n' "$(date)" "$TOOL_NAME" >>"$HOOK_LOG_FILE" 2>/dev/null || true
      cleanup_tmp
      exit 0
    fi

    # In headless fleet worker mode (AGB_WORKER_TICKET or AGB_WORKER_MODE set), never prompt 'ask' (fails closed to deny)
    if [ -n "$AGB_WORKER_TICKET" ] || [ -n "$AGB_WORKER_MODE" ]; then
      printf '{"decision":"deny","reason":"Hook runner fail-safe in headless worker mode — failing closed"}\n'
      cleanup_tmp
      exit 0
    fi

    # Unparseable payload: fail closed for every non-read tool, including run_command (Fallback table)
    if [ "$UNPARSEABLE" -eq 1 ]; then
      printf '{"decision":"deny","reason":"Hook runner fail-safe — unparseable payload; failing closed"}\n'
      cleanup_tmp
      exit 0
    fi

    # For shell commands (run_command): fall back to interactive operator prompt (ask)
    # rather than hard-denying all shell commands when the hook is degraded
    if [ "$TOOL_NAME" = "run_command" ]; then
      printf '{"decision":"ask","reason":"Hook runner fail-safe in ADLC repository — shell command requires operator confirmation while hook is degraded"}\n'
      cleanup_tmp
      exit 0
    fi

    # In an ADLC repository with tickets or .adlc directory, rail protection takes absolute precedence on file mutations: fail closed
    printf '{"decision":"deny","reason":"Hook runner fail-safe in ADLC repository — frozen rails require denial (run agb doctor to verify runtime health)"}\n'
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
      printf '{"decision":"deny","reason":"Hook runner fail-safe in headless worker mode — failing closed"}\n'
      cleanup_tmp
      exit 0
    fi
    case "$FALLBACK_DECISION" in
      deny) printf '{"decision":"ask","reason":"Hook runner fail-safe — falling back to user confirmation"}\n' ;;
      *)    printf '{"decision":"%s","reason":"Hook runner fail-safe — falling back to default policy"}\n' "$FALLBACK_DECISION" ;;
    esac
  fi

  cleanup_tmp
  exit 0
}

trap emit_fallback EXIT HUP INT TERM

LAUNCHER_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P 2>/dev/null || true)"
PLUGIN_ROOT="$(dirname -- "$LAUNCHER_DIR")"
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
  [ -n "$_SPID" ] && kill -0 "$_SPID" 2>/dev/null && kill -TERM "$_SPID" 2>/dev/null || true
  [ -n "$_CPID" ] && kill -0 "$_CPID" 2>/dev/null && kill -TERM "$_CPID" 2>/dev/null || true
  sleep 1
  [ -n "$_SPID" ] && kill -0 "$_SPID" 2>/dev/null && kill -KILL "$_SPID" 2>/dev/null || true
  [ -n "$_CPID" ] && kill -0 "$_CPID" 2>/dev/null && kill -KILL "$_CPID" 2>/dev/null || true
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
