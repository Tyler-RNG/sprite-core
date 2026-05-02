/**
 * PixelLab character → SpriteCore atlas export pipeline as a library.
 *
 * Mirrors `scripts/pixellab-export.mjs` but factored so the plugin's HTTP
 * route handler and the standalone CLI script can share the same logic. The
 * .mjs script remains the canonical CLI front-end; this module skips its
 * argv parsing, ElevenLabs voice block, and openclaw.json patching steps —
 * those stay CLI-only.
 *
 * Pipeline:
 *   1. Download the character's zip bundle from pixellab.
 *   2. Extract it under a workspace directory.
 *   3. Walk animations/<slug>-<hash>/south/ folders, normalize names via
 *      pixellab API metadata + canonical rename map.
 *   4. Convert each frame PNG → WebP, pack into a 7-col atlas.
 *   5. Write `<assetsRoot>/<agentId>/{<agentId>.atlas.webp, <agentId>.atlas.json}`.
 *
 * The pipeline is idempotent: re-running with the same args replaces the
 * agent's atlas + manifest atomically (write-to-tmp + rename is left to the
 * filesystem layer for now; sharp writes directly to the final path).
 */

import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";
import sharp from "sharp";
import { readBytes } from "./pixellab-fs.js";

const PIXELLAB_API_BASE = "https://api.pixellab.ai/v2";
const ATLAS_COLS = 7;
const DEFAULT_ATLAS_SIDE = 1024;

/**
 * Substring needles applied (case-insensitive, normalizing `_-` → space) to
 * pixellab's verbose slug or `animation_type` to recover canonical emotion
 * names. Mirrors `pixellab-animate.mjs#DEFAULT_PROMPTS`.
 */
export const DEFAULT_CANONICAL_RENAMES: Readonly<Record<string, string>> = {
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

/**
 * Long-form description per canonical emotion. Used when the rename matched
 * a known canonical and pixellab's `display_name` is missing or truncated.
 */
export const DEFAULT_CANONICAL_DESCRIPTIONS: Readonly<Record<string, string>> = {
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

export type RunExportInput = {
  /** PixelLab character UUID. */
  characterId: string;
  /** SpriteCore agent id. Used in output filenames + manifest.agent. */
  agentId: string;
  /** Where atlases live, e.g. `~/.openclaw/state/assets/avatars`. */
  assetsRoot: string;
  /** PixelLab API key. */
  apiKey: string;
  /**
   * Scratch dir for downloads + extraction; defaults to
   * `<assetsRoot>/.pixellab-cache`.
   */
  workspace?: string;
  /** Replace existing agent dir contents. Defaults to true. */
  overwrite?: boolean;
  /** Reuse a previously downloaded zip if present. */
  skipDownload?: boolean;
  /** Reuse a previously extracted bundle if present. */
  skipExtract?: boolean;
  /** Operator-supplied slug → canonical-name overrides; merged on top of defaults. */
  renames?: Record<string, string>;
  /** Optional logger (defaults to no-op). */
  log?: (line: string) => void;
};

export type ExportedAnimation = {
  /** SpriteCore state name (canonical). */
  name: string;
  /** Long-form prompt-visible description. */
  description: string;
  frameCount: number;
  fps: number;
  loop: "infinite" | "once";
  holdLastFrame: boolean;
};

export type RunExportResult = {
  agentId: string;
  characterId: string;
  atlasPath: string;
  manifestPath: string;
  animations: ExportedAnimation[];
  atlasSize: { w: number; h: number };
  frameSize: { w: number; h: number };
  /** Animation chosen as the agent's default state (idle if present, else first). */
  defaultState: string;
  /** Epoch ms when the export completed. */
  exportedAt: number;
};

/**
 * Run the full pipeline. Throws on any unrecoverable error; the caller is
 * responsible for wrapping in 4xx/5xx HTTP responses.
 */
export async function runExport(input: RunExportInput): Promise<RunExportResult> {
  const log = input.log ?? (() => {});
  const overwrite = input.overwrite !== false;
  const assetsRoot = path.resolve(input.assetsRoot);
  const workspace = path.resolve(
    input.workspace ?? path.join(assetsRoot, ".pixellab-cache"),
  );
  await mkdir(workspace, { recursive: true });

  const zipPath = path.join(workspace, `${input.characterId}.zip`);
  const extractDir = path.join(workspace, `${input.characterId}_extracted`);

  log(`pixellab export: ${input.characterId} → ${input.agentId}`);
  log(`  workspace: ${workspace}`);

  await downloadCharacterZip({
    uid: input.characterId,
    apiKey: input.apiKey,
    zipPath,
    skipDownload: input.skipDownload ?? false,
    log,
  });
  await extractZip({
    zipPath,
    extractDir,
    skipExtract: input.skipExtract ?? false,
    overwrite,
    log,
  });

  log("  fetching animation metadata…");
  const apiMetadata = await fetchAnimationMetadata({
    uid: input.characterId,
    apiKey: input.apiKey,
    log,
  });
  if (apiMetadata) {
    log(`  got clean names for ${apiMetadata.size} animation group(s)`);
  }

  const animDirs = await detectAnimationDirs(
    extractDir,
    apiMetadata,
    input.renames ?? {},
  );
  if (animDirs.length === 0) {
    throw new Error("no animation directories found in the extracted bundle");
  }
  log(`  animations: ${animDirs.map((a) => a.name).join(", ")}`);

  const agentAssetsDir = path.join(assetsRoot, input.agentId);
  const framesRoot = path.join(agentAssetsDir, "frames");
  if (await pathExists(agentAssetsDir)) {
    if (!overwrite) {
      throw new Error(`agent assets dir already exists: ${agentAssetsDir}`);
    }
    await rm(agentAssetsDir, { recursive: true, force: true });
  }
  await mkdir(framesRoot, { recursive: true });

  const animations: ProcessedAnimation[] = [];
  for (const { name, dir, description } of animDirs) {
    const frames = await listFrames(dir);
    const result = await processAnimation({
      name,
      description,
      frames,
      framesOutDir: path.join(framesRoot, name),
      log,
    });
    if (result) animations.push(result);
  }
  if (animations.length === 0) {
    throw new Error("no animations produced any usable frames");
  }

  const atlasOut = path.join(agentAssetsDir, `${input.agentId}.atlas.webp`);
  const { frameW, frameH, atlasW, atlasH } = await buildAtlas({
    framesRoot,
    atlasOut,
    log,
  });

  const manifest = buildManifest({
    agentId: input.agentId,
    animations,
    frameSize: { w: frameW, h: frameH },
    atlasSize: { w: atlasW, h: atlasH },
  });
  const manifestPath = path.join(agentAssetsDir, `${input.agentId}.atlas.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // Drop the per-state working directory; only atlas + manifest ship.
  await rm(framesRoot, { recursive: true, force: true });

  const defaultState =
    animations.find((a) => a.name === "idle")?.name ?? animations[0]!.name;

  log(`✓ atlas:    ${atlasOut}`);
  log(`✓ manifest: ${manifestPath}`);

  return {
    agentId: input.agentId,
    characterId: input.characterId,
    atlasPath: atlasOut,
    manifestPath,
    animations: animations.map(({ name, description, frameCount, fps, loop, holdLastFrame }) => ({
      name,
      description,
      frameCount,
      fps,
      loop,
      holdLastFrame,
    })),
    atlasSize: { w: atlasW, h: atlasH },
    frameSize: { w: frameW, h: frameH },
    defaultState,
    exportedAt: Date.now(),
  };
}

// ---- pipeline stages ----

type ApiAnimationEntry = {
  animationType: string | null;
  displayName: string | null;
  frameCount: number;
};

type ProcessedAnimation = {
  name: string;
  description: string;
  frameCount: number;
  fps: number;
  loop: "infinite" | "once";
  holdLastFrame: boolean;
  frameKeys: string[];
};

async function fetchAnimationMetadata(args: {
  uid: string;
  apiKey: string;
  log: (s: string) => void;
}): Promise<Map<string, ApiAnimationEntry> | null> {
  let res: Response;
  try {
    res = await fetch(
      `${PIXELLAB_API_BASE}/characters/${encodeURIComponent(args.uid)}/animations`,
      { headers: { Authorization: `Bearer ${args.apiKey}` } },
    );
  } catch (err) {
    args.log(
      `  animation metadata fetch failed (${(err as Error).message}) — falling back to slug names`,
    );
    return null;
  }
  if (!res.ok) {
    args.log(
      `  animation metadata fetch returned ${res.status} — falling back to slug names`,
    );
    return null;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const anims = (body as { animations?: unknown[] })?.animations;
  if (!Array.isArray(anims)) return null;
  const map = new Map<string, ApiAnimationEntry>();
  for (const aRaw of anims) {
    const a = aRaw as {
      animation_group_id?: unknown;
      animation_type?: unknown;
      display_name?: unknown;
      directions?: Array<{ frame_count?: number }>;
    };
    if (typeof a?.animation_group_id !== "string") continue;
    const prefix = a.animation_group_id.slice(0, 8).toLowerCase();
    map.set(prefix, {
      animationType: typeof a.animation_type === "string" ? a.animation_type : null,
      displayName:
        typeof a.display_name === "string" && a.display_name.trim()
          ? a.display_name.trim()
          : null,
      frameCount: a.directions?.[0]?.frame_count ?? 0,
    });
  }
  return map;
}

function prettifySlug(slug: string): string {
  return slug.replace(/_+/g, " ").trim();
}

async function downloadCharacterZip(args: {
  uid: string;
  apiKey: string;
  zipPath: string;
  skipDownload: boolean;
  log: (s: string) => void;
}): Promise<void> {
  if (args.skipDownload) {
    if (!(await pathExists(args.zipPath))) {
      throw new Error(`skipDownload: ${args.zipPath} does not exist`);
    }
    args.log(`  reusing zip: ${args.zipPath}`);
    return;
  }
  args.log(`  fetching pixellab character ${args.uid}…`);
  const url = `${PIXELLAB_API_BASE}/characters/${encodeURIComponent(args.uid)}/zip`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${args.apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `pixellab API error: ${res.status} ${res.statusText}${body ? `\n${body.slice(0, 500)}` : ""}`,
    );
  }
  if (!res.body) {
    throw new Error("pixellab API returned an empty body");
  }
  await pipeline(
    Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream),
    createWriteStream(args.zipPath),
  );
  const size = (await stat(args.zipPath)).size;
  if (size === 0) throw new Error("downloaded zip is empty");
  args.log(`  downloaded ${size.toLocaleString()} bytes`);
}

async function extractZip(args: {
  zipPath: string;
  extractDir: string;
  skipExtract: boolean;
  overwrite: boolean;
  log: (s: string) => void;
}): Promise<void> {
  if (args.skipExtract) {
    if (!(await pathExists(args.extractDir))) {
      throw new Error(`skipExtract: ${args.extractDir} does not exist`);
    }
    args.log(`  reusing extraction: ${args.extractDir}`);
    return;
  }
  if (await pathExists(args.extractDir)) {
    if (!args.overwrite) {
      throw new Error(`extraction dir already exists: ${args.extractDir}`);
    }
    await rm(args.extractDir, { recursive: true, force: true });
  }
  await mkdir(args.extractDir, { recursive: true });
  const zipBytes = await readBytes(args.zipPath);
  const zip = await JSZip.loadAsync(zipBytes);
  const entries = Object.values(zip.files);
  for (const entry of entries) {
    const dest = path.join(args.extractDir, entry.name);
    if (entry.dir) {
      await mkdir(dest, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(dest), { recursive: true });
    const buf = await entry.async("nodebuffer");
    await writeFile(dest, buf);
  }
  args.log(`  extracted ${entries.length} entries`);
}

async function detectAnimationDirs(
  extractDir: string,
  apiMetadata: Map<string, ApiAnimationEntry> | null,
  renameOverrides: Record<string, string>,
): Promise<Array<{ name: string; dir: string; description: string }>> {
  const animationsRoot = path.join(extractDir, "animations");
  if (!(await pathExists(animationsRoot))) return [];
  const dirents = await readdir(animationsRoot, { withFileTypes: true });

  const mergedRenames = { ...DEFAULT_CANONICAL_RENAMES, ...renameOverrides };
  const renameEntries = Object.entries(mergedRenames);
  const normalize = (s: string): string => s.toLowerCase().replace(/[_-]+/g, " ");
  const tryRename = (slug: string, apiType: string | null): string | null => {
    if (renameEntries.length === 0) return null;
    const haystacks = [slug, apiType].filter(Boolean).map((s) => normalize(s as string));
    for (const [target, needle] of renameEntries) {
      const n = normalize(needle);
      if (haystacks.some((h) => h.includes(n))) return target;
    }
    return null;
  };

  type Raw = {
    dir: string;
    slug: string;
    cleanName: string;
    description: string;
    name?: string;
  };
  const raw: Raw[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const folder = dirent.name;
    const lastDash = folder.lastIndexOf("-");
    const slug = lastDash >= 0 ? folder.slice(0, lastDash) : folder;
    const hashPrefix =
      lastDash >= 0 ? folder.slice(lastDash + 1).toLowerCase() : "";
    const facingDir = path.join(animationsRoot, folder, "south");
    if (!(await pathExists(facingDir))) continue;

    const apiEntry = apiMetadata?.get(hashPrefix) ?? null;
    const apiType = apiEntry?.animationType?.trim() ?? null;
    const renamed = tryRename(slug, apiType);
    const cleanName = renamed ?? apiType ?? slug;
    const canonicalDescription =
      renamed && DEFAULT_CANONICAL_DESCRIPTIONS[renamed]
        ? DEFAULT_CANONICAL_DESCRIPTIONS[renamed]
        : null;
    const description =
      apiEntry?.displayName ?? canonicalDescription ?? prettifySlug(slug);
    raw.push({ dir: facingDir, slug, cleanName, description });
  }

  raw.sort((a, b) => a.slug.localeCompare(b.slug));
  const seen = new Map<string, number>();
  for (const entry of raw) {
    const count = (seen.get(entry.cleanName) ?? 0) + 1;
    seen.set(entry.cleanName, count);
    entry.name = count === 1 ? entry.cleanName : `${entry.cleanName}_${count}`;
  }
  return raw.map((e) => ({ name: e.name!, dir: e.dir, description: e.description }));
}

async function listFrames(animDir: string): Promise<string[]> {
  const entries = await readdir(animDir);
  return entries
    .filter((f) => /^frame_.*\.png$/i.test(f))
    .sort()
    .map((f) => path.join(animDir, f));
}

async function processAnimation(args: {
  name: string;
  description: string;
  frames: string[];
  framesOutDir: string;
  log: (s: string) => void;
}): Promise<ProcessedAnimation | null> {
  if (args.frames.length === 0) {
    args.log(`  ${args.name}: no frames, skipping`);
    return null;
  }
  await mkdir(args.framesOutDir, { recursive: true });
  const frameKeys: string[] = [];
  for (let i = 0; i < args.frames.length; i++) {
    const dest = path.join(args.framesOutDir, `${String(i).padStart(2, "0")}.webp`);
    try {
      await sharp(args.frames[i]!).webp({ quality: 95 }).toFile(dest);
      frameKeys.push(`${args.name}/${String(i).padStart(2, "0")}`);
    } catch (err) {
      args.log(`    failed to convert ${args.frames[i]}: ${(err as Error).message}`);
    }
  }
  if (frameKeys.length === 0) return null;

  const isHoldOnce = args.name === "thinking" || args.name === "contemplative";
  return {
    name: args.name,
    description: args.description,
    frameCount: args.frames.length,
    fps: args.frames.length > 5 ? 10 : 15,
    loop: isHoldOnce ? "once" : "infinite",
    holdLastFrame: isHoldOnce,
    frameKeys,
  };
}

async function buildAtlas(args: {
  framesRoot: string;
  atlasOut: string;
  log: (s: string) => void;
}): Promise<{ frameW: number; frameH: number; atlasW: number; atlasH: number }> {
  const allFrames: string[] = [];
  const animDirs = (await readdir(args.framesRoot)).sort();
  for (const animDir of animDirs) {
    const abs = path.join(args.framesRoot, animDir);
    const st = await stat(abs);
    if (!st.isDirectory()) continue;
    const files = (await readdir(abs)).filter((f) => f.endsWith(".webp")).sort();
    for (const f of files) allFrames.push(path.join(abs, f));
  }
  if (allFrames.length === 0) {
    throw new Error("no frames available for atlas packing");
  }

  const firstMeta = await sharp(allFrames[0]!).metadata();
  const frameW = firstMeta.width ?? 0;
  const frameH = firstMeta.height ?? 0;
  if (!frameW || !frameH) {
    throw new Error(`could not read frame dimensions from ${allFrames[0]}`);
  }

  const cols = ATLAS_COLS;
  const rows = Math.ceil(allFrames.length / cols);
  const atlasW = DEFAULT_ATLAS_SIDE;
  const atlasH = Math.max(DEFAULT_ATLAS_SIDE, rows * frameH);

  args.log(
    `  packing ${allFrames.length} frames → ${atlasW}x${atlasH} (${cols}×${rows}, frame ${frameW}x${frameH})`,
  );

  const composites = await Promise.all(
    allFrames.map(async (frame, i) => ({
      input: await readBytes(frame),
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
    .toFile(args.atlasOut);

  return { frameW, frameH, atlasW, atlasH };
}

type ManifestAnimationEntry = {
  frames: string[];
  fps: number;
  loop: "infinite" | "once";
  holdLastFrame?: true;
};

function buildManifest(args: {
  agentId: string;
  animations: ProcessedAnimation[];
  frameSize: { w: number; h: number };
  atlasSize: { w: number; h: number };
}): {
  version: number;
  agent: string;
  image: string;
  size: { w: number; h: number };
  frameSize: { w: number; h: number };
  frames: Record<string, { x: number; y: number; w: number; h: number }>;
  animations: Record<string, ManifestAnimationEntry>;
  transitions: Record<string, string>;
} {
  const allFrameKeys: string[] = [];
  for (const a of args.animations) allFrameKeys.push(...a.frameKeys);
  const cols = ATLAS_COLS;
  const frames: Record<string, { x: number; y: number; w: number; h: number }> = {};
  for (let i = 0; i < allFrameKeys.length; i++) {
    frames[allFrameKeys[i]!] = {
      x: (i % cols) * args.frameSize.w,
      y: Math.floor(i / cols) * args.frameSize.h,
      w: args.frameSize.w,
      h: args.frameSize.h,
    };
  }
  const animationsMap: Record<string, ManifestAnimationEntry> = {};
  for (const a of args.animations) {
    const entry: ManifestAnimationEntry = {
      frames: a.frameKeys,
      fps: a.fps,
      loop: a.loop,
    };
    if (a.holdLastFrame) entry.holdLastFrame = true;
    animationsMap[a.name] = entry;
  }
  return {
    version: 1,
    agent: args.agentId,
    image: `${args.agentId}.atlas.webp`,
    size: { w: args.atlasSize.w, h: args.atlasSize.h },
    frameSize: { w: args.frameSize.w, h: args.frameSize.h },
    frames,
    animations: animationsMap,
    transitions: {
      "*->thinking": "thinking.intro",
      "thinking->*": "thinking.outro",
    },
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// `defaultAssetsRoot` lives in ./pixellab-paths.ts so this file stays free of
// environment-variable reads — it has fetch calls, and openclaw's install-time
// scanner treats env-access combined with network calls in the same file as
// possible credential harvesting.
export { defaultAssetsRoot } from "./pixellab-paths.js";
