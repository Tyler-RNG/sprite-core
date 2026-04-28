#!/usr/bin/env bash
# Sync the standalone sprite-core plugin into an openclaw checkout.
#
# The running gateway loads the bundled plugin from openclaw-src/extensions/
# sprite-core (and its dist-runtime mirror), not from this standalone repo.
# This script promotes the standalone repo's sources into that location so a
# subsequent `~/.openclaw/deploy.sh` run picks them up.
#
# Usage: scripts/sync-to-openclaw.sh [openclaw-src-root]
#   openclaw-src-root defaults to ~/openclaw-src.
#
# What gets synced:
#   - Plugin entry   (index.ts)
#   - Plugin sources (src/*.ts, excluding *.test.ts)
#   - Plugin manifest (openclaw.plugin.json)
#   - Built UI bundle (ui-dist/)  — build it first with
#       pnpm --filter @tylerwarburton/sprite-core-ui build
#   - Auxiliary content (scripts/, template/, .agents/skills/) as before
#
# What is NOT synced:
#   - package.json — openclaw-src has its own (@openclaw/sprite-core, workspace
#     deps against the SDK). Don't overwrite it.
#   - Tests (*.test.ts) — openclaw-src runs its own test suite.

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

# Plugin entry, sources, and manifest.
cp "$SPRITE_CORE_ROOT/packages/plugin/index.ts" "$DEST/index.ts"
cp "$SPRITE_CORE_ROOT/packages/plugin/openclaw.plugin.json" "$DEST/openclaw.plugin.json"
mkdir -p "$DEST/src"
rsync -a --delete --exclude='*.test.ts' \
  "$SPRITE_CORE_ROOT/packages/plugin/src/" "$DEST/src/"

# Built UI bundle — required for GET /sprite-core/ui to work post-deploy.
# If the build hasn't been run, fail early with a clear message.
UI_DIST="$SPRITE_CORE_ROOT/packages/plugin/ui-dist"
if [[ ! -d "$UI_DIST" || ! -f "$UI_DIST/index.html" ]]; then
  echo "error: UI bundle missing at $UI_DIST" >&2
  echo "  build it first: pnpm --filter @tylerwarburton/sprite-core-ui build" >&2
  exit 1
fi
mkdir -p "$DEST/ui-dist"
rsync -a --delete "$UI_DIST/" "$DEST/ui-dist/"

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
