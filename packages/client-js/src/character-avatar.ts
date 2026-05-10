import type { FrameRef, NodeGetCharacterManifestResult } from "./schema.js";
import { AnimationGraph } from "./animation-graph.js";
import { SpriteAnimationPlayer } from "./sprite-player.js";
import { ImageBitmapFrameSource, type AtlasFrame } from "./image-bitmap-frame-source.js";

/**
 * Per-frame transform applied before draw. The default is identity; pass a
 * function that returns a modified `AtlasFrame` (e.g. a different crop rect)
 * to add platform-specific framing — analogous to the Kotlin Compose
 * `bitmapTransform` and the SwiftUI `cgImageTransform` hooks.
 */
export type AvatarFrameTransform = (frame: AtlasFrame) => AtlasFrame;

export type CharacterAvatarOptions = {
  agentId: string;
  envelope: NodeGetCharacterManifestResult;
  assetBytes: Readonly<Record<string, Uint8Array>>;
  /** Initial state to request on mount. Falls back to the graph's default. */
  initialState?: string | null;
  /** Initial play count (mirrors `<<<state-N>>>`). Optional. */
  initialPlayCount?: number | null;
  /** Frame-time transform; defaults to identity. */
  transform?: AvatarFrameTransform;
};

export type CharacterAvatarController = {
  /** Request a state change; mirrors the Compose `currentState` parameter. */
  setState(state: string | null, playCount?: number | null): void;
  /** Tear down the player, frame source, and canvas subscription. */
  dispose(): Promise<void>;
};

/**
 * Mount the SpriteCore avatar engine onto an `HTMLCanvasElement`. Mirrors the
 * Kotlin Compose `CharacterAvatar` and the SwiftUI `CharacterAvatarView`:
 * one code path covers sprite, atlas, and flat states via
 * `AnimationGraph.fromManifest` + `SpriteAnimationPlayer`, with
 * `ImageBitmapFrameSource` resolving the bytes.
 *
 * Drawing fits the frame into the canvas's intrinsic `width`/`height` (i.e.
 * the backing-store resolution, not CSS size). Set those on the canvas to
 * the desired pixel dimensions before mounting; CSS handles layout.
 *
 * Returns a controller with `setState` and `dispose`. If the manifest has no
 * mode this caller can render, returns a no-op controller — the caller's
 * fallback owns the empty state.
 */
export function mountCharacterAvatar(
  canvas: HTMLCanvasElement,
  opts: CharacterAvatarOptions,
): CharacterAvatarController {
  const { envelope, assetBytes, initialState, initialPlayCount, transform } = opts;
  const mode = pickMode(envelope.manifest);
  if (mode === null) {
    return noopController();
  }

  let graph: AnimationGraph;
  try {
    graph = AnimationGraph.fromManifest(envelope.manifest, mode);
  } catch {
    return noopController();
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return noopController();
  }

  const frameSource = new ImageBitmapFrameSource(assetBytes);
  const player = new SpriteAnimationPlayer(graph);
  let disposed = false;

  // Kick decode of every ref so frames are ready by the time the player
  // emits them. Once primed, `frame()` resolves synchronously.
  void frameSource.prefetchAll();

  const draw = (ref: FrameRef | null): void => {
    if (disposed) return;
    if (!ref) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const sliced = frameSource.frame(ref);
    if (!sliced) {
      // Frame not yet decoded — kick prefetch and bail. The player keeps
      // emitting at frame rate, so the next ref change picks up the decode.
      void frameSource.prefetch(ref.ref);
      return;
    }
    const t = transform ? transform(sliced) : sliced;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(t.image, t.sx, t.sy, t.sw, t.sh, 0, 0, canvas.width, canvas.height);
  };

  const unsubscribe = player.currentRef.subscribe(draw);

  const requestStateInternal = (state: string | null, playCount: number | null): void => {
    if (disposed || !state) return;
    const resolved = envelope.manifest.stateMap[state] ?? state;
    if (envelope.manifest.content[mode]?.animations[resolved] === undefined) return;
    void player.requestState(resolved, playCount);
  };

  if (initialState !== undefined && initialState !== null) {
    requestStateInternal(initialState, initialPlayCount ?? null);
  }

  return {
    setState(state, playCount = null) {
      requestStateInternal(state, playCount);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      await player.dispose();
      frameSource.dispose();
    },
  };
}

/** Pick the first mode in `manifest.modes` whose content is present. */
function pickMode(manifest: NodeGetCharacterManifestResult["manifest"]): string | null {
  for (const m of manifest.modes) {
    if (m in manifest.content) return m;
  }
  return null;
}

function noopController(): CharacterAvatarController {
  return {
    setState() {},
    async dispose() {},
  };
}
