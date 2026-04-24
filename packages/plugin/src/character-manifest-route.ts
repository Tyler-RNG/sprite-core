import type { IncomingMessage, ServerResponse } from "node:http";
import { buildCharacterManifest } from "./character-manifest.js";
import { sendJson, sendMethodNotAllowed } from "./http-helpers.js";
import type { SpriteCoreConfig } from "./types.js";

export const CHARACTER_MANIFEST_ROUTE_PATH = "/sprite-core/character-manifest";

export type CharacterManifestRouteOptions = {
  readPluginConfig: () => SpriteCoreConfig | undefined;
};

/**
 * `GET /sprite-core/character-manifest?agentId=<id>[&mode=<mode>]` — HTTP
 * sibling of the `node.getCharacterManifest` gateway RPC. Exposes the same
 * manifest the phone/watch clients already fetch over WebSocket, but on the
 * HTTP plane so the plugin's browser UI can drive the SDK's `AssetSource`
 * without speaking the gateway WebSocket protocol.
 *
 * Response matches `NodeGetCharacterManifestResult`: `{ manifest, revision }`.
 * Registered with `auth: "gateway"` by the caller.
 */
export async function handleCharacterManifestRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: CharacterManifestRouteOptions,
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(urlRaw, "http://localhost");
  } catch {
    return false;
  }
  if (url.pathname !== CHARACTER_MANIFEST_ROUTE_PATH) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const agentId = url.searchParams.get("agentId")?.trim();
  if (!agentId) {
    sendJson(res, 400, {
      error: { message: "agentId required", type: "invalid_request_error" },
    });
    return true;
  }

  const modeParam = url.searchParams.get("mode");
  const modes = modeParam ? [modeParam] : undefined;

  const result = await buildCharacterManifest({
    pluginConfig: opts.readPluginConfig(),
    agentId,
    modes,
  });
  if (!result.ok) {
    const status = result.code === "unknown-agent" ? 404 : 503;
    sendJson(res, status, {
      error: { message: result.message, type: "invalid_request_error" },
    });
    return true;
  }
  sendJson(res, 200, {
    manifest: result.manifest,
    revision: result.revision,
  });
  return true;
}
