import { useCallback, useEffect, useRef, useState } from "react";
import {
  AnimationGraph,
  AssetSource,
  InMemorySpriteSource,
} from "@tylerwarburton/sprite-core-client";
import { decodeToImage, fetchAsset, fetchManifest, type DecodedImage } from "./asset-decode.js";

export type SharedFrameSource = {
  graph: AnimationGraph;
  frameSource: InMemorySpriteSource<DecodedImage>;
  /** Bumped on every successful refresh — consumers key player instances on this. */
  version: number;
};

export type UseSharedFrameSourceResult = {
  state: SharedFrameSource | null;
  error: string | null;
  loading: boolean;
  /** Force a re-fetch of the manifest + assets for the active agent. */
  refresh: () => Promise<void>;
};

/**
 * Owns the agent-scoped sprite playback substrate so multiple
 * `SpriteAnimationPlayer` instances can share one `AnimationGraph` +
 * `InMemorySpriteSource`. AnimationStudio mounts this once per agent and each
 * AnimationCard reuses the result for its own per-card player.
 *
 * Refresh semantics: `refresh()` re-runs `source.refresh([agentId])` and
 * rebuilds the graph + decoded blob URLs. The returned `version` increments
 * on every successful refresh — cards key their player on it so a frame-timing
 * edit cleanly tears down and rebuilds the running player.
 */
export function useSharedFrameSource(agentId: string | null): UseSharedFrameSourceResult {
  const [source] = useState(() => new AssetSource({ fetchManifest, fetchAsset }));
  const [state, setState] = useState<SharedFrameSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const decodedRef = useRef<Map<string, DecodedImage>>(new Map());
  const versionRef = useRef(0);
  const cancelledRef = useRef(false);

  const load = useCallback(
    async (id: string): Promise<void> => {
      cancelledRef.current = false;
      setLoading(true);
      setError(null);
      try {
        await source.refresh([id]);
        if (cancelledRef.current) return;

        const envelope = source.characterManifests.value[id];
        if (!envelope) {
          setError("no manifest returned for agent");
          setState(null);
          return;
        }
        const mode = envelope.manifest.modes[0];
        if (!mode) {
          setError("manifest has no modes");
          setState(null);
          return;
        }
        const graph = AnimationGraph.fromManifest(envelope.manifest, mode);

        // Wipe any decoded URLs from the previous version before building
        // fresh ones. The new InMemorySpriteSource gets a separate decoder so
        // running players naturally fall through to the new frame source on
        // their next frame after we update state below.
        const prevDecoded = decodedRef.current;
        for (const img of prevDecoded.values()) img.revoke();
        prevDecoded.clear();

        const frameSource = new InMemorySpriteSource<DecodedImage>((bytes) => {
          const img = decodeToImage(bytes);
          if (img) prevDecoded.set(img.url, img);
          return img;
        });
        const bytesByRef = source.characterAssets.value[id] ?? {};
        for (const [ref, bytes] of Object.entries(bytesByRef)) {
          frameSource.put(ref, bytes);
        }

        versionRef.current += 1;
        setState({ graph, frameSource, version: versionRef.current });
      } catch (err) {
        if (!cancelledRef.current) {
          setError(err instanceof Error ? err.message : String(err));
          setState(null);
        }
      } finally {
        if (!cancelledRef.current) {
          setLoading(false);
        }
      }
    },
    [source],
  );

  useEffect(() => {
    if (!agentId) {
      setState(null);
      setError(null);
      setLoading(false);
      return;
    }
    void load(agentId);
    return () => {
      cancelledRef.current = true;
    };
  }, [agentId, load]);

  // Final unmount cleanup: revoke any blob URLs still alive.
  useEffect(() => {
    return () => {
      for (const img of decodedRef.current.values()) img.revoke();
      decodedRef.current.clear();
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!agentId) return;
    await load(agentId);
  }, [agentId, load]);

  return { state, error, loading, refresh };
}
