#!/usr/bin/env bash
# Sync the standalone sprite-core plugin into an openclaw checkout.
#
# The running gateway loads the bundled plugin from openclaw-src/extensions/
# sprite-core (and its dist-runtime mirror), not from this standalone repo.
# While the standalone repo is being developed, mirror skills + scripts +
# template over so live agents pick up changes.
#
# Usage: scripts/sync-to-openclaw.sh [openclaw-src-root]
#   openclaw-src-root defaults to ~/openclaw-src.

set -euo pipefail

SPRITE_CORE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPENCLAW_ROOT="${1:-$HOME/openclaw-src}"
DEST="$OPENCLAW_ROOT/extensions/sprite-core"

if [[ ! -d "$DEST" ]]; then
  echo "error: destination not found: $DEST" >&2
  echo "  pass the openclaw-src root as the first arg, or symlink it to ~/openclaw-src" >&2
  exit 1
fi

echo "sprite-core sync"
echo "  source: $SPRITE_CORE_ROOT"
echo "  dest:   $DEST"

# Scripts and template are 1:1 mirrors — no path rewrites needed.
mkdir -p "$DEST/scripts" "$DEST/template"
rsync -a --delete \
  "$SPRITE_CORE_ROOT/packages/plugin/scripts/" "$DEST/scripts/"
rsync -a --delete \
  "$SPRITE_CORE_ROOT/packages/plugin/template/" "$DEST/template/"

# Skills live under .agents/skills/. Mirror the directory, then rewrite the
# SKILL.md paths from plugin-rooted ("scripts/foo.mjs", "README.md") to
# monorepo-rooted ("extensions/sprite-core/scripts/foo.mjs",
# "extensions/sprite-core/README.md") so the deployed skill resolves files
# correctly when executed from the openclaw-src repo root.
mkdir -p "$DEST/.agents/skills"
rsync -a --delete \
  "$SPRITE_CORE_ROOT/.agents/skills/" "$DEST/.agents/skills/"

SKILL_FILE="$DEST/.agents/skills/openclaw-pixellab-avatar/SKILL.md"
if [[ -f "$SKILL_FILE" ]]; then
  sed -i \
    -e 's|node scripts/pixellab-|node extensions/sprite-core/scripts/pixellab-|g' \
    -e 's|^- `README.md`|- `extensions/sprite-core/README.md`|g' \
    -e 's|^- `template/agent/README.md`|- `extensions/sprite-core/template/agent/README.md`|g' \
    "$SKILL_FILE"
  echo "  rewrote paths in $(basename "$SKILL_FILE")"
fi

echo "done."
