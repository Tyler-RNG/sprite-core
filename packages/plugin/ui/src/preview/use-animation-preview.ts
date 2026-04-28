import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FrameRef } from "@tylerwarburton/sprite-core-schema";
import { effectiveLoop, type AnimationGraph } from "@tylerwarburton/sprite-core-client";

const MIN_FRAME_DELAY_MS = 16;
const DEFAULT_FPS = 12;

/**
 * Dashboard-only playback driver.
 *
 * The cross-platform `SpriteAnimationPlayer` only exposes play / dispose, not
 * pause / step / scrub — extending it would touch Kotlin and Swift ports for
 * a feature only the editor needs. So the dashboard runs its own iterator
 * over the same `effectiveLoop(animation)` sequence the player would pick.
 *
 * Phased animations (intro/loop/outro) preview the loop phase only; intro
 * and outro editing is out of scope for this pass.
 */
export type PreviewState = {
  frameRef: FrameRef | null;
  index: number;
  count: number;
  playing: boolean;
  speed: number;
  baseFps: number;
};

export type PreviewControls = {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  step: (delta: number) => void;
  jumpTo: (i: number) => void;
  restart: () => void;
  setSpeed: (s: number) => void;
};

type LoopMode = "infinite" | "once" | "ping-pong";

export function useAnimationPreview(
  graph: AnimationGraph | null,
  stateName: string,
  /** Bumped externally when graph rebuilds; forces re-resolve + restart. */
  version: number,
): { state: PreviewState; controls: PreviewControls } {
  const frames: ReadonlyArray<FrameRef> = useMemo(() => {
    if (!graph) return [];
    const anim = graph.animations[stateName];
    if (!anim) return [];
    const seq = effectiveLoop(anim);
    return seq?.frames ?? [];
  }, [graph, stateName, version]);

  const baseFps = useMemo(() => {
    if (!graph) return DEFAULT_FPS;
    const anim = graph.animations[stateName];
    if (!anim) return DEFAULT_FPS;
    const seq = effectiveLoop(anim);
    return seq?.fps ?? DEFAULT_FPS;
  }, [graph, stateName, version]);

  const loopMode: LoopMode = useMemo(() => {
    if (!graph) return "infinite";
    const anim = graph.animations[stateName];
    if (!anim) return "infinite";
    const seq = effectiveLoop(anim);
    return (seq?.loop ?? "infinite") as LoopMode;
  }, [graph, stateName, version]);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  // Direction for ping-pong scrub: +1 forward, -1 reverse.
  const dirRef = useRef<1 | -1>(1);

  // Reset on state change / graph rebuild.
  useEffect(() => {
    setIndex(0);
    setPlaying(true);
    dirRef.current = 1;
  }, [stateName, version]);

  // Auto-advance.
  useEffect(() => {
    if (!playing) return;
    if (frames.length <= 1) return;
    const fps = Math.max(baseFps * speed, 0.1);
    const delay = Math.max(Math.floor(1000 / fps), MIN_FRAME_DELAY_MS);
    const id = setTimeout(() => {
      setIndex((i) => advance(i, frames.length, loopMode, dirRef, () => setPlaying(false)));
    }, delay);
    return () => clearTimeout(id);
  }, [playing, frames.length, baseFps, speed, loopMode, index]);

  const play = useCallback(() => {
    if (frames.length === 0) return;
    // If we ran past a "once" sequence, restart from 0 instead of stalling.
    if (loopMode === "once" && index >= frames.length - 1) {
      setIndex(0);
    }
    dirRef.current = 1;
    setPlaying(true);
  }, [frames.length, loopMode, index]);

  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => setPlaying((p) => !p), []);

  const step = useCallback(
    (delta: number) => {
      setPlaying(false);
      if (frames.length === 0) return;
      setIndex((i) => {
        const n = frames.length;
        const next = ((i + delta) % n + n) % n;
        return next;
      });
    },
    [frames.length],
  );

  const jumpTo = useCallback(
    (i: number) => {
      setPlaying(false);
      if (frames.length === 0) return;
      const clamped = Math.max(0, Math.min(frames.length - 1, Math.floor(i)));
      setIndex(clamped);
    },
    [frames.length],
  );

  const restart = useCallback(() => {
    setIndex(0);
    dirRef.current = 1;
    setPlaying(true);
  }, []);

  const frameRef: FrameRef | null = frames[index] ?? null;

  return {
    state: {
      frameRef,
      index,
      count: frames.length,
      playing,
      speed,
      baseFps,
    },
    controls: { play, pause, toggle, step, jumpTo, restart, setSpeed },
  };
}

function advance(
  i: number,
  n: number,
  mode: LoopMode,
  dirRef: { current: 1 | -1 },
  onStop: () => void,
): number {
  if (n <= 1) return 0;
  if (mode === "once") {
    if (i >= n - 1) {
      onStop();
      return n - 1;
    }
    return i + 1;
  }
  if (mode === "ping-pong") {
    const next = i + dirRef.current;
    if (next >= n) {
      dirRef.current = -1;
      return Math.max(0, n - 2);
    }
    if (next < 0) {
      dirRef.current = 1;
      return Math.min(n - 1, 1);
    }
    return next;
  }
  // infinite
  return (i + 1) % n;
}
