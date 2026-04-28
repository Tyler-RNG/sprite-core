import { useEffect, useMemo, useRef } from "react";
import type { FrameRef } from "@tylerwarburton/sprite-core-schema";
import type { InMemorySpriteSource } from "@tylerwarburton/sprite-core-client";
import type { DecodedImage } from "./asset-decode.js";

type Props = {
  /**
   * The player's currently emitted frame, or null when idle.
   *
   * NOTE: this prop is intentionally *not* called `ref` — React reserves the
   * `ref` prop name on function components for ref forwarding and silently
   * strips it before the component sees it. (Earlier passes hit exactly this:
   * the dashboard rendered "…" for every frame because `props.ref` was
   * always undefined.)
   */
  frameRef: FrameRef | null;
  frameSource: InMemorySpriteSource<DecodedImage>;
};

/**
 * Renders one player-emitted FrameRef. Atlas frames carry source-rect
 * coordinates (`x/y/w/h`) on the FrameRef; we honor those by drawing the
 * cropped rect into a `<canvas>` whose CSS aspect-ratio matches the rect, so
 * the frame fills the parent box without distortion. Whole-image refs (no
 * rect) render as a plain `<img>`.
 *
 * Replaces the `<img src={img.url}>` pattern previously duplicated in
 * AnimationCard.PlayerFrame and AvatarPreview.PreviewFrame, which ignored
 * the rect coords and displayed the entire atlas sheet.
 */
export function Frame({ frameRef, frameSource }: Props): JSX.Element {
  const img = useMemo<DecodedImage | null>(
    () => (frameRef ? frameSource.frame(frameRef) : null),
    [frameRef, frameSource],
  );

  if (!frameRef || !img) return <div className="frame frame--empty">…</div>;

  const cropped =
    typeof frameRef.x === "number" &&
    typeof frameRef.y === "number" &&
    typeof frameRef.w === "number" &&
    typeof frameRef.h === "number";

  if (!cropped) {
    return (
      <div className="frame">
        <img src={img.url} alt="" className="frame__img" />
      </div>
    );
  }

  return <AtlasFrame frameRef={frameRef} img={img} />;
}

function AtlasFrame({
  frameRef,
  img,
}: {
  frameRef: FrameRef;
  img: DecodedImage;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const w = frameRef.w as number;
  const h = frameRef.h as number;
  const x = frameRef.x as number;
  const y = frameRef.y as number;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const image = new Image();
    image.decoding = "sync";
    image.onload = () => {
      if (cancelled) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, x, y, w, h, 0, 0, w, h);
    };
    image.src = img.url;
    return () => {
      cancelled = true;
    };
  }, [img.url, x, y, w, h]);

  return (
    <div className="frame frame--atlas">
      <canvas
        ref={canvasRef}
        width={w}
        height={h}
        className="frame__canvas"
        style={{ aspectRatio: `${w} / ${h}` }}
      />
    </div>
  );
}
