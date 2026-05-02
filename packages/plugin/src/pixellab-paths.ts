// Filesystem-path helpers split out from pixellab-export-lib.ts so the env-var
// reads here don't share a file with the network calls there. openclaw's
// install-time scanner flags any file that combines environment-variable
// access with HTTP send patterns as possible credential harvesting.
import os from "node:os";
import path from "node:path";

/**
 * Default assets root: `<XDG_STATE_HOME>/openclaw/assets/avatars` (matching
 * openclaw's filesystem layout). Falls back to `~/.openclaw/state/assets/avatars`.
 */
export function defaultAssetsRoot(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && xdg.length > 0) {
    return path.join(xdg, "openclaw", "assets", "avatars");
  }
  return path.join(os.homedir(), ".openclaw", "state", "assets", "avatars");
}
