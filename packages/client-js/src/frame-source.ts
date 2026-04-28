import type { FrameRef } from "./schema.js";

/**
 * Platform-specific resolver from a [FrameRef] to a concrete renderable
 * (e.g. `HTMLImageElement`, `ImageBitmap`, an `<img>` URL, whatever the
 * caller chooses). The kit itself never constructs frames — callers own the
 * pixel pipeline and only feed the player's emitted `FrameRef` into their
 * own `FrameSource` when rendering.
 *
 * Atlas sources honor the optional `x/y/w/h` fields on `FrameRef`; sprite
 * sources ignore them and treat `ref` as the whole-image key.
 */
export interface FrameSource<F> {
  frame(ref: FrameRef): F | null;
}

/**
 * Simple in-memory sprite source: callers prime a map of whole-image bytes
 * keyed by the ref name, and decode happens lazily through [decode]. Useful
 * for unit tests and thin clients that don't need per-platform image types.
 */
export class InMemorySpriteSource<F> implements FrameSource<F> {
  private readonly bytesByRef = new Map<string, Uint8Array>();
  private readonly cache = new Map<string, F>();

  constructor(private readonly decode: (bytes: Uint8Array) => F | null) {}

  put(refKey: string, bytes: Uint8Array): void {
    this.bytesByRef.set(refKey, bytes);
    this.cache.delete(refKey);
  }

  keys(): ReadonlySet<string> {
    return new Set(this.bytesByRef.keys());
  }

  frame(ref: FrameRef): F | null {
    const cached = this.cache.get(ref.ref);
    if (cached !== undefined) return cached;
    const bytes = this.bytesByRef.get(ref.ref);
    if (bytes === undefined) return null;
    const decoded = this.decode(bytes);
    if (decoded === null) return null;
    this.cache.set(ref.ref, decoded);
    return decoded;
  }
}
