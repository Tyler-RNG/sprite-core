#!/usr/bin/env node
// PixelLab → SpriteCore atlas exporter.
//
// Downloads a finished pixellab.ai character bundle by UUID, extracts the per-
// animation PNG frames, packs them into a SpriteCore-compatible WebP atlas +
// manifest, and writes the result directly to the plugin-expected location:
//
//   <assetsDir>/avatars/<agentId>/
//   ├── <agentId>.atlas.webp
//   └── <agentId>.atlas.json
//
// Originally a Python script (`export_char4.py`) that lived outside the plugin
// tree. Ported here so the plugin owns the create→ship pipeline end-to-end and
// uses the same image stack (sharp) as `pnpm avatar:pack`.
//
// Usage:
//   node scripts/pixellab-export.mjs --uid <pixellab-uuid> [opts]
//
//   --uid <id>           PixelLab character UUID (required)
//   --name <text>        Override character name (otherwise read from the bundle metadata)
//   --agent-id <id>      Override agent id (otherwise derived from --name)
//   --assets-root <dir>  SpriteCore assets root (default: ~/.openclaw/state/assets/avatars)
//   --workspace <dir>    Scratch dir for the downloaded zip + extraction
//                        (default: <assets-root>/.pixellab-cache)
//   --skip-download      Use an existing zip in the workspace instead of fetching
//   --skip-extract       Use an already-extracted directory
//   --overwrite          Replace existing output without prompting
//   --dry-run            Print the plan without writing anything
//
// Auth: reads PIXELLAB_API_KEY from the environment. If unset, falls back to
// `pass show pixellab/api-key` when `pass` is on PATH (matches the upstream
// Python exporter's behavior). Operators on other secret stores can pipe a
// custom command via --api-key-command. Never commit the key.

import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import sharp from "sharp";

const PIXELLAB_API_BASE = "https://api.pixellab.ai/v2";
const ATLAS_COLS = 7; // matches the 1024×1024 / 136-px-frame layout used upstream
const DEFAULT_ATLAS_SIDE = 1024;

// Fallback slug → canonical-emotion rename map applied when the pixellab
// `/characters/<id>/animations` metadata endpoint returns 404 (often) and the
// operator did not pass `--rename`. These substrings mirror the default
// prompts in `pixellab-animate.mjs`. Without this, the manifest ends up with
// verbose state keys like `big_open-mouth_smile_eyes_bright_and_crinkled_in_j`
// that break the SpriteCore state contract. User-supplied `--rename` overrides
// these (so a stoic character with a custom "warm smile" prompt can still map
// cleanly). Match is case-insensitive substring after normalizing `_`/`-` to
// spaces.
const DEFAULT_CANONICAL_RENAMES = {
  idle: "gentle breathing",
  thinking: "hand on chin",
  happy: "big open mouth smile",
  sad: "shoulders slumped",
  angry: "clenched teeth",
  surprised: "mouth agape",
  love: "eyes becoming hearts",
  wink: "playful wink",
  smile: "warm genuine smile",
  frown: "disappointed frown",
  sleepy: "drowsy half closed",
  annoyed: "frustrated eye roll",
};

// Full human-readable descriptions for each canonical emotion. Used to
// override pixellab's 50-char-truncated slug description when the rename
// step matched a canonical emotion. Keys match `DEFAULT_CANONICAL_RENAMES`
// and `pixellab-animate.mjs#DEFAULT_PROMPTS` (the prompt text we fed
// pixellab to generate the animation in the first place). Without this,
// snippets look like `"description": "big open-mouth smile eyes bright and
// crinkled in j"` (chopped mid-word by the pixellab slug limit).
const DEFAULT_CANONICAL_DESCRIPTIONS = {
  idle: "standing still, gentle breathing, subtle weight shift side to side",
  thinking: "hand on chin, eyes glancing upward, head tilting thoughtfully, pondering",
  happy: "big open-mouth smile, eyes bright and crinkled in joy, slight excited bounce",
  sad: "head lowered, eyes downcast, shoulders slumped, downturned mouth, sorrowful",
  angry: "furrowed brow, clenched teeth, fists tightened, body leaning forward, frustrated",
  surprised: "eyes wide open, mouth agape, slight step back, arms raised, shocked",
  love: "eyes becoming hearts, cheeks blushing pink, hands clasped near chest, shy adoring smile",
  wink: "one eye closed in a playful wink, confident smirk, slight head tilt, finger-gun gesture",
  smile: "gentle mouth curving from neutral to a warm genuine smile, eyes softening",
  frown: "neutral expression turning to a disappointed frown, brow slightly furrowed",
  sleepy: "eyes transitioning from alert to drowsy half-closed, head gently nodding, yawning",
  annoyed: "neutral turning to frustrated eye roll, arms crossing, exasperated sigh",
};

function parseArgs(argv) {
  const opts = {
    uid: null,
    name: null,
    agentId: null,
    assetsRoot: null,
    workspace: null,
    apiKeyCommand: null,
    rename: {},
    skipDownload: false,
    skipExtract: false,
    overwrite: false,
    dryRun: false,
    voiceId: null,
    voiceAuto: false,
    listVoices: false,
    elevenApiKeyCommand: null,
    apply: false,
    configPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--uid":
        opts.uid = argv[++i];
        break;
      case "--name":
        opts.name = argv[++i];
        break;
      case "--agent-id":
        opts.agentId = argv[++i];
        break;
      case "--assets-root":
        opts.assetsRoot = argv[++i];
        break;
      case "--workspace":
        opts.workspace = argv[++i];
        break;
      case "--api-key-command":
        opts.apiKeyCommand = argv[++i];
        break;
      case "--rename": {
        // Comma-separated `target:substring` pairs. Each pixellab animation
        // whose folder slug or animation_type contains the substring gets
        // renamed to the target. Case-insensitive substring match. Example:
        //   --rename "idle:standing still,thinking:hand on chin,happy:warm smile"
        const raw = argv[++i] ?? "";
        for (const pair of raw.split(",")) {
          const [target, ...rest] = pair.split(":");
          const needle = rest.join(":").trim().toLowerCase();
          const clean = (target ?? "").trim();
          if (clean && needle) {
            opts.rename[clean] = needle;
          }
        }
        break;
      }
      case "--skip-download":
        opts.skipDownload = true;
        break;
      case "--skip-extract":
        opts.skipExtract = true;
        break;
      case "--overwrite":
        opts.overwrite = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--voice-id":
        opts.voiceId = argv[++i];
        break;
      case "--voice":
        // Sugar: `--voice auto` picks the first voice from the user's
        // ElevenLabs library. Any other value is treated as a voice id.
        {
          const v = argv[++i];
          if (v === "auto") {
            opts.voiceAuto = true;
          } else {
            opts.voiceId = v;
          }
        }
        break;
      case "--list-voices":
        opts.listVoices = true;
        break;
      case "--elevenlabs-api-key-command":
        opts.elevenApiKeyCommand = argv[++i];
        break;
      case "--apply":
        // Patch the generated snippet directly into openclaw.json under
        // `plugins.entries["sprite-core"].config.agents.<agent-id>`. Backs
        // up the existing config with a timestamp suffix before writing.
        opts.apply = true;
        break;
      case "--config-path":
        opts.configPath = argv[++i];
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          console.error(`Unknown option: ${arg}`);
          printUsage();
          process.exit(2);
        }
    }
  }
  if (opts.listVoices) {
    return opts;
  }
  if (!opts.uid) {
    console.error("Missing required --uid");
    printUsage();
    process.exit(2);
  }
  return opts;
}

function printUsage() {
  const here = path.relative(process.cwd(), fileURLToPath(import.meta.url));
  console.error(`Usage: node ${here} --uid <pixellab-uuid> [options]`);
  console.error("");
  console.error("  --uid <id>           PixelLab character UUID (required)");
  console.error("  --name <text>        Override character name from metadata");
  console.error("  --agent-id <id>      Override derived agent id");
  console.error(
    "  --assets-root <dir>  SpriteCore assets root (default: ~/.openclaw/state/assets/avatars)",
  );
  console.error("  --workspace <dir>    Scratch dir for download + extract");
  console.error("  --api-key-command <cmd>  Shell command whose stdout is the API key");
  console.error("                           (e.g. 'pass show pixellab/api-key'); fallback path");
  console.error("                           when PIXELLAB_API_KEY is unset");
  console.error("  --skip-download      Reuse existing zip in workspace");
  console.error("  --skip-extract       Reuse already-extracted directory");
  console.error("  --overwrite          Replace existing output");
  console.error("  --dry-run            Print the plan without writing");
  console.error("");
  console.error("  Voice (ElevenLabs):");
  console.error("  --voice-id <id>      Include a voice block in the printed snippet");
  console.error("  --voice auto         Pick the first voice from the ElevenLabs library");
  console.error("  --list-voices        List available ElevenLabs voices and exit");
  console.error("  --elevenlabs-api-key-command <cmd>  Stdout is the ElevenLabs API key;");
  console.error("                       fallback when ELEVENLABS_API_KEY env is unset");
  console.error("");
  console.error("  Config apply:");
  console.error("  --apply              Patch openclaw.json directly (backed up first)");
  console.error("  --config-path <p>    Override openclaw.json location (default: ~/.openclaw/openclaw.json)");
}

/**
 * Patch `plugins.entries["sprite-core"].config.agents.<agentId>` in
 * openclaw.json with the freshly-generated block. Writes a timestamped
 * backup next to the config before overwriting. Creates any missing
 * intermediate objects so fresh configs still work.
 *
 * The gateway reads config at startup, so the caller still needs to
 * restart the gateway for the new block to become visible — we print a
 * reminder but deliberately do NOT auto-restart (visible side effect
 * the operator should own).
 */
async function applyToConfig({ agentId, agentBlock, configPath }) {
  const resolved = path.resolve(
    configPath ?? path.join(os.homedir(), ".openclaw", "openclaw.json"),
  );
  let raw;
  try {
    raw = await readFile(resolved, "utf8");
  } catch (err) {
    throw new Error(`--apply: cannot read ${resolved}: ${err.message}`, { cause: err });
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--apply: ${resolved} is not valid JSON: ${err.message}`, { cause: err });
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  const backup = `${resolved}.pre-apply-${timestamp}`;
  await writeFile(backup, raw);

  cfg.plugins ??= {};
  cfg.plugins.entries ??= {};
  cfg.plugins.entries["sprite-core"] ??= { enabled: true, config: {} };
  cfg.plugins.entries["sprite-core"].config ??= {};
  cfg.plugins.entries["sprite-core"].config.agents ??= {};
  const existed =
    agentId in cfg.plugins.entries["sprite-core"].config.agents;
  cfg.plugins.entries["sprite-core"].config.agents[agentId] = agentBlock;

  // Preserve trailing newline behavior from the source so diffs stay clean.
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  await writeFile(resolved, `${JSON.stringify(cfg, null, 2)}${trailingNewline}`);

  console.log("");
  console.log(`✓ applied to ${resolved}`);
  console.log(`  ${existed ? "replaced" : "added"} plugins.entries["sprite-core"].config.agents.${agentId}`);
  console.log(`  backup: ${backup}`);
  console.log("");
  console.log("↻ restart the gateway to pick up the new entry:");
  console.log("  pkill -9 -f openclaw-gateway; nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &");
}

function resolveApiKey(apiKeyCommand) {
  const fromEnv = process.env.PIXELLAB_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (apiKeyCommand) {
    try {
      const out = execFileSync("sh", ["-c", apiKeyCommand], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }).trim();
      if (out) {
        return out;
      }
    } catch (err) {
      console.error(`--api-key-command failed: ${err.message}`);
      process.exit(1);
    }
  }
  // Fallback: Unix password-store. Matches the upstream Python exporter's
  // behavior on machines where `pass show pixellab/api-key` is already set up.
  try {
    const out = execFileSync("pass", ["show", "pixellab/api-key"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) {
      return out;
    }
  } catch {
    // pass isn't installed or doesn't have that entry — fall through
  }
  console.error("No pixellab API key available.");
  console.error("  Either export PIXELLAB_API_KEY=<key> in the shell that runs this script,");
  console.error("  or pass --api-key-command '<cmd whose stdout is the key>',");
  console.error("  or put the key in `pass` as `pixellab/api-key`.");
  process.exit(1);
  return ""; // unreachable; keeps consistent-return happy
}

function resolveElevenLabsKey(apiKeyCommand) {
  const fromEnv = process.env.ELEVENLABS_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (apiKeyCommand) {
    try {
      const out = execFileSync("sh", ["-c", apiKeyCommand], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }).trim();
      if (out) {
        return out;
      }
    } catch (err) {
      console.error(`--elevenlabs-api-key-command failed: ${err.message}`);
      return null;
    }
  }
  try {
    const out = execFileSync("pass", ["show", "elevenlabs/api-key"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) {
      return out;
    }
  } catch {
    // pass not available or entry missing — silent; caller decides fallback.
  }
  return null;
}

async function fetchElevenLabsVoices(apiKey) {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs /v1/voices returned ${res.status}`);
  }
  const body = await res.json();
  const voices = Array.isArray(body?.voices) ? body.voices : [];
  return voices.map((v) => ({
    voiceId: v.voice_id,
    name: v.name,
    category: v.category ?? null,
    labels: v.labels ?? {},
  }));
}

function resolveAssetsRoot(overrideArg) {
  if (overrideArg) {
    return path.resolve(overrideArg);
  }
  // Match SpriteCore's default: `resolveStateDir()` is `~/.openclaw` and the
  // plugin's assetsDir default is `./assets`, so the effective path is
  // `~/.openclaw/assets/avatars`. Operators with a custom assetsDir should
  // pass --assets-root.
  return path.join(os.homedir(), ".openclaw", "assets", "avatars");
}

function resolveWorkspace(overrideArg, assetsRoot) {
  if (overrideArg) {
    return path.resolve(overrideArg);
  }
  return path.join(assetsRoot, ".pixellab-cache");
}

function deriveAgentId(name) {
  return (
    name
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/-+/g, "_")
      .replace(/[^a-z0-9_]/g, "")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50) || "character"
  );
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch per-animation metadata from the pixellab API. Returns a map keyed by
 * the 8-char prefix of the animation_group_id (which matches the suffix on
 * each animation folder inside the zip), or null if the fetch fails. Used to
 * upgrade zip folder slugs like `warm_smile_bright_eyes_joyful-bca42649`
 * into clean canonical names (`happy`) and to surface `display_name` as a
 * description in the generated config snippet.
 */
async function fetchAnimationMetadata({ uid, apiKey }) {
  if (!apiKey || apiKey === "dry-run-noop") {
    return null;
  }
  let res;
  try {
    res = await fetch(`${PIXELLAB_API_BASE}/characters/${encodeURIComponent(uid)}/animations`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    console.warn(`  animation metadata fetch failed (${err.message}) — falling back to slug names`);
    return null;
  }
  if (!res.ok) {
    console.warn(`  animation metadata fetch returned ${res.status} — falling back to slug names`);
    return null;
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(body?.animations)) {
    return null;
  }
  const map = new Map();
  for (const a of body.animations) {
    if (!a?.animation_group_id || typeof a.animation_group_id !== "string") {
      continue;
    }
    const prefix = a.animation_group_id.slice(0, 8).toLowerCase();
    map.set(prefix, {
      animationType: typeof a.animation_type === "string" ? a.animation_type : null,
      displayName:
        typeof a.display_name === "string" && a.display_name.trim() ? a.display_name.trim() : null,
      frameCount: a.directions?.[0]?.frame_count ?? 0,
    });
  }
  return map;
}

/**
 * Prettify a zip animation slug for use as a description.
 * `warm_smile_bright_eyes_joyful_expression` → `warm smile bright eyes joyful expression`
 */
function prettifySlug(slug) {
  return slug.replace(/_+/g, " ").trim();
}

async function downloadCharacterZip({ uid, apiKey, zipPath, skipDownload }) {
  if (skipDownload) {
    if (!(await pathExists(zipPath))) {
      console.error(`--skip-download requested but ${zipPath} does not exist`);
      process.exit(1);
    }
    console.log(`  reusing existing zip: ${zipPath}`);
    return;
  }
  console.log(`  fetching pixellab character ${uid}…`);
  const url = `${PIXELLAB_API_BASE}/characters/${encodeURIComponent(uid)}/zip`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`pixellab API error: ${res.status} ${res.statusText}`);
    if (body) {
      console.error(body.slice(0, 500));
    }
    process.exit(1);
  }
  if (!res.body) {
    console.error("pixellab API returned an empty body");
    process.exit(1);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath));
  const size = (await stat(zipPath)).size;
  if (size === 0) {
    console.error("downloaded zip is empty");
    process.exit(1);
  }
  console.log(`  downloaded ${size.toLocaleString()} bytes`);
}

async function extractZip({ zipPath, extractDir, skipExtract, overwrite }) {
  if (skipExtract) {
    if (!(await pathExists(extractDir))) {
      console.error(`--skip-extract requested but ${extractDir} does not exist`);
      process.exit(1);
    }
    console.log(`  reusing existing extraction: ${extractDir}`);
    return;
  }
  if (await pathExists(extractDir)) {
    if (!overwrite) {
      console.error(`extraction dir already exists: ${extractDir}`);
      console.error("re-run with --overwrite or --skip-extract");
      process.exit(1);
    }
    await rm(extractDir, { recursive: true, force: true });
  }
  await mkdir(extractDir, { recursive: true });
  const zipBytes = await readFile(zipPath);
  const zip = await JSZip.loadAsync(zipBytes);
  const entries = Object.values(zip.files);
  for (const entry of entries) {
    const dest = path.join(extractDir, entry.name);
    if (entry.dir) {
      await mkdir(dest, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(dest), { recursive: true });
    const buf = await entry.async("nodebuffer");
    await writeFile(dest, buf);
  }
  console.log(`  extracted ${entries.length} entries to ${extractDir}`);
}

async function detectCharacterName(extractDir, fallback) {
  const metaPath = path.join(extractDir, "metadata.json");
  if (!(await pathExists(metaPath))) {
    return fallback || "character";
  }
  try {
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    // PixelLab bundles nest the character under `character.name`. Top-level
    // `name` is a fallback in case the shape ever flattens.
    const candidates = [meta?.character?.name, meta?.name];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        const trimmed = candidate.trim();
        return trimmed.length > 50 ? trimmed.slice(0, 50) : trimmed;
      }
    }
  } catch {
    // fall through to fallback
  }
  return fallback || "character";
}

/**
 * Walk the extracted bundle's animations/ tree, split each folder into
 * `<slug>-<short-hash>`, and (if we have API metadata) upgrade the state
 * name from the verbose slug to the clean canonical `animation_type`.
 * Duplicate canonical names get `_2`, `_3`, … suffixes so they stay
 * distinct in the atlas manifest.
 */
async function detectAnimationDirs(extractDir, apiMetadata, renameMap) {
  const animationsRoot = path.join(extractDir, "animations");
  if (!(await pathExists(animationsRoot))) {
    return [];
  }
  const { readdir } = await import("node:fs/promises");
  const dirents = await readdir(animationsRoot, { withFileTypes: true });

  // User-supplied renames override defaults so custom per-character prompts
  // still land on canonical emotion keys.
  const mergedRenames = { ...DEFAULT_CANONICAL_RENAMES, ...renameMap };
  const renameEntries = Object.entries(mergedRenames);
  // Normalize `_` and `-` to spaces so natural-language needles
  // (e.g. "standing still") match underscored pixellab slugs
  // (e.g. "standing_still_breathing_gently").
  const normalize = (s) => s.toLowerCase().replace(/[_-]+/g, " ");
  const tryRename = (slug, apiType) => {
    if (renameEntries.length === 0) {
      return null;
    }
    const haystacks = [slug, apiType].filter(Boolean).map(normalize);
    for (const [target, needle] of renameEntries) {
      const n = normalize(needle);
      if (haystacks.some((h) => h.includes(n))) {
        return target;
      }
    }
    return null;
  };

  const raw = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const folder = dirent.name;
    // `<slug>-<8-char-hash>` — split from the right so slugs with dashes
    // don't clobber the hash.
    const lastDash = folder.lastIndexOf("-");
    const slug = lastDash >= 0 ? folder.slice(0, lastDash) : folder;
    const hashPrefix = lastDash >= 0 ? folder.slice(lastDash + 1).toLowerCase() : "";
    const facingDir = path.join(animationsRoot, folder, "south");
    if (!(await pathExists(facingDir))) {
      continue;
    }

    const apiEntry = apiMetadata?.get(hashPrefix) ?? null;
    const apiType = apiEntry?.animationType?.trim();
    const renamed = tryRename(slug, apiType);
    const cleanName = renamed ?? apiType ?? slug;
    // Prefer the canonical full-prompt description over pixellab's truncated
    // slug when we renamed into a known canonical emotion. User-supplied
    // display_name (from the API metadata endpoint) still wins when present.
    const canonicalDescription =
      renamed && DEFAULT_CANONICAL_DESCRIPTIONS[renamed]
        ? DEFAULT_CANONICAL_DESCRIPTIONS[renamed]
        : null;
    const description =
      apiEntry?.displayName || canonicalDescription || prettifySlug(slug);
    raw.push({
      dir: facingDir,
      slug,
      cleanName,
      description,
      frameCount: apiEntry?.frameCount ?? 0,
    });
  }

  // Sort deterministically so re-runs produce the same output order.
  raw.sort((a, b) => a.slug.localeCompare(b.slug));

  // Dedupe canonical names — two animations with the same `animation_type`
  // (common when a character has both "held pose" and "transition-to"
  // variants) collide on the SpriteCore state key. Suffix each collision
  // with _2/_3/... so the manifest stays valid. (A smarter follow-up is
  // phased-state pairing; left for v2.)
  const seen = new Map();
  for (const entry of raw) {
    const count = (seen.get(entry.cleanName) ?? 0) + 1;
    seen.set(entry.cleanName, count);
    entry.name = count === 1 ? entry.cleanName : `${entry.cleanName}_${count}`;
  }

  return raw.map((e) => ({
    name: e.name,
    dir: e.dir,
    description: e.description,
  }));
}

async function listFrames(animDir) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(animDir);
  return entries
    .filter((f) => /^frame_.*\.png$/i.test(f))
    .toSorted()
    .map((f) => path.join(animDir, f));
}

async function processAnimation({ name, description, frames, framesOutDir }) {
  if (frames.length === 0) {
    console.log(`  ${name}: no frames, skipping`);
    return null;
  }
  await mkdir(framesOutDir, { recursive: true });
  const frameKeys = [];
  for (let i = 0; i < frames.length; i++) {
    const dest = path.join(framesOutDir, `${String(i).padStart(2, "0")}.webp`);
    try {
      await sharp(frames[i]).webp({ quality: 95 }).toFile(dest);
      frameKeys.push(`${name}/${String(i).padStart(2, "0")}`);
    } catch (err) {
      console.warn(`    failed to convert ${frames[i]}: ${err.message}`);
    }
  }
  if (frameKeys.length === 0) {
    return null;
  }
  // Match the upstream Python heuristic: thinking-style states play once and
  // hold the final frame; everything else loops.
  const isHoldOnce = name === "thinking" || name === "contemplative";
  return {
    name,
    description,
    frameCount: frames.length,
    fps: frames.length > 5 ? 10 : 15,
    loop: isHoldOnce ? "once" : "infinite",
    holdLastFrame: isHoldOnce,
    frameKeys,
  };
}

async function buildAtlas({ framesRoot, atlasOut }) {
  // Walk frames in stable order (sorted animation dirs, sorted webp files)
  // so the manifest's frame rect lookup matches the on-disk layout. Mirrors
  // the Python packer's grid algorithm exactly so existing manifests remain
  // bit-stable when re-run.
  const { readdir } = await import("node:fs/promises");
  const allFrames = [];
  const animDirs = (await readdir(framesRoot)).toSorted();
  for (const animDir of animDirs) {
    const abs = path.join(framesRoot, animDir);
    const st = await stat(abs);
    if (!st.isDirectory()) {
      continue;
    }
    const files = (await readdir(abs)).filter((f) => f.endsWith(".webp")).toSorted();
    for (const f of files) {
      allFrames.push(path.join(abs, f));
    }
  }
  if (allFrames.length === 0) {
    throw new Error("no frames available for atlas packing");
  }

  const firstMeta = await sharp(allFrames[0]).metadata();
  const frameW = firstMeta.width ?? 0;
  const frameH = firstMeta.height ?? 0;
  if (!frameW || !frameH) {
    throw new Error(`could not read frame dimensions from ${allFrames[0]}`);
  }

  const cols = ATLAS_COLS;
  const rows = Math.ceil(allFrames.length / cols);
  const atlasW = DEFAULT_ATLAS_SIDE;
  const atlasH = Math.max(DEFAULT_ATLAS_SIDE, rows * frameH);

  console.log(
    `  packing ${allFrames.length} frames into ${atlasW}x${atlasH} (${cols} cols × ${rows} rows, frame ${frameW}x${frameH})`,
  );

  const composites = await Promise.all(
    allFrames.map(async (frame, i) => ({
      input: await readFile(frame),
      left: (i % cols) * frameW,
      top: Math.floor(i / cols) * frameH,
    })),
  );

  await sharp({
    create: {
      width: atlasW,
      height: atlasH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .webp({ quality: 95 })
    .toFile(atlasOut);

  return { frameW, frameH, atlasW, atlasH };
}

function buildManifest({ agentId, animations, frameSize, atlasSize }) {
  // Map each frame key to its rect in the packed atlas. Iteration order
  // mirrors buildAtlas() so rect coords match where sharp wrote the bytes.
  const allFrameKeys = [];
  for (const a of animations) {
    allFrameKeys.push(...a.frameKeys);
  }
  const cols = ATLAS_COLS;
  const frames = {};
  for (let i = 0; i < allFrameKeys.length; i++) {
    frames[allFrameKeys[i]] = {
      x: (i % cols) * frameSize.w,
      y: Math.floor(i / cols) * frameSize.h,
      w: frameSize.w,
      h: frameSize.h,
    };
  }
  const animationsMap = {};
  for (const a of animations) {
    const entry = {
      frames: a.frameKeys,
      fps: a.fps,
      loop: a.loop,
    };
    if (a.holdLastFrame) {
      entry.holdLastFrame = true;
    }
    animationsMap[a.name] = entry;
  }
  return {
    version: 1,
    agent: agentId,
    image: `${agentId}.atlas.webp`,
    size: { w: atlasSize.w, h: atlasSize.h },
    frameSize: { w: frameSize.w, h: frameSize.h },
    frames,
    animations: animationsMap,
    transitions: {
      "*->thinking": "thinking.intro",
      "thinking->*": "thinking.outro",
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Short-circuit: --list-voices is a read-only lookup against ElevenLabs.
  // No pixellab calls, no --uid required.
  if (opts.listVoices) {
    const elevenKey = resolveElevenLabsKey(opts.elevenApiKeyCommand);
    if (!elevenKey) {
      console.error("No ElevenLabs API key available.");
      console.error("  Set ELEVENLABS_API_KEY, pass --elevenlabs-api-key-command,");
      console.error("  or put the key in `pass` as `elevenlabs/api-key`.");
      return 1;
    }
    const voices = await fetchElevenLabsVoices(elevenKey);
    if (voices.length === 0) {
      console.log("(no voices in your ElevenLabs library)");
      return 0;
    }
    for (const v of voices) {
      const labelBits = Object.entries(v.labels || {})
        .map(([k, val]) => `${k}=${String(val)}`)
        .join(" ");
      const cat = v.category ? ` [${v.category}]` : "";
      console.log(`${v.voiceId}  ${v.name}${cat}${labelBits ? `  ${labelBits}` : ""}`);
    }
    return 0;
  }

  const apiKey = opts.dryRun ? "dry-run-noop" : resolveApiKey(opts.apiKeyCommand);
  const assetsRoot = resolveAssetsRoot(opts.assetsRoot);
  const workspace = resolveWorkspace(opts.workspace, assetsRoot);

  const zipPath = path.join(workspace, `${opts.uid}.zip`);
  const extractDir = path.join(workspace, `${opts.uid}_extracted`);

  console.log(`pixellab export ${opts.uid}`);
  console.log(`  assets root: ${assetsRoot}`);
  console.log(`  workspace:   ${workspace}`);
  if (opts.dryRun) {
    console.log("  (dry run — no files will be written)");
  }

  await mkdir(workspace, { recursive: true });

  if (opts.dryRun) {
    console.log("\nplan:");
    console.log(`  1. download zip → ${zipPath}`);
    console.log(`  2. extract     → ${extractDir}`);
    console.log("  3. detect animations under animations/<anim>-<seed>/south/");
    console.log("  4. convert frames PNG → WebP, pack into atlas");
    console.log("  5. write manifest + atlas to <assets-root>/<agentId>/");
    return 0;
  }

  await downloadCharacterZip({ uid: opts.uid, apiKey, zipPath, skipDownload: opts.skipDownload });
  await extractZip({
    zipPath,
    extractDir,
    skipExtract: opts.skipExtract,
    overwrite: opts.overwrite,
  });

  const charName = opts.name ?? (await detectCharacterName(extractDir, "character"));
  const agentId = opts.agentId ?? deriveAgentId(charName);
  console.log(`  character name: ${charName}`);
  console.log(`  agent id:       ${agentId}`);

  // Fetch per-animation metadata from the pixellab API so we can use clean
  // canonical names (`happy`, `sad`, `thinking`) in the SpriteCore manifest
  // instead of the verbose zip folder slugs. Best-effort — falls back to
  // slug names if the fetch fails or the key isn't available.
  console.log("  fetching animation metadata from pixellab…");
  const apiMetadata = await fetchAnimationMetadata({ uid: opts.uid, apiKey });
  if (apiMetadata) {
    console.log(`  got clean names for ${apiMetadata.size} animation group(s)`);
  }

  const animDirs = await detectAnimationDirs(extractDir, apiMetadata, opts.rename);
  if (animDirs.length === 0) {
    console.error("no animation directories found in the extracted bundle");
    return 1;
  }
  console.log(`  animations:     ${animDirs.map((a) => a.name).join(", ")}`);

  const agentAssetsDir = path.join(assetsRoot, agentId);
  const framesRoot = path.join(agentAssetsDir, "frames");
  if (await pathExists(agentAssetsDir)) {
    if (!opts.overwrite) {
      console.error(`agent assets dir already exists: ${agentAssetsDir}`);
      console.error("re-run with --overwrite to replace");
      return 1;
    }
    await rm(agentAssetsDir, { recursive: true, force: true });
  }
  await mkdir(framesRoot, { recursive: true });

  const animations = [];
  for (const { name, dir, description } of animDirs) {
    const frames = await listFrames(dir);
    const result = await processAnimation({
      name,
      description,
      frames,
      framesOutDir: path.join(framesRoot, name),
    });
    if (result) {
      animations.push(result);
    }
  }
  if (animations.length === 0) {
    console.error("no animations produced any usable frames");
    return 1;
  }

  const atlasOut = path.join(agentAssetsDir, `${agentId}.atlas.webp`);
  const { frameW, frameH, atlasW, atlasH } = await buildAtlas({
    framesRoot,
    atlasOut,
  });

  const manifest = buildManifest({
    agentId,
    animations,
    frameSize: { w: frameW, h: frameH },
    atlasSize: { w: atlasW, h: atlasH },
  });
  const manifestOut = path.join(agentAssetsDir, `${agentId}.atlas.json`);
  await writeFile(manifestOut, `${JSON.stringify(manifest, null, 2)}\n`);

  // Atlas + manifest are the shipped artifacts; the per-state frames/ tree
  // is just working data that buildAtlas consumed. Drop it so the agent dir
  // stays lean — any re-run uses the extract cache, not this dir.
  await rm(framesRoot, { recursive: true, force: true });

  console.log("");
  console.log(`✓ atlas:    ${atlasOut}`);
  console.log(`✓ manifest: ${manifestOut}`);
  console.log("");
  // Pick the most idle-looking default state. Prefer explicit "idle", else
  // the first animation after sorting.
  const defaultState = animations.find((a) => a.name === "idle")?.name ?? animations[0].name;

  // Resolve an optional voice block. --voice-id wins; --voice auto pulls the
  // first entry from the ElevenLabs library. Silent skip if the lookup fails
  // — the snippet is still usable, user can paste a voiceId later.
  let voiceBlock = null;
  if (opts.voiceId) {
    voiceBlock = { provider: "elevenlabs", voiceId: opts.voiceId };
  } else if (opts.voiceAuto) {
    const elevenKey = resolveElevenLabsKey(opts.elevenApiKeyCommand);
    if (!elevenKey) {
      console.error(
        "warning: --voice auto requested but no ElevenLabs API key available; skipping voice block",
      );
    } else {
      try {
        const voices = await fetchElevenLabsVoices(elevenKey);
        if (voices.length === 0) {
          console.error("warning: --voice auto requested but your ElevenLabs library is empty");
        } else {
          const picked = voices[0];
          voiceBlock = { provider: "elevenlabs", voiceId: picked.voiceId };
          console.log(`  auto-picked ElevenLabs voice: ${picked.name} (${picked.voiceId})`);
        }
      } catch (err) {
        console.error(`warning: ElevenLabs voice lookup failed: ${err.message}`);
      }
    }
  }

  // Emit the canonical shape: `emotions.<state>.description`. Directives are
  // hand-tuned per agent and not something the exporter can invent, so we
  // leave them out — operators add `directive` blocks when they tune voice.
  const agentBlock = {
    avatar: {
      kind: "atlas",
      default: defaultState,
      manifest: `avatars/${agentId}/${agentId}.atlas.json`,
    },
    ...(voiceBlock ? { voice: voiceBlock } : {}),
    emotions: Object.fromEntries(
      animations.map((a) => [a.name, { description: a.description || a.name }]),
    ),
  };

  if (opts.apply) {
    await applyToConfig({ agentId, agentBlock, configPath: opts.configPath });
  } else {
    console.log('paste into openclaw.json under plugins.entries["sprite-core"].config.agents:');
    console.log(JSON.stringify({ [agentId]: agentBlock }, null, 2));
    console.log("");
    console.log("tip: pass --apply to patch openclaw.json directly (backs up first).");
  }
  if (!voiceBlock) {
    console.log("");
    console.log(
      "tip: pass `--voice <voiceId>` or `--voice auto` to include a voice block,",
    );
    console.log("     or run `--list-voices` to see what's in your ElevenLabs library.");
  }
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exit(1);
  });
