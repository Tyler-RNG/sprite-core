import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, sendMethodNotAllowed } from "./http-helpers.js";
import { updateSpriteCoreConfig } from "./config-writes.js";
import { validateAgentEntry, validateEmotionEntry } from "./validation.js";

export const AGENTS_WRITE_ROUTE_PREFIX = "/sprite-core/agents/";

const MAX_BODY_BYTES = 64 * 1024;

// Parse `/sprite-core/agents/:id` and `/sprite-core/agents/:id/emotions/:state`.
type ParsedTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "emotion"; agentId: string; state: string }
  | null;

function parseTarget(pathname: string): ParsedTarget {
  if (!pathname.startsWith(AGENTS_WRITE_ROUTE_PREFIX)) {
    return null;
  }
  const tail = pathname.slice(AGENTS_WRITE_ROUTE_PREFIX.length);
  if (!tail) {
    return null;
  }

  const parts = tail.split("/");
  if (parts.length === 1) {
    const agentId = safeDecode(parts[0]);
    if (!agentId) {
      return null;
    }
    return { kind: "agent", agentId };
  }
  if (parts.length === 3 && parts[1] === "emotions") {
    const agentId = safeDecode(parts[0]);
    const state = safeDecode(parts[2]);
    if (!agentId || !state) {
      return null;
    }
    return { kind: "emotion", agentId, state };
  }
  return null;
}

function safeDecode(seg: string | undefined): string | null {
  if (!seg) {
    return null;
  }
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

/**
 * Handles `PUT /sprite-core/agents/:id` and
 * `PUT /sprite-core/agents/:id/emotions/:state`. Returns `true` if the
 * request was handled (including error responses), `false` if the path
 * didn't match so the dispatcher can try the next handler.
 *
 * Registered with `auth: "gateway"` so the plugin HTTP dispatcher enforces
 * gateway auth before this handler runs.
 */
export async function handleAgentsWriteRequest(
  req: IncomingMessage,
  res: ServerResponse,
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
  const target = parseTarget(url.pathname);
  if (!target) {
    return false;
  }

  if (req.method !== "PUT") {
    sendMethodNotAllowed(res, "PUT");
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, {
        error: { message: `body exceeds ${MAX_BODY_BYTES} bytes`, type: "invalid_request_error" },
      });
      return true;
    }
    sendJson(res, 400, {
      error: { message: "invalid JSON body", type: "invalid_request_error" },
    });
    return true;
  }

  if (target.kind === "emotion") {
    const parsed = validateEmotionEntry(body);
    if (!parsed.ok) {
      sendJson(res, 400, {
        error: { message: parsed.errors.join("; "), type: "invalid_request_error" },
      });
      return true;
    }
    try {
      await updateSpriteCoreConfig((cfg) => {
        const agents = { ...cfg.agents };
        const agent = agents[target.agentId];
        if (!agent) {
          throw new AgentNotFoundError(target.agentId);
        }
        agents[target.agentId] = {
          ...agent,
          emotions: {
            ...agent.emotions,
            [target.state]: parsed.value,
          },
        };
        return { ...cfg, agents };
      });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      respondMutationError(res, err);
    }
    return true;
  }

  // target.kind === "agent"
  const parsed = validateAgentEntry(body);
  if (!parsed.ok) {
    sendJson(res, 400, {
      error: { message: parsed.errors.join("; "), type: "invalid_request_error" },
    });
    return true;
  }
  try {
    await updateSpriteCoreConfig((cfg) => {
      const agents = { ...cfg.agents };
      agents[target.agentId] = parsed.value;
      return { ...cfg, agents };
    });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    respondMutationError(res, err);
  }
  return true;
}

class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`unknown agent: ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}

function respondMutationError(res: ServerResponse, err: unknown): void {
  if (err instanceof AgentNotFoundError) {
    sendJson(res, 404, {
      error: { message: err.message, type: "invalid_request_error" },
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, {
    error: { message: `config write failed: ${message}`, type: "invalid_request_error" },
  });
}
