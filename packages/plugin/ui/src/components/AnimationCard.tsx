import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  InMemorySpriteSource,
  AnimationGraph,
} from "@tylerwarburton/sprite-core-client";
import {
  deleteAtlasAnimation,
  patchAtlasAnimation,
  putAgent,
  putEmotion,
  type AtlasAnimationPatch,
} from "../api/client.js";
import type {
  AgentEntry,
  AvatarSpritesConfig,
  AvatarAtlasConfig,
  EmotionDirective,
  EmotionEntry,
  LoopMode,
  SpriteSequence,
  SpriteState,
} from "../api/types.js";
import type { DecodedImage } from "../preview/asset-decode.js";
import { Frame } from "../preview/Frame.js";
import { useAnimationPreview } from "../preview/use-animation-preview.js";
import { EmotionFields, emotionDirectiveHasAny } from "./EmotionFields.js";

type SeqValues = {
  count: number;
  fps: number | undefined;
  loop: LoopMode | undefined;
  holdLastFrame: boolean;
  iterations: number | undefined;
};

const VALID_NAME = /^[a-zA-Z0-9._-]+$/;

/**
 * "sprites" — animation definitions live inline in agent.avatar.states,
 *   so rename/add/delete and frame-timing edits all flow through putAgent.
 * "atlas"   — animations live in an external <agent>.atlas.json manifest,
 *   so the only editable thing per-card is the emotion rigging. Frame
 *   timing, rename, add, and delete are all out-of-band (atlas file edits).
 */
export type AnimationCardMode = "sprites" | "atlas";

type Props = {
  agentId: string;
  agent: AgentEntry;
  mode: AnimationCardMode;
  /** Display + emotion-key for this animation. */
  stateName: string;
  /** Other state keys, used to detect rename collisions (sprites mode only). */
  existingStateNames: string[];
  /** Shared substrate from useSharedFrameSource. Null while loading. */
  graph: AnimationGraph | null;
  frameSource: InMemorySpriteSource<DecodedImage> | null;
  /** Bumped when graph/frameSource rebuild — forces player recreate. */
  version: number;
  /** Triggered after a putAgent so the studio re-loads manifests. */
  onAgentMutated: () => Promise<void> | void;
};

/**
 * One animation in the studio. Owns its own preview driver (pause / step /
 * scrub / speed) plus a frame-timing form, an inline rename field, an
 * embedded emotion section, and CRUD actions (rename / delete).
 *
 * Save strategy:
 *  - Only emotion changed → PUT /agents/:id/emotions/:state (smaller payload)
 *  - Anything structural (rename / SpriteSequence fields) → full PUT /agents/:id
 *    with the rebuilt avatar.states (and emotions/prompting.descriptions
 *    moved on rename).
 *
 * Phased states (`SpriteStatePhased`) are read-only here — we surface a notice
 * and disable the frame controls. Editing phases is out of scope for this pass.
 */
export function AnimationCard({
  agentId,
  agent,
  mode,
  stateName,
  existingStateNames,
  graph,
  frameSource,
  version,
  onAgentMutated,
}: Props): JSX.Element {
  const qc = useQueryClient();
  const spritesAvatar =
    mode === "sprites" ? (agent.avatar as AvatarSpritesConfig | undefined) : undefined;
  const atlasAvatar =
    mode === "atlas" ? (agent.avatar as AvatarAtlasConfig | undefined) : undefined;
  const initialState: SpriteState | undefined = spritesAvatar?.states[stateName];
  const initialEmotion: EmotionEntry = agent.emotions?.[stateName] ?? {
    description:
      atlasAvatar?.descriptions?.[stateName] ??
      agent.prompting?.descriptions?.[stateName] ??
      "",
  };
  const isRigged = Boolean(agent.emotions?.[stateName]);

  // Phased detection differs by mode:
  //  - sprites: phased iff the inline state is not a flat sequence
  //  - atlas: phased iff the loaded graph entry has no flat `sequence`
  // The atlas-mode read pulls the actual fps/loop/etc. off the graph because
  // those values live in the external manifest, not in agent.avatar.states.
  const atlasSeq = useMemo<SeqValues | null>(() => {
    if (mode !== "atlas" || !graph) return null;
    const anim = graph.animations[stateName];
    if (!anim || !anim.sequence) return null;
    const s = anim.sequence;
    return {
      count: s.frames.length,
      fps: s.fps,
      loop: s.loop as LoopMode,
      holdLastFrame: s.holdLastFrame ?? false,
      iterations: s.iterations,
    };
  }, [mode, graph, stateName, version]);
  const atlasPhased = useMemo<boolean>(() => {
    if (mode !== "atlas" || !graph) return false;
    const anim = graph.animations[stateName];
    if (!anim) return false;
    return !anim.sequence;
  }, [mode, graph, stateName, version]);

  const phased =
    mode === "sprites"
      ? initialState !== undefined && !isFlatSequence(initialState)
      : atlasPhased;
  const initialSequence: (SpriteSequence & { description?: string }) | null =
    mode === "sprites" && initialState && !phased
      ? (initialState as SpriteSequence & { description?: string })
      : null;
  const initialDescription = initialSequence?.description ?? initialEmotion.description ?? "";

  /** Initial form values regardless of mode — sprites reads from the inline
   *  state, atlas reads from the loaded graph. Phased animations have no
   *  initial sequence so timing edits stay disabled. */
  const initialSeq: SeqValues | null =
    mode === "sprites"
      ? initialSequence
        ? {
            count: initialSequence.count ?? 1,
            fps: initialSequence.fps,
            loop: initialSequence.loop,
            holdLastFrame: initialSequence.holdLastFrame ?? false,
            iterations: initialSequence.iterations,
          }
        : null
      : atlasSeq;

  const prefillSource: string | null =
    atlasAvatar?.descriptions?.[stateName] ??
    agent.prompting?.descriptions?.[stateName] ??
    null;

  // ----- form state -----
  const [name, setName] = useState(stateName);
  const [count, setCount] = useState<number>(initialSeq?.count ?? 1);
  const [fps, setFps] = useState<number | undefined>(initialSeq?.fps);
  const [loop, setLoop] = useState<LoopMode | undefined>(initialSeq?.loop);
  const [holdLastFrame, setHoldLastFrame] = useState<boolean>(
    initialSeq?.holdLastFrame ?? false,
  );
  const [iterations, setIterations] = useState<number | undefined>(initialSeq?.iterations);
  const [description, setDescription] = useState<string>(initialEmotion.description ?? "");
  const [directive, setDirective] = useState<EmotionDirective>(initialEmotion.directive ?? {});
  const [emotionEnabled, setEmotionEnabled] = useState<boolean>(isRigged);

  useEffect(() => {
    setName(stateName);
    setCount(initialSeq?.count ?? 1);
    setFps(initialSeq?.fps);
    setLoop(initialSeq?.loop);
    setHoldLastFrame(initialSeq?.holdLastFrame ?? false);
    setIterations(initialSeq?.iterations);
    setDescription(initialEmotion.description ?? "");
    setDirective(initialEmotion.directive ?? {});
    setEmotionEnabled(isRigged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, stateName, version, mode]);

  // ----- per-card preview driver -----
  const { state: preview, controls } = useAnimationPreview(graph, stateName, version);
  const previewReady = graph !== null && frameSource !== null && preview.count > 0;
  const stepDisabled = !previewReady || preview.count <= 1;

  // ----- dirty detection -----
  // sprites: full edit surface — rename, timing, delete are inline.
  // atlas:   same edit surface, but writes route through the atlas-write
  //          gateway endpoints (PATCH/DELETE) instead of putAgent. Count is
  //          derived from the manifest's frames array and not editable here.
  const canRename = !phased;
  const canEditTiming = !phased && initialSeq !== null;
  const canEditCount = mode === "sprites" && canEditTiming;
  const canDelete = true;
  const renameTouched = canRename && name !== stateName;
  const sequenceTouched =
    canEditTiming &&
    initialSeq !== null &&
    ((canEditCount && count !== (initialSeq.count ?? 1)) ||
      fps !== initialSeq.fps ||
      loop !== initialSeq.loop ||
      holdLastFrame !== (initialSeq.holdLastFrame ?? false) ||
      iterations !== initialSeq.iterations);
  const emotionTouched =
    emotionEnabled !== isRigged ||
    description !== (initialEmotion.description ?? "") ||
    JSON.stringify(directive) !== JSON.stringify(initialEmotion.directive ?? {});
  const structuralTouched = renameTouched || sequenceTouched;
  const dirty = structuralTouched || emotionTouched;

  // ----- rename validation -----
  const renameError = useMemo<string | null>(() => {
    if (!renameTouched) return null;
    const trimmed = name.trim();
    if (!trimmed) return "name required";
    if (!VALID_NAME.test(trimmed)) return "letters, numbers, . _ - only";
    if (existingStateNames.includes(trimmed)) return "name already in use";
    return null;
  }, [renameTouched, name, existingStateNames]);

  // ----- mutations -----
  const save = useMutation({
    mutationFn: async () => {
      if (renameError) throw new Error(renameError);
      const trimmedName = name.trim();
      const renamed = trimmedName !== stateName;

      // Atlas-mode structural path: PATCH the atlas manifest, then update the
      // agent config (emotions / prompting.descriptions key moves on rename).
      if (mode === "atlas" && structuralTouched) {
        const patch: AtlasAnimationPatch = {};
        if (renamed) patch.rename = trimmedName;
        if (sequenceTouched && initialSeq) {
          if (fps !== initialSeq.fps && fps !== undefined) patch.fps = fps;
          if (loop !== initialSeq.loop) patch.loop = loop;
          if (holdLastFrame !== (initialSeq.holdLastFrame ?? false)) {
            patch.holdLastFrame = holdLastFrame;
          }
          if (iterations !== initialSeq.iterations) {
            patch.iterations = iterations ?? null;
          }
        }
        await patchAtlasAnimation(agentId, stateName, patch);

        // Move emotion + prompting.descriptions on rename / handle rigging.
        if (renamed || emotionTouched) {
          const nextEmotion: EmotionEntry | null =
            emotionEnabled && (emotionTouched || isRigged)
              ? {
                  description,
                  ...(emotionDirectiveHasAny(directive) ? { directive } : {}),
                }
              : null;
          const nextAgent = applyAgentEdit(agent, {
            oldName: stateName,
            newName: renamed ? trimmedName : undefined,
            nextEmotion,
            removeEmotion: !emotionEnabled,
          });
          await putAgent(agentId, nextAgent);
        }
        return;
      }

      // Emotion-only path: smaller payload, single-state PUT.
      if (!structuralTouched && emotionTouched) {
        if (emotionEnabled) {
          const entry: EmotionEntry = {
            description,
            ...(emotionDirectiveHasAny(directive) ? { directive } : {}),
          };
          await putEmotion(agentId, stateName, entry);
        } else {
          // Unrigging: drop the emotions[stateName] key via full putAgent.
          const next = applyAgentEdit(agent, {
            oldName: stateName,
            removeEmotion: true,
          });
          await putAgent(agentId, next);
        }
        return;
      }

      // Sprites structural path: rebuild the agent and PUT.
      const newSequence: SpriteSequence | null =
        sequenceTouched && initialSequence !== null
          ? buildSequence({
              prev: initialSequence,
              count,
              fps,
              loop,
              holdLastFrame,
              iterations,
              description: initialDescription,
            })
          : null;
      const nextEmotion: EmotionEntry | null =
        emotionEnabled && (emotionTouched || isRigged)
          ? {
              description,
              ...(emotionDirectiveHasAny(directive) ? { directive } : {}),
            }
          : null;
      const next = applyAgentEdit(agent, {
        oldName: stateName,
        newName: renamed ? trimmedName : undefined,
        newSequence,
        nextEmotion,
        removeEmotion: !emotionEnabled,
      });
      await putAgent(agentId, next);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["agents"] });
      // Manifest needs a refetch so the graph reflects new count/fps.
      await onAgentMutated();
    },
  });

  const del = useMutation({
    mutationFn: async () => {
      if (mode === "atlas") {
        await deleteAtlasAnimation(agentId, stateName);
        // Drop the orphaned emotion key (if any) so the config doesn't dangle.
        if (agent.emotions?.[stateName] !== undefined) {
          const nextAgent = applyAgentEdit(agent, {
            oldName: stateName,
            deleteState: true,
          });
          await putAgent(agentId, nextAgent);
        }
        return;
      }
      const next = applyAgentEdit(agent, {
        oldName: stateName,
        deleteState: true,
      });
      await putAgent(agentId, next);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["agents"] });
      await onAgentMutated();
    },
  });

  const onPrefillDescription = (): void => {
    if (prefillSource) setDescription(prefillSource);
  };

  const onConfirmDelete = (): void => {
    if (!window.confirm(`Delete animation "${stateName}"?`)) return;
    del.mutate();
  };

  return (
    <div className="card anim-card">
      <div className="anim-card__head">
        {canRename ? (
          <input
            className="anim-card__name"
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            aria-label="animation name"
          />
        ) : (
          <span className="anim-card__name anim-card__name--readonly">{stateName}</span>
        )}
        <span className={isRigged ? "rigged-badge" : "unrigged-badge"}>
          {isRigged ? "rigged" : "unrigged"}
        </span>
        {canDelete && (
          <button
            type="button"
            className="anim-card__delete"
            onClick={onConfirmDelete}
            disabled={del.isPending}
            title="Delete animation"
          >
            ✕
          </button>
        )}
      </div>
      {renameError && <div className="status error">{renameError}</div>}

      <div className="anim-card__summary" aria-label="animation summary">
        <span className="anim-card__chip">
          <strong>{preview.count}</strong> frame{preview.count === 1 ? "" : "s"}
        </span>
        <span className="anim-card__chip">
          @ <strong>{fps ?? initialSeq?.fps ?? preview.baseFps}</strong> fps
        </span>
        <span className="anim-card__chip" title="loop mode">
          {loop ?? initialSeq?.loop ?? "infinite"}
          {iterations !== undefined && (loop === "once" || initialSeq?.loop === "once")
            ? ` · ${iterations}×`
            : ""}
        </span>
        {(holdLastFrame || initialSeq?.holdLastFrame) && (
          <span className="anim-card__chip" title="holds last frame after the loop ends">
            holds last
          </span>
        )}
        {phased && (
          <span className="anim-card__chip anim-card__chip--phased" title="intro / loop / outro phases">
            phased
          </span>
        )}
      </div>

      <div className="anim-card__body">
        <div className="anim-card__preview">
          {!graph || !frameSource ? (
            <div className="status">loading…</div>
          ) : preview.count === 0 ? (
            <div className="status dim">no frames</div>
          ) : (
            <Frame frameRef={preview.frameRef} frameSource={frameSource} />
          )}
        </div>

        <div className="anim-card__controls">
          <div className="anim-card__transport">
            <button
              type="button"
              onClick={controls.restart}
              disabled={!previewReady}
              title="Restart from frame 0"
            >
              ⏮
            </button>
            <button
              type="button"
              onClick={() => controls.step(-1)}
              disabled={stepDisabled}
              title="Step back one frame"
            >
              ◀|
            </button>
            <button
              type="button"
              onClick={controls.toggle}
              disabled={!previewReady}
              title={preview.playing ? "Pause" : "Play"}
            >
              {preview.playing ? "⏸" : "▶"}
            </button>
            <button
              type="button"
              onClick={() => controls.step(1)}
              disabled={stepDisabled}
              title="Step forward one frame"
            >
              |▶
            </button>
            <span
              className="anim-card__counter"
              title="current frame / total frames"
            >
              {preview.count > 0
                ? `${preview.index + 1} / ${preview.count}`
                : "0 / 0"}
            </span>
          </div>

          {previewReady && preview.count > 1 && (
            <div className="anim-card__scrub">
              <input
                type="range"
                min={0}
                max={Math.max(0, preview.count - 1)}
                step={1}
                value={preview.index}
                onChange={(e) => controls.jumpTo(Number(e.target.value))}
                aria-label="scrub frame"
              />
            </div>
          )}

          <div className="anim-card__speed">
            <label>
              speed
              <span className="anim-card__speed-readout">
                {preview.speed.toFixed(2)}×
              </span>
            </label>
            <input
              type="range"
              min={0.25}
              max={4}
              step={0.05}
              value={preview.speed}
              onChange={(e) => controls.setSpeed(Number(e.target.value))}
              aria-label="playback speed multiplier"
            />
            <button
              type="button"
              className="link-btn"
              onClick={() => controls.setSpeed(1)}
              disabled={preview.speed === 1}
              title="Reset speed to 1×"
            >
              reset
            </button>
          </div>

          {mode === "sprites" && phased && (
            <div className="status dim">
              phased state (intro / loop / outro) — frame controls disabled in
              this pass
            </div>
          )}

          {canEditTiming && initialSeq && (
            <div className="field-row anim-card__timing">
              {canEditCount ? (
                <NumberInput
                  label="count"
                  min={1}
                  step={1}
                  value={count}
                  onChange={(v) => setCount(v ?? 1)}
                />
              ) : (
                <div className="field">
                  <label>frames</label>
                  <span className="anim-card__readout">{initialSeq.count}</span>
                </div>
              )}
              <NumberInput
                label="fps"
                min={1}
                max={120}
                step={1}
                value={fps}
                placeholder="12"
                onChange={(v) => setFps(v)}
              />
              <div className="field">
                <label>loop</label>
                <select
                  value={loop ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setLoop(v === "" ? undefined : (v as LoopMode));
                  }}
                >
                  <option value="">(default)</option>
                  <option value="infinite">infinite</option>
                  <option value="once">once</option>
                  <option value="ping-pong">ping-pong</option>
                </select>
              </div>
              <NumberInput
                label="iterations"
                min={1}
                step={1}
                value={iterations}
                placeholder="∞"
                onChange={(v) => setIterations(v)}
              />
              <div className="field anim-card__hold">
                <label>holdLastFrame</label>
                <input
                  type="checkbox"
                  checked={holdLastFrame}
                  onChange={(e) => setHoldLastFrame(e.target.checked)}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="anim-card__emotion">
        <label className="anim-card__rig-toggle">
          <input
            type="checkbox"
            checked={emotionEnabled}
            onChange={(e) => setEmotionEnabled(e.target.checked)}
          />
          rig to emotion
        </label>
        {emotionEnabled && (
          <EmotionFields
            description={description}
            directive={directive}
            onDescriptionChange={setDescription}
            onDirectiveChange={setDirective}
            onPrefillDescription={prefillSource ? onPrefillDescription : null}
          />
        )}
      </div>

      <div className="toolbar">
        {save.isError && <span className="status error">{String(save.error)}</span>}
        {del.isError && <span className="status error">{String(del.error)}</span>}
        {save.isSuccess && !dirty && <span className="status ok">saved</span>}
        <button
          className="primary"
          disabled={!dirty || Boolean(renameError) || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "saving…" : "save"}
        </button>
      </div>
    </div>
  );
}

function NumberInput({
  label,
  value,
  min,
  max,
  step,
  placeholder,
  onChange,
}: {
  label: string;
  value: number | undefined;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  onChange: (v: number | undefined) => void;
}): JSX.Element {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="number"
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange(undefined);
            return;
          }
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : undefined);
        }}
      />
    </div>
  );
}

// ----- helpers -----

function isFlatSequence(s: SpriteState): s is SpriteSequence & { description?: string } {
  return typeof (s as { count?: unknown }).count === "number";
}

function buildSequence(args: {
  prev: SpriteSequence;
  count: number;
  fps: number | undefined;
  loop: LoopMode | undefined;
  holdLastFrame: boolean;
  iterations: number | undefined;
  description: string | undefined;
}): SpriteSequence {
  const out: SpriteSequence & { description?: string } = { count: args.count };
  if (args.fps !== undefined) out.fps = args.fps;
  if (args.loop !== undefined) out.loop = args.loop;
  if (args.holdLastFrame) out.holdLastFrame = true;
  if (args.iterations !== undefined) out.iterations = args.iterations;
  if (args.description) out.description = args.description;
  return out;
}

type AgentEdit = {
  oldName: string;
  newName?: string;
  newSequence?: SpriteSequence | null;
  nextEmotion?: EmotionEntry | null;
  removeEmotion?: boolean;
  deleteState?: boolean;
};

/**
 * Build an updated AgentEntry from a single-card edit. Pure function — no
 * mutations of the input. Returns the body to PUT back to the server.
 *
 * Avatar.states modifications (rename / add / delete / sequence edits) only
 * apply to `kind: "sprites"` agents. For atlas agents, animation definitions
 * live in an external manifest file and the helper just touches the emotions
 * and prompting maps.
 */
export function applyAgentEdit(agent: AgentEntry, edit: AgentEdit): AgentEntry {
  const next: AgentEntry = JSON.parse(JSON.stringify(agent));
  const targetName = edit.newName ?? edit.oldName;

  if (next.avatar?.kind === "sprites") {
    const states = { ...next.avatar.states };
    if (edit.deleteState) {
      delete states[edit.oldName];
    } else {
      const existing = states[edit.oldName];
      const replaced = edit.newSequence ?? existing;
      if (edit.newName && edit.newName !== edit.oldName) {
        delete states[edit.oldName];
      }
      if (replaced) {
        states[targetName] = replaced;
      }
    }
    next.avatar = { ...next.avatar, states };
  }

  // Move emotions on rename / delete (any kind).
  const emotions = next.emotions ? { ...next.emotions } : undefined;
  if (emotions) {
    const oldEmotion = emotions[edit.oldName];
    if (edit.deleteState) {
      delete emotions[edit.oldName];
    } else if (edit.newName && edit.newName !== edit.oldName) {
      delete emotions[edit.oldName];
      if (oldEmotion && !edit.removeEmotion && edit.nextEmotion === undefined) {
        emotions[targetName] = oldEmotion;
      }
    }
    if (edit.removeEmotion) {
      delete emotions[targetName];
    } else if (edit.nextEmotion) {
      emotions[targetName] = edit.nextEmotion;
    }
    if (Object.keys(emotions).length === 0) {
      delete next.emotions;
    } else {
      next.emotions = emotions;
    }
  } else if (edit.nextEmotion) {
    next.emotions = { [targetName]: edit.nextEmotion };
  }

  // Move prompting.descriptions on rename / delete (any kind).
  if (next.prompting?.descriptions) {
    const descs = { ...next.prompting.descriptions };
    if (edit.deleteState) {
      delete descs[edit.oldName];
    } else if (edit.newName && edit.newName !== edit.oldName) {
      const old = descs[edit.oldName];
      delete descs[edit.oldName];
      if (old !== undefined) descs[targetName] = old;
    }
    next.prompting = { ...next.prompting, descriptions: descs };
  }

  return next;
}
