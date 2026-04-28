import { useEffect, useRef, useState } from "react";
import {
  AssetSource,
  AnimationGraph,
  InMemorySpriteSource,
  SpriteAnimationPlayer,
} from "@tylerwarburton/sprite-core-client";
import {
  decodeToImage,
  fetchAsset,
  fetchManifest,
  type DecodedImage,
} from "./asset-decode.js";
import { Frame } from "./Frame.js";
import { useObservable } from "./use-observable.js";

type Props = {
  agentId: string;
  availableStates: string[];
};

/**
 * Live avatar preview driven by the same client SDK phones and watches use.
 * Rebuilds its player when `agentId` changes; pushes a new state into the
 * player on `requestState` clicks. Decoded images live in a ref-counted map
 * keyed by refKey so we don't leak blob URLs when the player hops frames.
 *
 * Used today as the fallback preview for non-`sprites` avatar kinds. The
 * `sprites` kind uses the per-card mini-previews in AnimationStudio instead.
 */
export function AvatarPreview({ agentId, availableStates }: Props): JSX.Element {
  const [source] = useState(() => new AssetSource({ fetchManifest, fetchAsset }));
  const [player, setPlayer] = useState<SpriteAnimationPlayer | null>(null);
  const [frameSource, setFrameSource] = useState<InMemorySpriteSource<DecodedImage> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decodedRef = useRef<Map<string, DecodedImage>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setError(null);

    (async () => {
      try {
        await source.refresh([agentId]);
        if (cancelled) return;

        const envelope = source.characterManifests.value[agentId];
        if (!envelope) {
          setError("no manifest returned for agent");
          return;
        }
        const mode = envelope.manifest.modes[0];
        if (!mode) {
          setError("manifest has no modes");
          return;
        }
        const graph = AnimationGraph.fromManifest(envelope.manifest, mode);

        // Decode every ref once up front. For large atlases this could stream
        // but for the preview a few KB per state is fine.
        const prevDecoded = decodedRef.current;
        for (const img of prevDecoded.values()) img.revoke();
        prevDecoded.clear();

        const fs = new InMemorySpriteSource<DecodedImage>((bytes) => {
          const img = decodeToImage(bytes);
          if (img) prevDecoded.set(img.url, img);
          return img;
        });
        const bytesByRef = source.characterAssets.value[agentId] ?? {};
        for (const [ref, bytes] of Object.entries(bytesByRef)) {
          fs.put(ref, bytes);
        }

        const nextPlayer = new SpriteAnimationPlayer(graph);
        setFrameSource(fs);
        setPlayer((prev) => {
          void prev?.dispose();
          return nextPlayer;
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agentId, source]);

  useEffect(() => {
    return () => {
      void player?.dispose();
      for (const img of decodedRef.current.values()) img.revoke();
      decodedRef.current.clear();
    };
  }, [player]);

  return (
    <div className="preview">
      <div className="preview-canvas">
        {error && <div className="status error">{error}</div>}
        {!error && player && frameSource && <PreviewFrame player={player} frameSource={frameSource} />}
        {!error && !player && <div className="status">loading preview…</div>}
      </div>
      {player && <StateButtons player={player} states={availableStates} />}
    </div>
  );
}

function PreviewFrame({
  player,
  frameSource,
}: {
  player: SpriteAnimationPlayer;
  frameSource: InMemorySpriteSource<DecodedImage>;
}): JSX.Element {
  const ref = useObservable(player.currentRef);
  return <Frame frameRef={ref} frameSource={frameSource} />;
}

function StateButtons({
  player,
  states,
}: {
  player: SpriteAnimationPlayer;
  states: string[];
}): JSX.Element | null {
  const current = useObservable(player.currentState);
  if (states.length === 0) return null;
  return (
    <div className="preview-states">
      {states.map((s) => (
        <button
          key={s}
          className={current === s ? "active" : undefined}
          onClick={() => void player.requestState(s)}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
