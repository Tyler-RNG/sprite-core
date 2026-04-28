import type {
  Animation,
  CharacterManifest,
  TransitionRef,
} from "./schema.js";

/**
 * Resolved animation table + transition graph for a single mode of a single
 * character. Both sprite and atlas manifests project into this shape so the
 * player stays format-agnostic.
 *
 * Build via [fromManifest] to pull a mode's content out of a server-synthesized
 * [CharacterManifest], or construct directly for tests.
 */
export class AnimationGraph {
  constructor(
    readonly defaultState: string,
    readonly animations: Readonly<Record<string, Animation>>,
    readonly transitions: Readonly<Record<string, TransitionRef>>,
  ) {}

  /**
   * Resolve a state→state transition against the transitions table using
   * wildcard pattern matching. Specificity order (most→least specific):
   *
   *   "<from>-><to>" → "<from>->*" → "*-><to>" → "*->*"
   *
   * Returns null when nothing matches; the caller then swaps instantly.
   */
  resolveTransition(from: string, to: string): TransitionRef | null {
    const keys = [`${from}->${to}`, `${from}->*`, `*->${to}`, `*->*`];
    for (const k of keys) {
      const t = this.transitions[k];
      if (t !== undefined) return t;
    }
    return null;
  }

  /**
   * Extract a single mode's animation graph from a character manifest. The
   * default state is taken from [stateMap] — the first key that maps to an
   * animation present in [mode]'s content — or fails if no animation is
   * present.
   */
  static fromManifest(manifest: CharacterManifest, mode: string): AnimationGraph {
    const content = manifest.content[mode];
    if (!content) {
      throw new Error(
        `manifest has no content for mode '${mode}'. Available: [${Object.keys(manifest.content).join(", ")}]`,
      );
    }
    const defaultState = resolveDefaultState(manifest.stateMap, content.animations);
    return new AnimationGraph(defaultState, content.animations, content.transitions ?? {});
  }
}

function resolveDefaultState(
  stateMap: Record<string, string>,
  animations: Record<string, Animation>,
): string {
  for (const [, animName] of Object.entries(stateMap)) {
    if (animName in animations) return animName;
  }
  const first = Object.keys(animations)[0];
  if (first === undefined) {
    throw new Error("manifest mode has no animations");
  }
  return first;
}

/** The three phases of a phased animation; flat animations use `loop`. */
export type Phase = "intro" | "loop" | "outro";

/**
 * A transition target resolved for playback: which animation + phase to play
 * once before entering the target state's own loop. Used by the player when a
 * phase-string `TransitionRef` fires on state change.
 */
export type ResolvedTransition = {
  animation: string;
  phase: Phase;
};

/** Parse `"thinking.intro"` into `{ animation: "thinking", phase: "intro" }`. Unqualified → loop. */
export function resolveTransition(ref: string): ResolvedTransition {
  const dot = ref.indexOf(".");
  if (dot < 0) return { animation: ref, phase: "loop" };
  const phase = ref.slice(dot + 1) as Phase;
  if (phase !== "intro" && phase !== "loop" && phase !== "outro") {
    throw new Error(`unknown phase: ${phase}`);
  }
  return { animation: ref.slice(0, dot), phase };
}

/**
 * Treat a flat animation as the `loop` phase so the player can always look up
 * phases by name without special-casing flat vs phased at every site.
 */
export function effectiveLoop(anim: Animation) {
  return anim.loop ?? anim.sequence;
}
