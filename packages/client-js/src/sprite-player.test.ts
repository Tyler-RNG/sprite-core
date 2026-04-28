import { afterEach, describe, expect, it } from "vitest";
import { AnimationGraph } from "./animation-graph.js";
import { SpriteAnimationPlayer } from "./sprite-player.js";
import type { CharacterManifest } from "./schema.js";
import type { Ticker } from "./ticker.js";

const manifest: CharacterManifest = {
  version: 1,
  agentId: "agent",
  modes: ["headshot"],
  stateMap: { idle: "idle", wink: "wink" },
  content: {
    headshot: {
      animations: {
        idle: {
          sequence: {
            frames: [{ ref: "idle.00" }, { ref: "idle.01" }],
            fps: 60,
            loop: "infinite",
          },
        },
        wink: {
          sequence: {
            frames: [{ ref: "wink.00" }, { ref: "wink.01" }],
            fps: 60,
            loop: "once",
            holdLastFrame: true,
          },
        },
      },
    },
  },
  assets: {
    refs: {
      "idle.00": "p/idle_00",
      "idle.01": "p/idle_01",
      "wink.00": "p/wink_00",
      "wink.01": "p/wink_01",
    },
  },
};

/** Ticker whose `delay` resolves immediately — tests just walk state. */
class ImmediateTicker implements Ticker {
  async delay(_ms: number): Promise<void> {
    // microtask yield so the player's loop advances
    await Promise.resolve();
  }
}

async function flushMicrotasks(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("SpriteAnimationPlayer", () => {
  let player: SpriteAnimationPlayer | null = null;
  afterEach(async () => {
    if (player) await player.dispose();
    player = null;
  });

  it("starts on the default state and emits the first frame", async () => {
    const graph = AnimationGraph.fromManifest(manifest, "headshot");
    player = new SpriteAnimationPlayer(graph, new ImmediateTicker());
    await flushMicrotasks();
    expect(player.currentState.value).toBe("idle");
    expect(player.currentRef.value?.ref).toMatch(/^idle\./);
  });

  it("requestState switches state", async () => {
    const graph = AnimationGraph.fromManifest(manifest, "headshot");
    player = new SpriteAnimationPlayer(graph, new ImmediateTicker());
    await flushMicrotasks();
    await player.requestState("wink");
    await flushMicrotasks();
    expect(player.currentState.value).toBe("wink");
  });

  it("requestState with playCount replays even when already in state", async () => {
    const graph = AnimationGraph.fromManifest(manifest, "headshot");
    player = new SpriteAnimationPlayer(graph, new ImmediateTicker());
    await flushMicrotasks();
    await player.requestState("wink", 1);
    await flushMicrotasks();
    expect(player.currentState.value).toBe("wink");
    // Second call with the same state+count should not error or hang.
    await player.requestState("wink", 1);
    await flushMicrotasks();
    expect(player.currentState.value).toBe("wink");
  });
});
