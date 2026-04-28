import { isSecretRef, resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";

/**
 * Resolve the pixellab.ai API key from plugin config or environment.
 *
 * Resolution order:
 *  1. `pixellab.apiKey` from plugin config (string or env-backed SecretRef).
 *  2. `process.env.PIXELLAB_API_KEY` as a fallback (matches the CLI scripts).
 *
 * Returns `undefined` when no key is available — callers should respond 503.
 *
 * Why mirrored from `provider-auth.ts` rather than reused: the existing helper
 * is named `resolveElevenLabsApiKey` and only walks `streamTts.apiKey`. Sharing
 * a generic resolver would entangle the two providers' config paths in a way
 * that future divergence (different default-mode policies, different fallbacks)
 * would have to undo. Easier to keep them parallel.
 */
export async function resolvePixellabApiKey(params: {
  apiKey: SecretInput | undefined;
  configPath: string;
}): Promise<string | undefined> {
  const raw = params.apiKey;
  if (raw !== undefined && raw !== null) {
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
  }
  const fallback = process.env.PIXELLAB_API_KEY;
  if (typeof fallback === "string" && fallback.trim().length > 0) {
    return fallback.trim();
  }
  return undefined;
}
