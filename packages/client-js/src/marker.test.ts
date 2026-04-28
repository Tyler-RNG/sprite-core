import { describe, it, expect } from "vitest";
import {
  createAvatarMarkerParser,
  parseAvatarMarkers,
  resolveStateAndCount,
  splitByMarkers,
} from "./schema.js";

describe("resolveStateAndCount", () => {
  it("parses bare state with no dash", () => {
    expect(resolveStateAndCount("happy")).toEqual({ state: "happy", count: null });
  });
  it("parses state-N with numeric suffix", () => {
    expect(resolveStateAndCount("happy-3")).toEqual({ state: "happy", count: 3 });
    expect(resolveStateAndCount("wink-1")).toEqual({ state: "wink", count: 1 });
    expect(resolveStateAndCount("happy-0")).toEqual({ state: "happy", count: 0 });
  });
  it("leaves non-numeric dash suffixes alone", () => {
    expect(resolveStateAndCount("head-cocked")).toEqual({
      state: "head-cocked",
      count: null,
    });
  });
  it("triggers on the last dash only", () => {
    expect(resolveStateAndCount("head_cocked-1")).toEqual({
      state: "head_cocked",
      count: 1,
    });
  });
});

describe("createAvatarMarkerParser", () => {
  it("strips a single marker and surfaces it", () => {
    const p = createAvatarMarkerParser();
    const { cleanedText, markers } = p.push("hello <<<happy>>> world");
    expect(cleanedText).toBe("hello  world");
    expect(markers).toEqual([{ state: "happy", count: null }]);
  });

  it("preserves invalid marker shapes as literal text", () => {
    const { cleanedText, markers } = parseAvatarMarkers("bad <<<has space>>> marker");
    expect(cleanedText).toBe("bad <<<has space>>> marker");
    expect(markers).toEqual([]);
  });

  it("recognizes a marker split across two chunks", () => {
    const p = createAvatarMarkerParser();
    const a = p.push("start <<<hap");
    const b = p.push("py>>> end");
    expect(a.cleanedText + b.cleanedText).toBe("start  end");
    expect([...a.markers, ...b.markers]).toEqual([{ state: "happy", count: null }]);
  });

  it("surfaces play-count markers", () => {
    const { markers } = parseAvatarMarkers("say <<<wink-1>>> it");
    expect(markers).toEqual([{ state: "wink", count: 1 }]);
  });

  it("flushes unterminated markers as literal text", () => {
    const p = createAvatarMarkerParser();
    const a = p.push("tail <<<happ");
    const b = p.flush();
    expect(a.cleanedText + b.cleanedText).toBe("tail <<<happ");
    expect([...a.markers, ...b.markers]).toEqual([]);
  });

  it("handles tail of trailing < as partial start", () => {
    const p = createAvatarMarkerParser();
    const a = p.push("ok <<");
    expect(a.cleanedText).toBe("ok ");
    const b = p.push("<happy>>> done");
    expect(a.cleanedText + b.cleanedText).toBe("ok  done");
    expect([...a.markers, ...b.markers]).toEqual([{ state: "happy", count: null }]);
  });
});

describe("splitByMarkers", () => {
  it("splits with preceding emotion attached to each segment", () => {
    const segs = splitByMarkers("hi <<<happy>>> world <<<sad>>> end");
    expect(segs).toEqual([
      { text: "hi ", emotion: null, emotionCount: null },
      { text: " world ", emotion: "happy", emotionCount: null },
      { text: " end", emotion: "sad", emotionCount: null },
    ]);
  });

  it("forwards count onto the segment", () => {
    const segs = splitByMarkers("<<<wink-2>>> hello");
    expect(segs).toEqual([{ text: " hello", emotion: "wink", emotionCount: 2 }]);
  });
});
