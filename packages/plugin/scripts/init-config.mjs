#!/usr/bin/env node
// First-run bootstrap for @tylerwarburton/sprite-core.
//
// Seeds a minimal but working `plugins.entries["sprite-core"].config` block in
// the user's openclaw.json and copies the placeholder agent atlas into the
// assets directory so the plugin renders something the moment the gateway
// restarts. Idempotent — does nothing if a config block already exists.
//
// Usage:
//   node ~/.openclaw/extensions/sprite-core/scripts/init-config.mjs
//
// Honors OPENCLAW_CONFIG_PATH if set; otherwise defaults to
// ~/.openclaw/openclaw.json. After running, restart the gateway.

import { mkdir, writeFile, cp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readUtf8 } from "./_pixellab-fs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.dirname(here);

function configPath() {
  if (process.env.OPENCLAW_CONFIG_PATH) return process.env.OPENCLAW_CONFIG_PATH;
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

function assetsRoot() {
  if (process.env.OPENCLAW_STATE_DIR) {
    return path.join(process.env.OPENCLAW_STATE_DIR, "assets");
  }
  return path.join(os.homedir(), ".openclaw", "state", "assets");
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_CONFIG = {
  assets: { enabled: true, assetsDir: "./assets" },
  agents: {
    agent: {
      avatar: {
        kind: "atlas",
        default: "idle",
        manifest: "avatars/agent/agent.atlas.json",
      },
      prompting: {
        descriptions: {
          idle: "calm / listening",
          thinking: "processing the user's request",
          happy: "warm / pleased",
          sad: "sympathy / disappointment",
        },
      },
    },
  },
};

async function main() {
  const cfgPath = configPath();
  if (!(await pathExists(cfgPath))) {
    console.error(`✗ openclaw config not found at ${cfgPath}`);
    console.error("  Run openclaw once to create it, then re-run this script.");
    process.exit(1);
  }

  const raw = await readUtf8(cfgPath);
  const cfg = JSON.parse(raw);

  cfg.plugins ??= {};
  cfg.plugins.entries ??= {};
  cfg.plugins.entries["sprite-core"] ??= {};
  const entry = cfg.plugins.entries["sprite-core"];

  const hasConfig =
    entry.config && typeof entry.config === "object" && Object.keys(entry.config).length > 0;
  if (hasConfig) {
    console.log("✓ sprite-core config already present in openclaw.json — not modifying.");
    console.log(`  ${cfgPath}`);
    console.log("  To start fresh, remove plugins.entries.sprite-core.config and re-run.");
  } else {
    entry.enabled = true;
    entry.config = DEFAULT_CONFIG;
    const trailingNewline = raw.endsWith("\n") ? "\n" : "";
    const backupPath = `${cfgPath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await writeFile(backupPath, raw);
    await writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}${trailingNewline}`);
    console.log("✓ seeded plugins.entries.sprite-core in openclaw.json");
    console.log(`  config:  ${cfgPath}`);
    console.log(`  backup:  ${backupPath}`);
  }

  // Copy placeholder atlas into <assetsDir>/avatars/agent/ if missing.
  const targetDir = path.join(assetsRoot(), "avatars", "agent");
  if (!(await pathExists(path.join(targetDir, "agent.atlas.json")))) {
    const templateDir = path.join(pluginRoot, "template", "agent");
    await mkdir(targetDir, { recursive: true });
    for (const file of ["agent.atlas.json", "agent.atlas.webp"]) {
      await cp(path.join(templateDir, file), path.join(targetDir, file));
    }
    console.log(`✓ installed placeholder agent atlas at ${targetDir}`);
  } else {
    console.log(`✓ agent atlas already present at ${targetDir} — not overwriting`);
  }

  console.log("");
  console.log("Next steps:");
  console.log("  1. Restart the gateway (systemctl --user restart openclaw-gateway,");
  console.log("     or kill + relaunch via the menubar app).");
  console.log("  2. Visit http(s)://<your-gateway>/sprite-core/ui to verify.");
  console.log("  3. Optional: replace the placeholder atlas (see");
  console.log("     ~/.openclaw/extensions/sprite-core/template/agent/README.md or");
  console.log("     ask Claude to run the openclaw-pixellab-avatar skill).");
}

main().catch((err) => {
  console.error(`init-config failed: ${err?.message ?? err}`);
  process.exit(1);
});
