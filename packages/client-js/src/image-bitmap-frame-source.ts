import type { FrameRef } from "./schema.js";
import type { FrameSource } from "./frame-source.js";

/**
 * A decoded sprite frame ready to draw to a 2D canvas. Atlas crop rects on
 * the originating `FrameRef` are folded into `sx/sy/sw/sh`; whole-image refs
 * get the full bitmap dimensions.
 */
export type AtlasFrame = {
  readonly image: ImageBitmap;
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
};

/**
 * `FrameSource` that decodes per-ref bytes into `ImageBitmap`s via
 * `createImageBitmap`, mirroring Kotlin's `BitmapFrameSource` and Swift's
 * `CGImageFrameSource`. Atlas-aware: `frame()` returns an `AtlasFrame` whose
 * `sx/sy/sw/sh` reflect the `FrameRef`'s crop rect.
 *
 * Decode is async by nature in the browser, so `frame()` is synchronous and
 * returns null until the underlying ref has been prefetched. Call
 * `prefetchAll()` once after construction (or `prefetch(refKey)` per ref) so
 * frames are ready when the player emits them. Once primed, every subsequent
 * `frame()` call resolves synchronously.
 */
export class ImageBitmapFrameSource implements FrameSource<AtlasFrame> {
  private readonly bytesByRef = new Map<string, Uint8Array>();
  private readonly decoded = new Map<string, ImageBitmap>();
  private readonly inflight = new Map<string, Promise<ImageBitmap | null>>();

  constructor(bytesByRef: Readonly<Record<string, Uint8Array>>) {
    for (const [k, v] of Object.entries(bytesByRef)) this.bytesByRef.set(k, v);
  }

  frame(ref: FrameRef): AtlasFrame | null {
    const image = this.decoded.get(ref.ref);
    if (!image) return null;
    const sx = ref.x ?? 0;
    const sy = ref.y ?? 0;
    const sw = ref.w ?? image.width - sx;
    const sh = ref.h ?? image.height - sy;
    if (sw <= 0 || sh <= 0 || sx < 0 || sy < 0 || sx + sw > image.width || sy + sh > image.height) {
      return null;
    }
    return { image, sx, sy, sw, sh };
  }

  async prefetch(refKey: string): Promise<ImageBitmap | null> {
    const cached = this.decoded.get(refKey);
    if (cached) return cached;
    const pending = this.inflight.get(refKey);
    if (pending) return pending;
    const bytes = this.bytesByRef.get(refKey);
    if (!bytes) return null;

    const promise = (async (): Promise<ImageBitmap | null> => {
      try {
        // Materialize a fresh ArrayBuffer-backed copy so Blob accepts it
        // regardless of whether the input was a subarray view or backed by
        // SharedArrayBuffer.
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        const blob = new Blob([buffer]);
        const bm = await createImageBitmap(blob);
        this.decoded.set(refKey, bm);
        return bm;
      } catch {
        return null;
      } finally {
        this.inflight.delete(refKey);
      }
    })();
    this.inflight.set(refKey, promise);
    return promise;
  }

  async prefetchAll(): Promise<void> {
    await Promise.all(Array.from(this.bytesByRef.keys()).map((k) => this.prefetch(k)));
  }

  dispose(): void {
    for (const [, bm] of this.decoded) bm.close?.();
    this.decoded.clear();
    this.inflight.clear();
  }
}
