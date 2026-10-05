#!/bin/sh
# probe-agy.sh — reproducible live probes of agy plugin hook / command / MCP behavior.
# Evidence for Appendix A of .adlc/specs/native-plugin-installation.md (ticket t-plugin-00-spec).
#
# Uses the REAL $HOME (agy needs its OAuth state; a temporary HOME triggers re-auth),
# installs a throwaway plugin named "probe-hookenv", and uninstalls it on exit.
# Never touches the antigravity-booster or adlc-antigravity plugins.
#
# Usage: sh probe-agy.sh <output-dir>
set -u

OUT="${1:?usage: probe-agy.sh <output-dir>}"
mkdir -p "$OUT"
OUT="$(CDPATH='' cd -- "$OUT" && pwd -P)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/probe-agy.XXXXXX")"
P="$WORK/probe-hookenv"
WS="$WORK/ws"
LOG="$WORK/logs"
mkdir -p "$P/bin" "$P/commands" "$WS" "$LOG"

cleanup() {
  agy plugin uninstall probe-hookenv >/dev/null 2>&1 || true
  rm -rf "$HOME/.gemini/antigravity-cli/plugin_data/probe-hookenv" "$WORK"
}
trap cleanup EXIT HUP INT TERM

cat >"$P/plugin.json" <<'EOF'
{ "name": "probe-hookenv", "version": "0.0.1", "description": "agb spec PR0 live probe — safe to uninstall" }
EOF

# Hook logger: records tag, cwd, env and payload; the "regex" hook emits $PROBE_DECISION for run_command.
cat >"$P/bin/log.sh" <<EOF
#!/bin/sh
TAG="\$1"
IN="\$(cat)"
{
  printf '=== %s\n' "\$TAG"
  printf 'cwd=%s\n' "\$(pwd -P)"
  printf 'PLUGIN_ROOT=%s\nPLUGIN_DATA=%s\nAGB_HOOK_DISABLE=%s\nAGB_WORKER_TICKET=%s\nPROBE_DECISION=%s\n' \
    "\${PLUGIN_ROOT-<unset>}" "\${PLUGIN_DATA-<unset>}" "\${AGB_HOOK_DISABLE-<unset>}" "\${AGB_WORKER_TICKET-<unset>}" "\${PROBE_DECISION-<unset>}"
  printf 'stdin=%s\n' "\$IN"
} >>"\$PROBE_LOG"
if [ "\$TAG" = "regex" ] && [ -n "\${PROBE_DECISION-}" ]; then
  case "\$IN" in *'"name":"run_command"'*) printf '{"decision":"%s","reason":"probe %s"}\n' "\$PROBE_DECISION" "\$PROBE_DECISION" ;; esac
fi
exit 0
EOF

cat >"$P/bin/mcp-log.sh" <<'EOF'
#!/bin/sh
printf 'MCP cwd=%s PLUGIN_ROOT=%s PLUGIN_DATA=%s argv=[%s]\n' "$(pwd -P)" "${PLUGIN_ROOT-<unset>}" "${PLUGIN_DATA-<unset>}" "$0 $*" >>"$PROBE_LOG"
exit 1
EOF

cat >"$P/hooks.json" <<'EOF'
{
  "probe-star":    { "PreToolUse": [ { "matcher": "*",         "hooks": [ { "type": "command", "command": "/bin/sh bin/log.sh star",          "timeout": 10 } ] } ] },
  "probe-regex":   { "PreToolUse": [ { "matcher": ".*",        "hooks": [ { "type": "command", "command": "/bin/sh bin/log.sh regex",         "timeout": 10 } ] } ] },
  "probe-exact":   { "PreToolUse": [ { "matcher": "view_file", "hooks": [ { "type": "command", "command": "/bin/sh bin/log.sh viewfile-only", "timeout": 10 } ] } ] }
}
EOF

cat >"$P/mcp_config.json" <<'EOF'
{ "mcpServers": { "probemcp": { "command": "/bin/sh", "args": ["${PLUGIN_ROOT}/bin/mcp-log.sh", "${PLUGIN_ROOT}/x"] } } }
EOF

cat >"$P/commands/probe-env.md" <<EOF
---
description: probe env in slash command
---
\`\`\`sh
printf 'CMD cwd=%s PLUGIN_ROOT=%s ZERO=%s ARGS=[%s]\n' "\$(pwd -P)" "\${PLUGIN_ROOT-<unset>}" "\$0" "\$*" >> "$LOG/cmd.log"
\`\`\`
EOF

echo hello >"$WS/sample.txt"
{
  echo "# agy version: $(agy --version 2>&1)"
  echo "# uname: $(uname -sr)"
  agy plugin validate "$P" 2>&1
  agy plugin install "$P" 2>&1
} >"$OUT/00-install.txt"

run() { # run <name> <timeout-s> <agy args...>
  _name="$1"; _t="$2"; shift 2
  export PROBE_LOG="$OUT/$_name.hooks.log"
  : >"$PROBE_LOG"
  _start=$(date +%s)
  ( cd "$WS" && timeout "$((_t + 20))" agy "$@" --print-timeout "${_t}s" ) >"$OUT/$_name.agy.txt" 2>&1
  _rc=$?
  printf '\n# exit=%s elapsed=%ss\n' "$_rc" "$(( $(date +%s) - _start ))" >>"$OUT/$_name.agy.txt"
}

# 1. matcher syntax + env propagation + cwd + payload shape
PROBE_DECISION='' AGB_HOOK_DISABLE=1 AGB_WORKER_TICKET=T-PROBE \
  run 01-matcher-env 120 -p "Use your file viewing tool to read sample.txt in the current directory, then run the shell command 'echo probe-ok'. Report both outputs." --dangerously-skip-permissions
# 2. headless ask (no --dangerously-skip-permissions)
PROBE_DECISION=ask run 02-headless-ask 120 -p "Run the shell command 'echo probe-ask' and report exactly what happened, including any denial or permission message."
# 3. headless deny
PROBE_DECISION=deny run 03-headless-deny 120 -p "Run the shell command 'echo probe-deny' and report exactly what happened, including any denial or permission message."
# 4. control: no hook decision, unlisted command, no skip-permissions
PROBE_DECISION='' run 04-control-no-decision 120 -p "Run the shell command 'uname -s' and report exactly what happened, including any permission prompt or denial."
# 5. slash command execution model (also captures MCP server launch env)
: >"$LOG/cmd.log"
PROBE_DECISION='' run 05-slash-command 90 -p '/probe-env alpha "beta gamma"'
cp "$LOG/cmd.log" "$OUT/05-slash-command.cmd.log"

# Sanitize: strip home dir, scratch paths, and conversation ids.
for f in "$OUT"/*; do
  sed -i.bak -e "s#$WORK#<work>#g" -e "s#$HOME#\$HOME#g" \
    -e 's/"conversationId":"[^"]*"/"conversationId":"<id>"/g' \
    -E -e 's#brain/[0-9a-f-]{36}#brain/<id>#g' "$f" && rm -f "$f.bak"
done
echo "probe output written to $OUT"
