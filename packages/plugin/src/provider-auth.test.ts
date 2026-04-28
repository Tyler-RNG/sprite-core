import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveElevenLabsApiKey } from "./provider-auth.js";

describe("resolveElevenLabsApiKey", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SPRITE_CORE_TEST_KEY;
    delete process.env.SPRITE_CORE_EMPTY_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns undefined when apiKey is unset", async () => {
    expect(
      await resolveElevenLabsApiKey({ apiKey: undefined, configPath: "test" }),
    ).toBeUndefined();
  });

  it("returns a trimmed plain string when apiKey is a string", async () => {
    expect(await resolveElevenLabsApiKey({ apiKey: "  sk-abc  ", configPath: "test" })).toBe(
      "sk-abc",
    );
  });

  it("resolves an env-backed SecretRef from process.env without throwing (regression: inspect mode)", async () => {
    // Prior to fix: resolveSecretInputString defaulted to mode:"strict" and
    // threw on any SecretRef before the env fallback below had a chance to
    // run, producing plaintext 500 responses on /stream/tts + /stream/stt.
    // This test pins the inspect-mode contract so the helper always falls
    // through to the env lookup.
    process.env.SPRITE_CORE_TEST_KEY = "sk-from-env";
    const result = await resolveElevenLabsApiKey({
      apiKey: { source: "env", provider: "default", id: "SPRITE_CORE_TEST_KEY" },
      configPath: "test",
    });
    expect(result).toBe("sk-from-env");
  });

  it("returns undefined when env-backed SecretRef target is missing", async () => {
    const result = await resolveElevenLabsApiKey({
      apiKey: { source: "env", provider: "default", id: "SPRITE_CORE_DEFINITELY_NOT_SET_XYZ" },
      configPath: "test",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when env-backed SecretRef target is whitespace-only", async () => {
    process.env.SPRITE_CORE_EMPTY_KEY = "   ";
    const result = await resolveElevenLabsApiKey({
      apiKey: { source: "env", provider: "default", id: "SPRITE_CORE_EMPTY_KEY" },
      configPath: "test",
    });
    expect(result).toBeUndefined();
  });
});
