import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, sendMethodNotAllowed } from "./http-helpers.js";
import {
  applyAtlasMutation,
  deleteAnimation,
  patchAnimation,
  resolveAtlasManifestPath,
  type AtlasMutationErr,
  type PatchAnimationInput,
} from "./atlas-write.js";
import type { SpriteCoreAvatarLoopMode, SpriteCoreConfig } from "./types.js";

export const ATLAS_WRITE_ROUTE_PREFIX = "/sprite-core/agents/";

const MAX_BODY_BYTES = 32 * 1024;

type ParsedAtlasTarget = {
  agentId: string;
  animation: string;
};

/**
 * Parse `/sprite-core/agents/:id/atlas/animations/:name`. Distinct from the
 * agent/emotion writer since the path shape is `/atlas/animations/...`,
 * which the agent writer's parser explicitly rejects.
 */
function parseAtlasTarget(pathname: string): ParsedAtlasTarget | null {
  if (!pathname.startsWith(ATLAS_WRITE_ROUTE_PREFIX)) {
    return null;
  }
  const tail = pathname.slice(ATLAS_WRITE_ROUTE_PREFIX.length);
  const parts = tail.split("/");
  // shape: [":id", "atlas", "animations", ":name"]
  if (parts.length !== 4 || parts[1] !== "atlas" || parts[2] !== "animations") {
    return null;
  }
  const agentId = safeDecode(parts[0]);
  const animation = safeDecode(parts[3]);
  if (!agentId || !animation) {
    return null;
  }
  return { agentId, animation };
}

function safeDecode(seg: string | undefined): string | null {
  if (!seg) return null;
  try {
    const d = decodeURIComponent(seg);
    if (!d || d.includes("/") || d.includes("\0")) {
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

class BodyTooLargeError extends Error {
  constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}
class JsonParseError extends Error {
  constructor() {
    super("invalid JSON");
    this.name = "JsonParseError";
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new JsonParseError());
      }
    });
    req.on("error", (err) => reject(err));
  });
}

const VALID_LOOP = new Set<SpriteCoreAvatarLoopMode>([
  "infinite",
  "once",
  "ping-pong",
]);

function parsePatchBody(body: unknown): PatchAnimationInput | { error: string } {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    return { error: "body: expected object" };
  }
  const obj = body as Record<string, unknown>;
  const out: PatchAnimationInput = {};
  if ("rename" in obj) {
    if (typeof obj["rename"] !== "string") {
      return { error: "rename: expected string" };
    }
    out.rename = obj["rename"];
  }
  if ("fps" in obj) {
    if (typeof obj["fps"] !== "number") {
      return { error: "fps: expected number" };
    }
    out.fps = obj["fps"];
  }
  if ("loop" in obj) {
    const v = obj["loop"];
    if (typeof v !== "string" || !VALID_LOOP.has(v as SpriteCoreAvatarLoopMode)) {
      return { error: 'loop: expected "infinite" | "once" | "ping-pong"' };
    }
    out.loop = v as SpriteCoreAvatarLoopMode;
  }
  if ("holdLastFrame" in obj) {
    if (typeof obj["holdLastFrame"] !== "boolean") {
      return { error: "holdLastFrame: expected boolean" };
    }
    out.holdLastFrame = obj["holdLastFrame"];
  }
  if ("iterations" in obj) {
    const v = obj["iterations"];
    if (v !== null && typeof v !== "number") {
      return { error: "iterations: expected number or null" };
    }
    out.iterations = v as number | null;
  }
  return out;
}

export type AtlasWriteHandlerOptions = {
  readPluginConfig: () => SpriteCoreConfig | undefined;
};

/**
 * Handles `PATCH /sprite-core/agents/:id/atlas/animations/:name` and
 * `DELETE /sprite-core/agents/:id/atlas/animations/:name`. Returns `true`
 * when the request matched (including error responses), `false` to fall
 * through to the next handler.
 */
export async function handleAtlasWriteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AtlasWriteHandlerOptions,
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw) return false;
  let url: URL;
  try {
    url = new URL(urlRaw, "http://localhost");
  } catch {
    return false;
  }
  const target = parseAtlasTarget(url.pathname);
  if (!target) return false;

  const method = req.method ?? "";
  if (method !== "PATCH" && method !== "DELETE") {
    sendMethodNotAllowed(res, "PATCH, DELETE");
    return true;
  }

  const cfg = opts.readPluginConfig();
  const resolved = resolveAtlasManifestPath({
    pluginConfig: cfg,
    agentId: target.agentId,
  });
  if (!resolved.ok) {
    sendJson(res, resolved.code === "unknown-agent" ? 404 : 400, {
      error: { message: resolved.message, type: "invalid_request_error" },
    });
    return true;
  }

  if (method === "DELETE") {
    const result = await applyAtlasMutation(resolved.paths, (m) =>
      deleteAnimation(m, target.animation),
    );
    return respond(res, result);
  }

  // PATCH
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, {
        error: {
          message: `body exceeds ${MAX_BODY_BYTES} bytes`,
          type: "invalid_request_error",
        },
      });
      return true;
    }
    sendJson(res, 400, {
      error: { message: "invalid JSON body", type: "invalid_request_error" },
    });
    return true;
  }
  const parsed = parsePatchBody(body);
  if ("error" in parsed) {
    sendJson(res, 400, {
      error: { message: parsed.error, type: "invalid_request_error" },
    });
    return true;
  }
  const result = await applyAtlasMutation(resolved.paths, (m) =>
    patchAnimation(m, target.animation, parsed),
  );
  return respond(res, result);
}

function respond(
  res: ServerResponse,
  result: Awaited<ReturnType<typeof applyAtlasMutation>>,
): true {
  if (result.ok) {
    sendJson(res, 200, { ok: true });
    return true;
  }
  const status = mapErrorStatus(result);
  sendJson(res, status, {
    error: { message: result.message, type: "invalid_request_error" },
  });
  return true;
}

function mapErrorStatus(result: AtlasMutationErr | { code: string }): number {
  switch (result.code) {
    case "unknown-animation":
      return 404;
    case "name-collision":
      return 409;
    case "phased-not-editable":
    case "invalid-input":
      return 400;
    case "atlas-unreadable":
      return 500;
    case "atlas-unwritable":
      return 500;
    default:
      return 500;
  }
}
