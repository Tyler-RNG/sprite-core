import { describe, expect, it } from "vitest";
import { AnimationGraph, resolveTransition } from "./animation-graph.js";
import type { CharacterManifest } from "./schema.js";

const baseManifest: CharacterManifest = {
  version: 1,
  agentId: "agent",
  modes: ["headshot"],
  stateMap: { idle: "idle", thinking: "thinking" },
  content: {
    headshot: {
      animations: {
        idle: {
          sequence: {
            frames: [{ ref: "idle.00" }],
            fps: 12,
            loop: "infinite",
          },
        },
        thinking: {
          intro: {
            frames: [{ ref: "thinking.intro.00" }],
            fps: 24,
            loop: "once",
          },
          loop: {
            frames: [{ ref: "thinking.loop.00" }],
            fps: 12,
            loop: "infinite",
          },
          outro: {
            frames: [{ ref: "thinking.outro.00" }],
            fps: 24,
            loop: "once",
          },
        },
      },
      transitions: {
        "*->thinking": "thinking.intro",
        "thinking->*": "thinking.outro",
      },
    },
  },
  assets: {
    refs: {
      "idle.00": "atlas/idle_00.webp",
      "thinking.intro.00": "atlas/thinking_intro_00.webp",
      "thinking.loop.00": "atlas/thinking_loop_00.webp",
      "thinking.outro.00": "atlas/thinking_outro_00.webp",
    },
  },
};

describe("AnimationGraph.fromManifest", () => {
  it("projects a mode's content into a graph", () => {
    const g = AnimationGraph.fromManifest(baseManifest, "headshot");
    expect(g.defaultState).toBe("idle");
    expect(Object.keys(g.animations).sort()).toEqual(["idle", "thinking"]);
    expect(g.transitions["*->thinking"]).toBe("thinking.intro");
  });

  it("throws when the mode is absent", () => {
    expect(() => AnimationGraph.fromManifest(baseManifest, "fullbody")).toThrow(
      /no content for mode/,
    );
  });

  it("resolves transitions with wildcard precedence", () => {
    const g = AnimationGraph.fromManifest(baseManifest, "headshot");
    expect(g.resolveTransition("idle", "thinking")).toBe("thinking.intro");
    expect(g.resolveTransition("thinking", "idle")).toBe("thinking.outro");
    expect(g.resolveTransition("unknown", "also-unknown")).toBeNull();
  });
});

describe("resolveTransition", () => {
  it("parses phase refs", () => {
    expect(resolveTransition("thinking.intro")).toEqual({
      animation: "thinking",
      phase: "intro",
    });
    expect(resolveTransition("thinking")).toEqual({
      animation: "thinking",
      phase: "loop",
    });
  });
});
