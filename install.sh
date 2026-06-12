#!/bin/sh
# Wire antigravity-booster into the local Antigravity install. Idempotent.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
SKILLS_DST="$HOME/.gemini/skills"

if ! command -v agy >/dev/null 2>&1; then
  echo "error: agy CLI not found on PATH — install Antigravity CLI first" >&2
  echo "  curl -fsSL https://antigravity.google/cli/install.sh | bash" >&2
  exit 1
fi

mkdir -p "$SKILLS_DST"
for skill in "$HERE"/skills/*/; do
  name=$(basename "$skill")
  dst="$SKILLS_DST/$name"
  if [ -L "$dst" ]; then
    echo "ok      $name (already linked)"
  elif [ -e "$dst" ]; then
    echo "skip    $name (exists and is not our symlink — resolve manually)" >&2
  else
    ln -s "${skill%/}" "$dst"
    echo "linked  $name -> $dst"
  fi
done

echo
echo "agb CLI: run 'npm install' here, then 'npm link' (or call bin/agb.mjs directly)."
echo "adlc tools on Antigravity quota: export ADLC_PROVIDER=agy"
