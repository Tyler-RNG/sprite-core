#!/usr/bin/env bash
# Build the SpriteCore plugin from this checkout and install it into a local
# OpenClaw installation. Use this when you want to test changes against a real
# gateway without publishing to npm.
#
# Default install target is ~/.openclaw/app (where `npm i -g openclaw` lands).
# Override with --install-dir <path> or OPENCLAW_INSTALL_DIR.
#
# What it does:
#   1. Build the UI (pnpm --filter @tylerwarburton/sprite-core-ui build)
#   2. npm pack the plugin (honors package.json "files" — same tarball publish ships)
#   3. Atomically swap the tarball contents into
#        <install-dir>/node_modules/@tylerwarburton/sprite-core/
#   4. Restart the openclaw gateway via `openclaw daemon restart` if available,
#      otherwise print the manual restart command.
#
# What it does NOT do:
#   - Touch your openclaw.json. You still need to enable the plugin yourself
#     (see packages/plugin/README.md → "Enable").
#   - Install runtime deps. The plugin only depends on `openclaw` (peer) which
#     the install target already has.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/packages/plugin"
INSTALL_DIR="${OPENCLAW_INSTALL_DIR:-$HOME/.openclaw/app}"
SKIP_BUILD=0
SKIP_RESTART=0

usage() {
  sed -n '2,22p' "$0"
  cat <<EOF

Usage: $(basename "$0") [--install-dir <path>] [--skip-build] [--skip-restart]

Flags:
  --install-dir <path>  Target openclaw install (default: $HOME/.openclaw/app)
  --skip-build          Reuse existing ui-dist/ (faster for retries)
  --skip-restart        Don't restart the gateway after installing
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-restart) SKIP_RESTART=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
done

log() { printf '\033[36m== %s\033[0m\n' "$*"; }

if [[ ! -d "$INSTALL_DIR" ]]; then
  echo "error: openclaw install dir not found: $INSTALL_DIR" >&2
  echo "  install openclaw first, or pass --install-dir <path>" >&2
  exit 1
fi
if [[ ! -d "$INSTALL_DIR/node_modules" ]]; then
  echo "error: $INSTALL_DIR has no node_modules/. Is this really an openclaw install?" >&2
  exit 1
fi

# 1. Build the UI bundle. The plugin tarball includes ui-dist/ via the "files"
#    field, so the build must run before npm pack.
if [[ $SKIP_BUILD -eq 0 ]]; then
  log "building UI bundle"
  (cd "$REPO_ROOT" && pnpm --filter @tylerwarburton/sprite-core-ui build)
else
  log "skipping UI build (--skip-build)"
fi

UI_DIST="$PLUGIN_DIR/ui-dist"
if [[ ! -f "$UI_DIST/index.html" ]]; then
  echo "error: UI bundle missing at $UI_DIST/index.html" >&2
  echo "  re-run without --skip-build" >&2
  exit 1
fi

# 2. Pack the plugin. Matches what `npm publish` would ship.
STAGE_DIR="$(mktemp -d /tmp/sprite-core-install.XXXXXX)"
trap 'rm -rf "$STAGE_DIR"' EXIT
log "packing plugin tarball"
(cd "$PLUGIN_DIR" && npm pack --ignore-scripts --pack-destination "$STAGE_DIR" >/dev/null)
TARBALL="$(ls "$STAGE_DIR"/*.tgz | head -n1)"
echo "   $TARBALL"

# 3. Atomic swap into <install-dir>/node_modules/@tylerwarburton/sprite-core/
TARGET="$INSTALL_DIR/node_modules/@tylerwarburton/sprite-core"
NEW_DIR="${TARGET}.new"
rm -rf "$NEW_DIR"
mkdir -p "$NEW_DIR"
tar -xzf "$TARBALL" --strip-components=1 -C "$NEW_DIR"

if [[ -d "$TARGET" ]]; then
  rm -rf "${TARGET}.prev"
  mv "$TARGET" "${TARGET}.prev"
fi
mv "$NEW_DIR" "$TARGET"
log "installed @tylerwarburton/sprite-core at $TARGET"

# 4. Restart the gateway so it picks up the new plugin.
if [[ $SKIP_RESTART -eq 1 ]]; then
  echo "   skipping gateway restart (--skip-restart)"
  echo "   restart manually: openclaw daemon restart"
  exit 0
fi

if command -v openclaw >/dev/null 2>&1; then
  log "restarting openclaw gateway"
  openclaw daemon restart || {
    echo "   gateway restart failed — restart it manually so the new plugin code is loaded" >&2
    exit 1
  }
else
  echo "   openclaw CLI not on PATH — restart your gateway manually so the new plugin code is loaded"
fi

log "done. Verify with: curl -sI http://localhost:18789/sprite-core/ui/"
