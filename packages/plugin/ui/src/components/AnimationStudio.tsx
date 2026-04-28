import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { putAgent } from "../api/client.js";
import type {
  AgentEntry,
  AvatarAtlasConfig,
  AvatarSpritesConfig,
  SpriteSequence,
} from "../api/types.js";
import { useSharedFrameSource } from "../preview/use-shared-frame-source.js";
import { AnimationCard, type AnimationCardMode } from "./AnimationCard.js";
import { PixellabPanel } from "./PixellabPanel.js";

type Props = {
  agentId: string;
  agent: AgentEntry;
};

const DEFAULT_PLACEHOLDER: SpriteSequence = {
  count: 1,
  fps: 12,
  loop: "infinite",
};

/**
 * Per-agent editor for `kind: "sprites"` and `kind: "atlas"` avatars. Owns
 * the shared AssetSource / AnimationGraph / frame source and renders one
 * `AnimationCard` per animation. Each card mounts its own
 * `SpriteAnimationPlayer` against the shared graph so all animations loop in
 * parallel.
 *
 * Atlas vs sprites differences:
 *  - Sprites: animation list comes from `agent.avatar.states` (config). Cards
 *    can rename, edit timing, add, and delete.
 *  - Atlas: animation list comes from the loaded `graph.animations` (the
 *    external `<agent>.atlas.json` manifest). Rename / add / delete / timing
 *    are all out-of-band (atlas file edits), so cards only edit emotion
 *    rigging.
 */
export function AnimationStudio({ agentId, agent }: Props): JSX.Element | null {
  const qc = useQueryClient();
  const avatar = agent.avatar;
  const mode: AnimationCardMode | null =
    avatar?.kind === "sprites" ? "sprites" : avatar?.kind === "atlas" ? "atlas" : null;

  const { state: shared, error, loading, refresh } = useSharedFrameSource(agentId);

  const stateNames = useMemo<string[]>(() => {
    if (mode === "sprites") {
      const a = avatar as AvatarSpritesConfig;
      return Object.keys(a.states).sort();
    }
    if (mode === "atlas" && shared?.graph) {
      return Object.keys(shared.graph.animations).sort();
    }
    return [];
  }, [mode, avatar, shared]);

  const riggedCount = useMemo(
    () => stateNames.reduce((n, key) => (agent.emotions?.[key] ? n + 1 : n), 0),
    [stateNames, agent.emotions],
  );

  const addAnimation = useMutation({
    mutationFn: async () => {
      if (mode !== "sprites") return;
      const a = avatar as AvatarSpritesConfig;
      const newName = nextStateName(stateNames);
      const next: AgentEntry = {
        ...agent,
        avatar: {
          ...a,
          states: { ...a.states, [newName]: { ...DEFAULT_PLACEHOLDER } },
        },
      };
      await putAgent(agentId, next);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["agents"] });
      await refresh();
    },
  });

  if (mode === null) return null;

  const atlasAvatar = mode === "atlas" ? (avatar as AvatarAtlasConfig) : null;
  const waitingForGraph = mode === "atlas" && stateNames.length === 0 && !error;

  return (
    <section className="studio">
      <header className="studio__head">
        <div>
          <h2>{agentId}</h2>
          <div className="status dim">
            {mode} ·{" "}
            {stateNames.length === 0 && loading
              ? "loading animations…"
              : `${stateNames.length} animation${stateNames.length === 1 ? "" : "s"} · `}
            {stateNames.length > 0 && (
              <>
                <strong>{riggedCount}</strong> rigged /{" "}
                {stateNames.length - riggedCount} unrigged
              </>
            )}
          </div>
        </div>
        <div className="studio__actions">
          {mode === "sprites" && (
            <button
              type="button"
              onClick={() => addAnimation.mutate()}
              disabled={addAnimation.isPending}
              className="primary"
            >
              {addAnimation.isPending ? "adding…" : "+ add animation"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            title="Re-fetch manifest + assets"
          >
            {loading ? "refreshing…" : "↻ refresh"}
          </button>
        </div>
      </header>

      {atlasAvatar && (
        <div className="status dim">
          atlas manifest:{" "}
          <code className="anim-card__path">{atlasAvatar.manifest}</code>
          <br />
          rename / retime / delete edits write back to this file. Adding new
          animations and changing frame pixels still happens through PixelLab.
        </div>
      )}

      <PixellabPanel agentId={agentId} agent={agent} />

      {addAnimation.isError && (
        <div className="status error">{String(addAnimation.error)}</div>
      )}
      {error && <div className="status error">preview: {error}</div>}

      {!waitingForGraph && stateNames.length === 0 && (
        <div className="card">
          <div className="empty">
            {mode === "sprites"
              ? "No animations defined yet. Click + add animation to create one."
              : "No animations found in the atlas manifest."}
          </div>
        </div>
      )}

      <div className="studio-grid">
        {stateNames.map((name) => (
          <AnimationCard
            key={`${agentId}:${name}`}
            agentId={agentId}
            agent={agent}
            mode={mode}
            stateName={name}
            existingStateNames={stateNames.filter((n) => n !== name)}
            graph={shared?.graph ?? null}
            frameSource={shared?.frameSource ?? null}
            version={shared?.version ?? 0}
            onAgentMutated={refresh}
          />
        ))}
      </div>
    </section>
  );
}

function nextStateName(existing: string[]): string {
  const set = new Set(existing);
  if (!set.has("new-state")) return "new-state";
  for (let i = 2; i < 1000; i++) {
    const candidate = `new-state-${i}`;
    if (!set.has(candidate)) return candidate;
  }
  return `new-state-${Date.now()}`;
}
