import fs from "node:fs/promises";
import path from "node:path";
import { resolveAssetsDirForManifest } from "./character-manifest.js";
import type {
  SpriteCoreAvatarLoopMode,
  SpriteCoreAvatarTransition,
  SpriteCoreConfig,
} from "./types.js";

/**
 * Atlas JSON shape on disk. Mirrors the subset `synthesizeFromAtlas` reads.
 * Only the fields we mutate are typed; unknown keys round-trip untouched.
 */
export type AtlasManifestJson = {
  image?: string;
  size?: { w: number; h: number };
  frameSize?: { w: number; h: number };
  frames?: Record<string, { x: number; y: number; w: number; h: number }>;
  animations?: Record<string, AtlasAnimationJson>;
  transitions?: Record<string, SpriteCoreAvatarTransition>;
  // Round-trip everything else.
  [key: string]: unknown;
};

export type AtlasAnimationFlatJson = {
  frames: string[];
  fps?: number;
  loop?: SpriteCoreAvatarLoopMode;
  holdLastFrame?: boolean;
  iterations?: number;
};

export type AtlasAnimationPhasedJson = {
  intro?: AtlasAnimationFlatJson;
  loop?: AtlasAnimationFlatJson;
  outro?: AtlasAnimationFlatJson;
};

export type AtlasAnimationJson = AtlasAnimationFlatJson | AtlasAnimationPhasedJson;

const VALID_NAME = /^[a-zA-Z0-9._-]+$/;
const LOOP_MODES = new Set<SpriteCoreAvatarLoopMode>([
  "infinite",
  "once",
  "ping-pong",
]);

export type PatchAnimationInput = {
  rename?: string;
  fps?: number;
  loop?: SpriteCoreAvatarLoopMode;
  /** `false` clears the flag (default), `true` sets it. */
  holdLastFrame?: boolean;
  /** `null` clears the field; a positive integer sets it. */
  iterations?: number | null;
};

export type AtlasMutationOk = { ok: true; manifest: AtlasManifestJson };
export type AtlasMutationErr = {
  ok: false;
  code:
    | "unknown-animation"
    | "phased-not-editable"
    | "name-collision"
    | "invalid-input";
  message: string;
};
export type AtlasMutationResult = AtlasMutationOk | AtlasMutationErr;

/**
 * Patch a single flat animation's timing or rename it. Pure — no I/O. The
 * caller is responsible for reading + writing the file.
 *
 * Phased animations (intro/loop/outro) are rejected with `phased-not-editable`
 * since the AnimationCard form only handles flat sequences in this pass.
 */
export function patchAnimation(
  manifest: AtlasManifestJson,
  name: string,
  input: PatchAnimationInput,
): AtlasMutationResult {
  const animations = manifest.animations;
  if (!animations || !(name in animations)) {
    return {
      ok: false,
      code: "unknown-animation",
      message: `animation "${name}" not found in manifest`,
    };
  }
  const entry = animations[name] as AtlasAnimationJson;
  const flat = isFlatAnimation(entry);
  // Timing edits don't have a single phase to apply to on phased animations,
  // so they're rejected. Rename is fine — it's content-preserving.
  const touchesTiming =
    input.fps !== undefined ||
    input.loop !== undefined ||
    input.holdLastFrame !== undefined ||
    input.iterations !== undefined;
  if (!flat && touchesTiming) {
    return {
      ok: false,
      code: "phased-not-editable",
      message: `animation "${name}" is phased (intro/loop/outro); timing edits on phased animations are not supported in this pass`,
    };
  }

  // Validate up front so we don't half-apply on bad input.
  if (input.rename !== undefined) {
    const trimmed = input.rename.trim();
    if (!trimmed) {
      return { ok: false, code: "invalid-input", message: "rename: required" };
    }
    if (!VALID_NAME.test(trimmed)) {
      return {
        ok: false,
        code: "invalid-input",
        message: "rename: letters, numbers, . _ - only",
      };
    }
    if (trimmed !== name && trimmed in animations) {
      return {
        ok: false,
        code: "name-collision",
        message: `animation "${trimmed}" already exists`,
      };
    }
  }
  if (input.fps !== undefined) {
    if (
      typeof input.fps !== "number" ||
      !Number.isFinite(input.fps) ||
      input.fps < 1 ||
      input.fps > 120
    ) {
      return { ok: false, code: "invalid-input", message: "fps: expected 1..120" };
    }
  }
  if (input.loop !== undefined && !LOOP_MODES.has(input.loop)) {
    return {
      ok: false,
      code: "invalid-input",
      message: 'loop: expected "infinite" | "once" | "ping-pong"',
    };
  }
  if (input.iterations !== undefined && input.iterations !== null) {
    if (
      typeof input.iterations !== "number" ||
      !Number.isInteger(input.iterations) ||
      input.iterations < 1
    ) {
      return {
        ok: false,
        code: "invalid-input",
        message: "iterations: expected positive integer or null",
      };
    }
  }

  // Build the next animation entry. Preserve unknown keys via spread. For
  // phased entries we never reach the timing-mutation path (rejected above),
  // so the spread suffices.
  let next: AtlasAnimationJson = { ...entry };
  if (flat) {
    const flatNext = next as AtlasAnimationFlatJson;
    if (input.fps !== undefined) {
      flatNext.fps = input.fps;
    }
    if (input.loop !== undefined) {
      flatNext.loop = input.loop;
    }
    if (input.holdLastFrame === true) {
      flatNext.holdLastFrame = true;
    } else if (input.holdLastFrame === false) {
      delete flatNext.holdLastFrame;
    }
    if (input.iterations === null) {
      delete flatNext.iterations;
    } else if (input.iterations !== undefined) {
      flatNext.iterations = input.iterations;
    }
    next = flatNext;
  }

  const newName = input.rename?.trim() && input.rename.trim() !== name ? input.rename.trim() : null;
  const nextAnimations: Record<string, AtlasAnimationJson> = {};
  for (const [key, value] of Object.entries(animations)) {
    if (key === name) {
      nextAnimations[newName ?? name] = next;
    } else {
      nextAnimations[key] = value;
    }
  }

  const nextManifest: AtlasManifestJson = {
    ...manifest,
    animations: nextAnimations,
  };
  if (newName) {
    nextManifest.transitions = renameInTransitions(manifest.transitions, name, newName);
  }
  return { ok: true, manifest: nextManifest };
}

/**
 * Remove an animation (and any transitions referencing it). Pure — no I/O.
 */
export function deleteAnimation(
  manifest: AtlasManifestJson,
  name: string,
): AtlasMutationResult {
  const animations = manifest.animations;
  if (!animations || !(name in animations)) {
    return {
      ok: false,
      code: "unknown-animation",
      message: `animation "${name}" not found in manifest`,
    };
  }
  const nextAnimations: Record<string, AtlasAnimationJson> = {};
  for (const [key, value] of Object.entries(animations)) {
    if (key !== name) {
      nextAnimations[key] = value;
    }
  }
  return {
    ok: true,
    manifest: {
      ...manifest,
      animations: nextAnimations,
      transitions: dropFromTransitions(manifest.transitions, name),
    },
  };
}

function isFlatAnimation(a: AtlasAnimationJson): a is AtlasAnimationFlatJson {
  return Array.isArray((a as AtlasAnimationFlatJson).frames);
}

/**
 * Rewrite transition keys + phase-string values that reference `from` so
 * they reference `to`. Keys look like `"<state>-><state>"`; phase-string
 * values look like `"<state>"` or `"<state>.intro|loop|outro"`.
 */
function renameInTransitions(
  src: Record<string, SpriteCoreAvatarTransition> | undefined,
  from: string,
  to: string,
): Record<string, SpriteCoreAvatarTransition> | undefined {
  if (!src) return undefined;
  const out: Record<string, SpriteCoreAvatarTransition> = {};
  for (const [pattern, t] of Object.entries(src)) {
    const newPattern = renamePattern(pattern, from, to);
    if (typeof t === "string") {
      out[newPattern] = renamePhaseRef(t, from, to);
    } else {
      out[newPattern] = t;
    }
  }
  return out;
}

function dropFromTransitions(
  src: Record<string, SpriteCoreAvatarTransition> | undefined,
  name: string,
): Record<string, SpriteCoreAvatarTransition> | undefined {
  if (!src) return undefined;
  const out: Record<string, SpriteCoreAvatarTransition> = {};
  for (const [pattern, t] of Object.entries(src)) {
    if (patternReferences(pattern, name)) continue;
    if (typeof t === "string" && phaseRefReferences(t, name)) continue;
    out[pattern] = t;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function renamePattern(pattern: string, from: string, to: string): string {
  const arrow = pattern.indexOf("->");
  if (arrow < 0) return pattern;
  const lhs = pattern.slice(0, arrow);
  const rhs = pattern.slice(arrow + 2);
  return `${lhs === from ? to : lhs}->${rhs === from ? to : rhs}`;
}

function patternReferences(pattern: string, name: string): boolean {
  const arrow = pattern.indexOf("->");
  if (arrow < 0) return false;
  return pattern.slice(0, arrow) === name || pattern.slice(arrow + 2) === name;
}

function renamePhaseRef(ref: string, from: string, to: string): string {
  const dot = ref.indexOf(".");
  if (dot < 0) return ref === from ? to : ref;
  const head = ref.slice(0, dot);
  return head === from ? `${to}${ref.slice(dot)}` : ref;
}

function phaseRefReferences(ref: string, name: string): boolean {
  const dot = ref.indexOf(".");
  return dot < 0 ? ref === name : ref.slice(0, dot) === name;
}

// ---------- file I/O ----------

const writeChain = new Map<string, Promise<unknown>>();

function serial<T>(key: string, body: () => Promise<T>): Promise<T> {
  const prev = writeChain.get(key) ?? Promise.resolve();
  const next = prev.then(body, body);
  writeChain.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

export type ResolveAtlasInput = {
  pluginConfig: SpriteCoreConfig | undefined;
  agentId: string;
  /** Test seam — defaults to `resolveAssetsDirForManifest(pluginConfig)`. */
  assetsDir?: string;
};

export type AtlasFilePaths = {
  absolutePath: string;
  manifestRelative: string;
  agentId: string;
};

export type ResolveAtlasResult =
  | { ok: true; paths: AtlasFilePaths }
  | { ok: false; code: "unknown-agent" | "no-atlas"; message: string };

export function resolveAtlasManifestPath(
  input: ResolveAtlasInput,
): ResolveAtlasResult {
  const agent = input.pluginConfig?.agents?.[input.agentId];
  if (!agent) {
    return {
      ok: false,
      code: "unknown-agent",
      message: `unknown agent: ${input.agentId}`,
    };
  }
  const avatar = agent.avatar;
  if (!avatar || avatar.kind !== "atlas" || typeof avatar.manifest !== "string") {
    return {
      ok: false,
      code: "no-atlas",
      message: `agent "${input.agentId}" does not have an atlas avatar with a manifest path`,
    };
  }
  const assetsDir = input.assetsDir ?? resolveAssetsDirForManifest(input.pluginConfig);
  return {
    ok: true,
    paths: {
      absolutePath: path.resolve(assetsDir, avatar.manifest),
      manifestRelative: avatar.manifest,
      agentId: input.agentId,
    },
  };
}

export type AtlasFileMutator = (
  manifest: AtlasManifestJson,
) => AtlasMutationResult;

export type ApplyAtlasMutationResult =
  | { ok: true; manifest: AtlasManifestJson }
  | (AtlasMutationErr & { stage: "mutate" })
  | { ok: false; code: "atlas-unreadable"; message: string; stage: "read" }
  | { ok: false; code: "atlas-unwritable"; message: string; stage: "write" };

/**
 * Read the atlas JSON, run `mutate`, and write atomically (write to
 * `<file>.tmp.<pid>.<rand>` then rename). All calls for the same absolute
 * path serialize through an in-memory promise chain so concurrent requests
 * can't read-modify-write past each other within the process.
 */
export async function applyAtlasMutation(
  paths: AtlasFilePaths,
  mutate: AtlasFileMutator,
): Promise<ApplyAtlasMutationResult> {
  return serial(paths.absolutePath, async () => {
    let raw: string;
    try {
      raw = await fs.readFile(paths.absolutePath, "utf8");
    } catch (err) {
      return {
        ok: false as const,
        code: "atlas-unreadable" as const,
        message: `failed to read atlas at ${paths.manifestRelative}: ${(err as Error).message}`,
        stage: "read" as const,
      };
    }
    let parsed: AtlasManifestJson;
    try {
      parsed = JSON.parse(raw) as AtlasManifestJson;
    } catch (err) {
      return {
        ok: false as const,
        code: "atlas-unreadable" as const,
        message: `atlas JSON at ${paths.manifestRelative} is invalid: ${(err as Error).message}`,
        stage: "read" as const,
      };
    }

    const result = mutate(parsed);
    if (!result.ok) {
      return { ...result, stage: "mutate" as const };
    }

    const serialized = `${JSON.stringify(result.manifest, null, 2)}\n`;
    const tmp = `${paths.absolutePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    try {
      await fs.writeFile(tmp, serialized, "utf8");
      await fs.rename(tmp, paths.absolutePath);
    } catch (err) {
      try {
        await fs.unlink(tmp);
      } catch {
        /* ignore */
      }
      return {
        ok: false as const,
        code: "atlas-unwritable" as const,
        message: `failed to write atlas at ${paths.manifestRelative}: ${(err as Error).message}`,
        stage: "write" as const,
      };
    }
    return { ok: true as const, manifest: result.manifest };
  });
}
