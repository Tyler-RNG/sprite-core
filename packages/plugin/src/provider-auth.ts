import { isSecretRef, resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";

/**
 * Shared ElevenLabs API key resolver used by both the TTS and STT proxy
 * routes. Accepts a raw `SecretInput` from plugin config and returns the
 * resolved string or `undefined` when the key can't be sourced.
 *
 * Resolution order:
 * 1. Plain-string path via the SDK's secret resolver (handles malformed input
 *    normalization too).
 * 2. Env-backed `SecretRef` via `process.env` lookup.
 *
 * Future backends (file/exec/keychain) can be added here; env covers every
 * current SpriteCore deployment. `configPath` is the dotted path used for
 * diagnostic messages from the SDK resolver.
 *
 * Note: `resolveSecretInputString` defaults to `mode: "strict"` which throws
 * on SecretRefs (the expectation being that callers pre-resolve them). This
 * plugin resolves env-backed refs manually further down, so we opt into
 * `mode: "inspect"` to get a status record instead of a throw. Without that,
 * every call with a SecretRef config (the normal case) would blow up before
 * the env-fallback branch even ran, turning `/stream/tts` + `/stream/stt`
 * into 500 Internal Server Error.
 */
export async function resolveElevenLabsApiKey(params: {
  apiKey: SecretInput | undefined;
  configPath: string;
}): Promise<string | undefined> {
  const raw = params.apiKey;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const resolved = resolveSecretInputString({
    value: raw,
    path: params.configPath,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    return resolved.value;
  }
  if (isSecretRef(raw) && raw.source === "env" && typeof raw.id === "string") {
    const value = process.env[raw.id];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}
