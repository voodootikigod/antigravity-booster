#!/bin/sh
set -e

# Determine plugin root relative to this launcher, immune to cwd
LAUNCHER_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
PLUGIN_ROOT="$(dirname -- "$LAUNCHER_DIR")"
CURRENT_DIR="$(pwd -P 2>/dev/null || true)"

# When running inside a builder sandbox where HOME is isolated to <worktree>/.agb_home,
# derive the host user home from the staged plugin path (<userHome>/.gemini/config/plugins/...).
USER_HOME="$HOME"
case "$PLUGIN_ROOT" in
  */.gemini/*) USER_HOME="${PLUGIN_ROOT%%/.gemini/*}" ;;
esac

# Resolve full symlink chain iteratively in pure POSIX sh
resolve_full_path() {
  _tgt="$1"
  while [ -L "$_tgt" ]; do
    _dir="$(CDPATH='' cd -- "$(dirname -- "$_tgt")" 2>/dev/null && pwd -P)"
    _link="$(readlink "$_tgt" 2>/dev/null || true)"
    case "$_link" in
      /*) _tgt="$_link" ;;
      *)  _tgt="$_dir/$_link" ;;
    esac
  done
  _dir="$(CDPATH='' cd -- "$(dirname -- "$_tgt")" 2>/dev/null && pwd -P)"
  printf '%s/%s\n' "$_dir" "$(basename -- "$_tgt")"
}

is_valid_node() {
  candidate="$1"
  [ -n "$candidate" ] || return 1
  [ -x "$candidate" ] || return 1

  # Security: Candidate must be an absolute path
  case "$candidate" in
    /*) ;;
    *) return 1 ;;
  esac

  # Resolve full symlink chain before decoy check
  REAL_CANDIDATE="$(resolve_full_path "$candidate")"
  [ -x "$REAL_CANDIDATE" ] || return 1

  # Security: Reject candidates containing dangerous or ephemeral directory segments
  case "$REAL_CANDIDATE" in
    */tmp/*|*/tmp|*/node_modules/*|*/.git/*) return 1 ;;
  esac

  # Security: Candidate must reside within trusted system prefixes or standard version managers
  REAL_HOME="$(resolve_full_path "$HOME" 2>/dev/null || printf '%s\n' "$HOME")"
  REAL_USER_HOME="$(resolve_full_path "$USER_HOME" 2>/dev/null || printf '%s\n' "$USER_HOME")"
  TRUSTED=0
  case "$REAL_CANDIDATE" in
    /opt/homebrew/*|/usr/local/*|/usr/*|/bin/*|/System/*) TRUSTED=1 ;;
    "$HOME"/.local/share/fnm/*|"$HOME"/.local/share/mise/*|"$HOME"/.nvm/*|"$HOME"/.asdf/*|"$HOME"/.volta/*|"$HOME"/.nodenv/*|"$HOME"/n/*) TRUSTED=1 ;;
    "$REAL_HOME"/.local/share/fnm/*|"$REAL_HOME"/.local/share/mise/*|"$REAL_HOME"/.nvm/*|"$REAL_HOME"/.asdf/*|"$REAL_HOME"/.volta/*|"$REAL_HOME"/.nodenv/*|"$REAL_HOME"/n/*) TRUSTED=1 ;;
    "$USER_HOME"/.local/share/fnm/*|"$USER_HOME"/.local/share/mise/*|"$USER_HOME"/.nvm/*|"$USER_HOME"/.asdf/*|"$USER_HOME"/.volta/*|"$USER_HOME"/.nodenv/*|"$USER_HOME"/n/*) TRUSTED=1 ;;
    "$REAL_USER_HOME"/.local/share/fnm/*|"$REAL_USER_HOME"/.local/share/mise/*|"$REAL_USER_HOME"/.nvm/*|"$REAL_USER_HOME"/.asdf/*|"$REAL_USER_HOME"/.volta/*|"$REAL_USER_HOME"/.nodenv/*|"$REAL_USER_HOME"/n/*) TRUSTED=1 ;;
  esac
  [ "$TRUSTED" -eq 1 ] || return 1

  # Security: Reject candidate if inside an active project repo (excluding HOME or system roots)
  for check_dir in "$CURRENT_DIR" "$AGB_TARGET_REPO"; do
    [ -n "$check_dir" ] || continue
    case "$check_dir" in
      /|/Users|/home|"$HOME"|"$HOME"/|"$REAL_HOME"|"$REAL_HOME"/|"$USER_HOME"|"$USER_HOME"/|"$REAL_USER_HOME"|"$REAL_USER_HOME"/|/tmp|/var) continue ;;
      *)
        case "$REAL_CANDIDATE" in
          "$check_dir"/*|"$check_dir") return 1 ;;
        esac
        ;;
    esac
  done

  "$candidate" -e '
    const [maj, min] = process.versions.node.split(".").map(Number);
    process.exit((maj > 22 || (maj === 22 && min >= 19)) ? 0 : 1);
  ' 2>/dev/null
}

NODE_BIN=""

check_candidate() {
  [ -z "$NODE_BIN" ] || return 0
  if is_valid_node "$1"; then
    NODE_BIN="$1"
  fi
}

# 1. Prioritize well-known absolute system / package-manager prefixes
check_candidate "/opt/homebrew/bin/node"
check_candidate "/usr/local/bin/node"
check_candidate "/usr/bin/node"
check_candidate "/bin/node"

search_home_managers() {
  _h="$1"
  [ -n "$_h" ] || return 0

  # 2. Search fnm locations (aliases/default, current, and installed versions)
  if [ -z "$NODE_BIN" ]; then
    check_candidate "$_h/.local/share/fnm/aliases/default/bin/node"
    check_candidate "$_h/.local/share/fnm/current/bin/node"
    if [ -z "$NODE_BIN" ] && [ -d "$_h/.local/share/fnm/node-versions" ]; then
      for vdir in "$_h/.local/share/fnm/node-versions"/*/installation/bin/node; do
        [ -e "$vdir" ] || continue
        check_candidate "$vdir"
        [ -z "$NODE_BIN" ] || break
      done
    fi
  fi

  # 3. Search mise locations
  if [ -z "$NODE_BIN" ] && [ -d "$_h/.local/share/mise/installs/node" ]; then
    for vdir in "$_h/.local/share/mise/installs/node"/*/bin/node; do
      [ -e "$vdir" ] || continue
      check_candidate "$vdir"
      [ -z "$NODE_BIN" ] || break
    done
  fi

  # 4. Search asdf locations (directly inspect real installations; skip cwd-sensitive shims)
  if [ -z "$NODE_BIN" ]; then
    if [ -d "$_h/.asdf/installs/nodejs" ]; then
      for vdir in "$_h/.asdf/installs/nodejs"/*/bin/node; do
        [ -e "$vdir" ] || continue
        check_candidate "$vdir"
        [ -z "$NODE_BIN" ] || break
      done
    fi
  fi

  # 5. Search nodenv locations
  if [ -z "$NODE_BIN" ] && [ -d "$_h/.nodenv/versions" ]; then
    for vdir in "$_h/.nodenv/versions"/*/bin/node; do
      [ -e "$vdir" ] || continue
      check_candidate "$vdir"
      [ -z "$NODE_BIN" ] || break
    done
  fi

  # 6. Search volta locations (directly inspect real engine images; ~/.volta/bin/node is a cwd-sensitive shim)
  if [ -z "$NODE_BIN" ]; then
    if [ -d "$_h/.volta/tools/image/node" ]; then
      for vdir in "$_h/.volta/tools/image/node"/*/bin/node; do
        [ -e "$vdir" ] || continue
        check_candidate "$vdir"
        [ -z "$NODE_BIN" ] || break
      done
    fi
    if [ -z "$NODE_BIN" ]; then
      check_candidate "$_h/.volta/bin/node"
    fi
  fi

  # 7. Search nvm versions
  if [ -z "$NODE_BIN" ] && [ -d "$_h/.nvm/versions/node" ]; then
    for vdir in "$_h/.nvm/versions/node"/*/bin/node; do
      [ -e "$vdir" ] || continue
      check_candidate "$vdir"
      [ -z "$NODE_BIN" ] || break
    done
  fi

  # 8. Search n manager locations
  if [ -z "$NODE_BIN" ]; then
    check_candidate "/usr/local/n/versions/node/default/bin/node"
    check_candidate "$_h/n/bin/node"
  fi
}

search_home_managers "$HOME"
if [ -z "$NODE_BIN" ] && [ "$USER_HOME" != "$HOME" ]; then
  search_home_managers "$USER_HOME"
fi

# 9. Fall back to system PATH if candidate satisfies strict trust prefix validation
if [ -z "$NODE_BIN" ] && [ -n "$PATH" ]; then
  SYS_NODE="$(command -v node 2>/dev/null || true)"
  if [ -n "$SYS_NODE" ]; then
    check_candidate "$SYS_NODE"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  echo "error: No Node.js >= 22.19.0 found on PATH or standard installation prefixes." >&2
  # Dedicated exit code 86 allows hook-runner to distinguish missing Node from uncaught JS crashes
  exit 86
fi

SCRIPT="$1"
[ -n "$SCRIPT" ] || { echo "error: No script argument provided to node-launcher.sh" >&2; exit 1; }
shift

# Strict target script confinement: resolve realpath on both branches and reject traversal
case "$SCRIPT" in
  /*) CANDIDATE_SCRIPT="$SCRIPT" ;;
  *)  CANDIDATE_SCRIPT="$PLUGIN_ROOT/$SCRIPT" ;;
esac

TARGET_SCRIPT="$(resolve_full_path "$CANDIDATE_SCRIPT")"
case "$TARGET_SCRIPT" in
  "$PLUGIN_ROOT"/*) ;;
  *) echo "error: Script path outside PLUGIN_ROOT is rejected: $SCRIPT" >&2; exit 1 ;;
esac

if [ ! -f "$TARGET_SCRIPT" ]; then
  echo "error: Plugin target script not found: $TARGET_SCRIPT" >&2
  exit 1
fi

exec "$NODE_BIN" "$TARGET_SCRIPT" "$@"
