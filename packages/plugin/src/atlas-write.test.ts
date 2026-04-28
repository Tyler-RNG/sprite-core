import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyAtlasMutation,
  deleteAnimation,
  patchAnimation,
  type AtlasManifestJson,
} from "./atlas-write.js";

const SAMPLE: AtlasManifestJson = {
  image: "ginger.atlas.webp",
  size: { w: 1024, h: 1024 },
  frameSize: { w: 256, h: 256 },
  frames: {
    "idle/00": { x: 0, y: 0, w: 256, h: 256 },
    "idle/01": { x: 256, y: 0, w: 256, h: 256 },
    "happy/00": { x: 512, y: 0, w: 256, h: 256 },
  },
  animations: {
    idle: { frames: ["idle/00", "idle/01"], fps: 12, loop: "infinite" },
    happy: {
      frames: ["happy/00"],
      fps: 8,
      loop: "once",
      holdLastFrame: true,
    },
    thinking: {
      intro: { frames: ["idle/00"], fps: 24, loop: "once" },
      loop: { frames: ["idle/00", "idle/01"], fps: 12, loop: "infinite" },
      outro: { frames: ["idle/01"], fps: 24, loop: "once" },
    },
  },
  transitions: {
    "*->thinking": "thinking.intro",
    "thinking->*": "thinking.outro",
    "idle->happy": "happy",
  },
};

describe("patchAnimation", () => {
  it("updates fps and loop", () => {
    const r = patchAnimation(SAMPLE, "idle", { fps: 24, loop: "ping-pong" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.animations?.idle).toMatchObject({
      frames: ["idle/00", "idle/01"],
      fps: 24,
      loop: "ping-pong",
    });
  });

  it("clears holdLastFrame when set to false", () => {
    const r = patchAnimation(SAMPLE, "happy", { holdLastFrame: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.animations?.happy).not.toHaveProperty("holdLastFrame");
  });

  it("clears iterations when set to null", () => {
    const seeded: AtlasManifestJson = {
      ...SAMPLE,
      animations: {
        ...SAMPLE.animations,
        happy: { ...(SAMPLE.animations!.happy as object), iterations: 3 } as never,
      },
    };
    const r = patchAnimation(seeded, "happy", { iterations: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.animations?.happy).not.toHaveProperty("iterations");
  });

  it("renames the animation and rewrites transitions", () => {
    const r = patchAnimation(SAMPLE, "thinking", { rename: "pondering" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.animations).toHaveProperty("pondering");
    expect(r.manifest.animations).not.toHaveProperty("thinking");
    expect(r.manifest.transitions).toEqual({
      "*->pondering": "pondering.intro",
      "pondering->*": "pondering.outro",
      "idle->happy": "happy",
    });
  });

  it("rejects rename collisions", () => {
    const r = patchAnimation(SAMPLE, "idle", { rename: "happy" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("name-collision");
  });

  it("rejects invalid names", () => {
    const r = patchAnimation(SAMPLE, "idle", { rename: "spaces are bad" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid-input");
  });

  it("rejects out-of-range fps", () => {
    const r = patchAnimation(SAMPLE, "idle", { fps: 999 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid-input");
  });

  it("rejects phased animations", () => {
    const r = patchAnimation(SAMPLE, "thinking", { fps: 24 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("phased-not-editable");
  });

  it("returns unknown-animation when name not found", () => {
    const r = patchAnimation(SAMPLE, "nope", { fps: 24 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unknown-animation");
  });

  it("preserves other animations untouched", () => {
    const r = patchAnimation(SAMPLE, "idle", { fps: 24 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.animations?.happy).toEqual(SAMPLE.animations!.happy);
    expect(r.manifest.animations?.thinking).toEqual(SAMPLE.animations!.thinking);
  });
});

describe("deleteAnimation", () => {
  it("removes the entry and matching transitions", () => {
    const r = deleteAnimation(SAMPLE, "thinking");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.animations).not.toHaveProperty("thinking");
    expect(r.manifest.transitions).toEqual({ "idle->happy": "happy" });
  });

  it("clears the transitions map when no entries remain", () => {
    const sparse: AtlasManifestJson = {
      ...SAMPLE,
      transitions: { "*->thinking": "thinking.intro" },
    };
    const r = deleteAnimation(sparse, "thinking");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.transitions).toBeUndefined();
  });

  it("returns unknown-animation when name not found", () => {
    const r = deleteAnimation(SAMPLE, "nope");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unknown-animation");
  });
});

describe("applyAtlasMutation", () => {
  let dir: string;
  let absolutePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-write-"));
    absolutePath = path.join(dir, "ginger.atlas.json");
    await fs.writeFile(absolutePath, JSON.stringify(SAMPLE, null, 2), "utf8");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("round-trips a patch through the file", async () => {
    const result = await applyAtlasMutation(
      { absolutePath, manifestRelative: "ginger.atlas.json", agentId: "ginger" },
      (m) => patchAnimation(m, "idle", { fps: 30 }),
    );
    expect(result.ok).toBe(true);
    const reread = JSON.parse(await fs.readFile(absolutePath, "utf8"));
    expect(reread.animations.idle.fps).toBe(30);
  });

  it("returns mutate-stage error without touching the file", async () => {
    const before = await fs.readFile(absolutePath, "utf8");
    const result = await applyAtlasMutation(
      { absolutePath, manifestRelative: "ginger.atlas.json", agentId: "ginger" },
      (m) => patchAnimation(m, "thinking", { fps: 30 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("mutate");
    const after = await fs.readFile(absolutePath, "utf8");
    expect(after).toBe(before);
  });

  it("serializes concurrent mutations on the same file", async () => {
    const paths = {
      absolutePath,
      manifestRelative: "ginger.atlas.json",
      agentId: "ginger",
    };
    // Two concurrent mutations would clobber each other without the chain.
    const [a, b] = await Promise.all([
      applyAtlasMutation(paths, (m) => patchAnimation(m, "idle", { fps: 24 })),
      applyAtlasMutation(paths, (m) => patchAnimation(m, "happy", { fps: 6 })),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const reread = JSON.parse(await fs.readFile(absolutePath, "utf8"));
    expect(reread.animations.idle.fps).toBe(24);
    expect(reread.animations.happy.fps).toBe(6);
  });
});
