import type {
  Animation,
  FrameRef,
  FrameSequence,
  LoopMode,
} from "./schema.js";
import {
  AnimationGraph,
  effectiveLoop,
  resolveTransition,
  type Phase,
} from "./animation-graph.js";
import { type Observable, MutableObservable } from "./observable.js";
import { SystemTicker, type Ticker } from "./ticker.js";

const MIN_FRAME_DELAY_MS = 16;

class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

/**
 * Platform-independent playback engine. One instance per character per mode.
 * Drives `currentRef` forward over time according to the `AnimationGraph`'s
 * animations and transitions; callers materialize frames via their own
 * `FrameSource`.
 *
 * Mirrors the Kotlin `SpriteAnimationPlayer`. Thread/task safety: `requestState`
 * is safe to call from any context; internal transitions cancel the previous
 * playback via an `AbortController` before the new one starts.
 */
export class SpriteAnimationPlayer {
  private readonly ticker: Ticker;
  private readonly _currentRef = new MutableObservable<FrameRef | null>(null);
  private readonly _currentState: MutableObservable<string>;
  private abortController: AbortController | null = null;
  private runningTask: Promise<void> | null = null;

  readonly currentRef: Observable<FrameRef | null> = this._currentRef;
  readonly currentState: Observable<string>;

  constructor(private readonly graph: AnimationGraph, ticker: Ticker = new SystemTicker()) {
    this.ticker = ticker;
    this._currentState = new MutableObservable<string>(graph.defaultState);
    this.currentState = this._currentState;
    // Start playing the default state (entering=true so intros fire).
    this.runningTask = this.spawn((signal) => this.playState(graph.defaultState, true, null, signal));
  }

  /**
   * Request a state change. If the graph's transitions table has a match for
   * `currentState → target`, that transition plays once before the target
   * state's own loop starts.
   *
   * `playCount` semantics (from `<<<state-N>>>`):
   *   - null or 0 — loop indefinitely until the next `requestState`
   *   - N >= 1    — play the loop phase exactly N times, then hold the last
   *                 frame indefinitely. Intro (if any) still plays once.
   *
   * When `playCount` is non-null we always replay — even when `target` is
   * already the current state — so a model emitting the same marker twice in
   * a row visibly replays the animation instead of being swallowed as a no-op.
   */
  async requestState(target: string, playCount: number | null = null): Promise<void> {
    const previousState = this._currentState.value;
    const sameState = target === previousState;
    const effectiveCount = playCount !== null && playCount > 0 ? playCount : null;

    // Cancel whatever was running.
    await this.cancelRunning();

    if (sameState && effectiveCount === null) {
      return;
    }

    this.runningTask = this.spawn(async (signal) => {
      if (!sameState) {
        const transition = this.graph.resolveTransition(previousState, target);
        if (typeof transition === "string") {
          const { animation, phase } = resolveTransition(transition);
          await this.playPhase(animation, phase, "once", signal);
        }
        // Crossfade transitions are a rendering-side concern the consumer
        // applies when the ref changes; the player just snaps through.
      }
      await this.playState(target, !sameState, effectiveCount, signal);
    });
  }

  /** Cancel playback and release internal resources. */
  async dispose(): Promise<void> {
    await this.cancelRunning();
  }

  // --- internals ---

  private spawn(body: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    const task = (async () => {
      try {
        await body(controller.signal);
      } catch (err) {
        if (!(err instanceof CancelledError)) {
          throw err;
        }
      }
    })();
    return task;
  }

  private async cancelRunning(): Promise<void> {
    const prev = this.runningTask;
    const prevController = this.abortController;
    this.runningTask = null;
    this.abortController = null;
    if (prevController) prevController.abort();
    if (prev) {
      try {
        await prev;
      } catch {
        /* swallow */
      }
    }
  }

  private async playState(
    state: string,
    entering: boolean,
    playCountOverride: number | null,
    signal: AbortSignal,
  ): Promise<void> {
    this._currentState.set(state);
    const anim = this.graph.animations[state];
    if (!anim) return;
    if (entering && anim.intro) {
      await this.playPhase(state, "intro", null, signal);
    }
    if (playCountOverride !== null && playCountOverride >= 1) {
      await this.playPhaseFinite(state, "loop", playCountOverride, signal);
      return;
    }
    // Flat states fall through to `effectiveLoop`; phased states play `loop`.
    // `outro` fires only via requestState() transitions.
    await this.playPhase(state, "loop", null, signal);
  }

  private async playPhaseFinite(
    animName: string,
    phase: Phase,
    times: number,
    signal: AbortSignal,
  ): Promise<void> {
    const anim = this.graph.animations[animName];
    if (!anim) return;
    const seq = pickPhase(anim, phase);
    if (!seq || seq.frames.length === 0) return;
    const frameDelayMs = Math.max(Math.floor(1000 / seq.fps), MIN_FRAME_DELAY_MS);
    for (let round = 0; round < times; round++) {
      for (const ref of seq.frames) {
        this.throwIfCancelled(signal);
        this._currentRef.set(ref);
        await this.delayCancellable(frameDelayMs, signal);
      }
    }
    this._currentRef.set(seq.frames[seq.frames.length - 1] ?? null);
    await awaitCancellation(signal);
  }

  private async playPhase(
    animName: string,
    phase: Phase,
    loopOverride: LoopMode | null,
    signal: AbortSignal,
  ): Promise<void> {
    const anim = this.graph.animations[animName];
    if (!anim) return;
    const seq = pickPhase(anim, phase);
    if (!seq || seq.frames.length === 0) return;
    const frameDelayMs = Math.max(Math.floor(1000 / seq.fps), MIN_FRAME_DELAY_MS);
    const loop: LoopMode = loopOverride ?? seq.loop;

    if (loop === "once") {
      for (const ref of seq.frames) {
        this.throwIfCancelled(signal);
        this._currentRef.set(ref);
        await this.delayCancellable(frameDelayMs, signal);
      }
      if (!seq.holdLastFrame) {
        this._currentRef.set(null);
      }
      return;
    }

    if (loop === "ping-pong") {
      const cap = seq.iterations ?? Number.MAX_SAFE_INTEGER;
      let rounds = 0;
      while (rounds < cap) {
        for (const ref of seq.frames) {
          this.throwIfCancelled(signal);
          this._currentRef.set(ref);
          await this.delayCancellable(frameDelayMs, signal);
        }
        for (let i = seq.frames.length - 2; i >= 1; i--) {
          this.throwIfCancelled(signal);
          const ref = seq.frames[i];
          if (ref !== undefined) this._currentRef.set(ref);
          await this.delayCancellable(frameDelayMs, signal);
        }
        rounds++;
      }
      return;
    }

    // infinite
    for (;;) {
      for (const ref of seq.frames) {
        this.throwIfCancelled(signal);
        this._currentRef.set(ref);
        await this.delayCancellable(frameDelayMs, signal);
      }
    }
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new CancelledError();
  }

  private async delayCancellable(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new CancelledError();
    await Promise.race([
      this.ticker.delay(ms),
      new Promise<void>((_, reject) => {
        const onAbort = () => reject(new CancelledError());
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (signal.aborted) throw new CancelledError();
  }
}

function pickPhase(anim: Animation, phase: Phase): FrameSequence | undefined {
  if (phase === "intro") return anim.intro;
  if (phase === "outro") return anim.outro;
  return effectiveLoop(anim);
}

function awaitCancellation(signal: AbortSignal): Promise<void> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new CancelledError());
      return;
    }
    signal.addEventListener("abort", () => reject(new CancelledError()), { once: true });
  });
}
