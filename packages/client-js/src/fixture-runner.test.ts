import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AnimationGraph,
  InMemorySpriteSource,
  SpriteAnimationPlayer,
  createAvatarMarkerParser,
} from "./index.js";
import type { CharacterManifest, FrameRef } from "./schema.js";
import type { Ticker } from "./ticker.js";

// Walk up to the repo root (two levels above packages/client-js).
const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
);

type AnyFixture =
  | ManifestFixture
  | MarkerFixture
  | AnimationGraphFixture
  | SpritePlayerFixture;

type ManifestFixture = {
  kind: "manifest";
  description: string;
  manifest: CharacterManifest;
};

type MarkerFixture = {
  kind: "marker";
  description: string;
  cases: {
    name: string;
    chunks: string[];
    expectedCleanedText: string;
    expectedMarkers: { state: string; count: number | null }[];
  }[];
};

type TransitionExpectation = string | { blend: string; ms: number } | null;

type AnimationGraphFixture = {
  kind: "animation-graph";
  description: string;
  manifest: CharacterManifest;
  mode: string;
  cases: {
    name: string;
    resolveTransition: { from: string; to: string };
    expected: TransitionExpectation;
  }[];
};

type SpritePlayerFixture = {
  kind: "sprite-player";
  description: string;
  manifest: CharacterManifest;
  mode: string;
  requests: { target: string; playCount: number | null; advanceMs: number }[];
  expectedRefSequencePrefix: string[];
  expectedHoldRef?: string;
};

function listFixtureFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFixtureFiles(full));
    else if (entry.endsWith(".json")) out.push(full);
  }
  return out;
}

function loadFixture(path: string): AnyFixture {
  return JSON.parse(readFileSync(path, "utf8")) as AnyFixture;
}

/** Fake ticker that resolves each delay on the next microtask. */
class MicrotaskTicker implements Ticker {
  async delay(_ms: number): Promise<void> {
    await Promise.resolve();
  }
}

async function flushMicrotasks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

async function collectPlayerRefs(
  fixture: SpritePlayerFixture,
): Promise<{ emitted: FrameRef[]; holdRef: FrameRef | null }> {
  const graph = AnimationGraph.fromManifest(fixture.manifest, fixture.mode);
  const player = new SpriteAnimationPlayer(graph, new MicrotaskTicker());
  const emitted: FrameRef[] = [];
  let lastRef: FrameRef | null = null;
  const unsub = player.currentRef.subscribe((ref) => {
    if (ref && ref !== lastRef) {
      emitted.push(ref);
      lastRef = ref;
    }
  });
  // Let the default-state start-up run.
  await flushMicrotasks(40);
  for (const req of fixture.requests) {
    await player.requestState(req.target, req.playCount);
    await flushMicrotasks(Math.max(20, Math.floor(req.advanceMs / 8)));
  }
  const holdRef = player.currentRef.value;
  unsub();
  await player.dispose();
  return { emitted, holdRef };
}

function runMarkerCase(c: MarkerFixture["cases"][number]): void {
  const parser = createAvatarMarkerParser();
  let cleaned = "";
  const markers: { state: string; count: number | null }[] = [];
  for (const chunk of c.chunks) {
    const r = parser.push(chunk);
    cleaned += r.cleanedText;
    markers.push(...r.markers);
  }
  const tail = parser.flush();
  cleaned += tail.cleanedText;
  markers.push(...tail.markers);
  expect(cleaned).toBe(c.expectedCleanedText);
  expect(markers).toEqual(c.expectedMarkers);
}

function runAnimationGraphCase(
  fixture: AnimationGraphFixture,
  c: AnimationGraphFixture["cases"][number],
): void {
  const graph = AnimationGraph.fromManifest(fixture.manifest, fixture.mode);
  const actual = graph.resolveTransition(c.resolveTransition.from, c.resolveTransition.to);
  if (c.expected === null) {
    expect(actual).toBeNull();
  } else if (typeof c.expected === "string") {
    expect(actual).toBe(c.expected);
  } else {
    expect(actual).toEqual(c.expected);
  }
}

describe("fixtures", () => {
  const files = listFixtureFiles(fixturesRoot);
  for (const file of files) {
    const rel = relative(fixturesRoot, file);
    const fixture = loadFixture(file);
    describe(rel, () => {
      if (fixture.kind === "manifest") {
        it("decodes", () => {
          // Round-trip through JSON.parse → schema types. The TS types are
          // structural, so just asserting the fields exist is enough; the
          // AJV validators live in the schema package and aren't needed
          // here.
          expect(fixture.manifest.version).toBeTypeOf("number");
          expect(fixture.manifest.agentId.length).toBeGreaterThan(0);
          expect(fixture.manifest.modes.length).toBeGreaterThan(0);
        });
      } else if (fixture.kind === "marker") {
        for (const c of fixture.cases) {
          it(c.name, () => {
            runMarkerCase(c);
          });
        }
      } else if (fixture.kind === "animation-graph") {
        for (const c of fixture.cases) {
          it(c.name, () => {
            runAnimationGraphCase(fixture, c);
          });
        }
      } else if (fixture.kind === "sprite-player") {
        it("emits the expected prefix", async () => {
          const { emitted, holdRef } = await collectPlayerRefs(fixture);
          const emittedRefs = emitted.map((r) => r.ref);
          expect(emittedRefs.slice(0, fixture.expectedRefSequencePrefix.length)).toEqual(
            fixture.expectedRefSequencePrefix,
          );
          if (fixture.expectedHoldRef !== undefined) {
            expect(holdRef?.ref).toBe(fixture.expectedHoldRef);
          }
        });
      } else {
        const anyFixture = fixture as { kind: string };
        it("unknown kind", () => {
          throw new Error(`unknown fixture kind: ${anyFixture.kind}`);
        });
      }
    });
  }
});
