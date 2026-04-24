import { useEffect, useMemo, useRef, useState } from "react";
import {
  AssetSource,
  AnimationGraph,
  InMemorySpriteSource,
  SpriteAnimationPlayer,
} from "@tyler-rng/sprite-core-client";
import type {
  NodeGetCharacterManifestResult,
  FrameRef,
} from "@tyler-rng/sprite-core-schema";
import { authHeader } from "../api/auth.js";
import { useObservable } from "./use-observable.js";

// Decode raw asset bytes into a blob URL the browser can render in <img>.
// We cache the URL per (agentId, refKey) so decodes aren't repeated; URLs
// are revoked on player replacement / unmount.
type DecodedImage = { url: string; revoke: () => void };

function decodeToImage(bytes: Uint8Array): DecodedImage | null {
  // Infer MIME from magic bytes. The UI only supports formats the plugin's
  // sprite pipeline actually emits (png/webp/jpg/gif), so a narrow sniffer is
  // enough. If we miss, the browser will render nothing — not a crash.
  const mime = sniffMime(bytes);
  if (!mime) return null;
  // TS 5.7+ types Uint8Array as <ArrayBufferLike>, which won't assign to
  // Blob's BlobPart (wants ArrayBuffer-backed). The runtime contract is
  // identical so the cast is safe; a copy would work too but is wasted.
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

type Props = {
  agentId: string;
  availableStates: string[];
};

async function fetchManifest(agentId: string): Promise<NodeGetCharacterManifestResult | null> {
  const res = await fetch(
    `/sprite-core/character-manifest?agentId=${encodeURIComponent(agentId)}`,
    { credentials: "same-origin", headers: { ...authHeader() } },
  );
  if (!res.ok) return null;
  return (await res.json()) as NodeGetCharacterManifestResult;
}

async function fetchAsset(relativePath: string): Promise<Uint8Array | null> {
  const res = await fetch(`/openclaw-assets/${relativePath}`, {
    credentials: "same-origin",
    headers: { ...authHeader() },
  });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Live avatar preview driven by the same client SDK phones and watches use.
 * Rebuilds its player when `agentId` changes; pushes a new state into the
 * player on `requestState` clicks. Decoded images live in a ref-counted map
 * keyed by refKey so we don't leak blob URLs when the player hops frames.
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
  const img = useMemo<DecodedImage | null>(() => {
    if (!ref) return null;
    return frameSource.frame(ref as FrameRef);
  }, [ref, frameSource]);
  if (!img) return <div className="status">…</div>;
  return <img src={img.url} alt="" />;
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
