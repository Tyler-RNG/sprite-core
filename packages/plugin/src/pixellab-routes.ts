import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { sendJson, sendMethodNotAllowed } from "./http-helpers.js";
import { updateSpriteCoreConfig } from "./config-writes.js";
import { resolvePixellabApiKey } from "./pixellab-auth.js";
import { resolveElevenLabsApiKey } from "./provider-auth.js";
import {
  PIXELLAB_API_BASE,
  PixellabBridge,
  PixellabError,
} from "./pixellab-bridge.js";
import type { JobOp } from "./pixellab-bridge.js";
import { runExport } from "./pixellab-export-lib.js";
import { validatePixellabLink } from "./validation.js";
import type {
  SpriteCoreAssetsConfig,
  SpriteCoreConfig,
  SpriteCorePixellabLink,
} from "./types.js";

export const PIXELLAB_ROUTE_PREFIX = "/sprite-core/pixellab/";
export const PIXELLAB_AGENT_LINK_SUFFIX = "/pixellab-link";
export const PIXELLAB_AGENT_EXPORT_SUFFIX = "/pixellab-export";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
const MAX_BODY_BYTES = 64 * 1024;

export type PixellabRouteOptions = {
  bridge: PixellabBridge;
  readPluginConfig: () => SpriteCoreConfig | undefined;
};

/**
 * Routes:
 *   GET  /sprite-core/pixellab/health
 *   GET  /sprite-core/pixellab/voices         (proxies ElevenLabs)
 *   GET  /sprite-core/pixellab/characters
 *   GET  /sprite-core/pixellab/characters/:id
 *   GET  /sprite-core/pixellab/characters/:id/animations
 *   POST /sprite-core/pixellab/characters             (create + queue)
 *   POST /sprite-core/pixellab/characters/:id/animate (animate + queue)
 *   GET  /sprite-core/pixellab/jobs
 *   GET  /sprite-core/pixellab/jobs/:id
 *
 * Returns `false` if the path didn't match (so the dispatcher can fall
 * through), `true` once any response has been sent.
 */
export async function handlePixellabRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: PixellabRouteOptions,
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw) return false;
  let url: URL;
  try {
    url = new URL(urlRaw, "http://localhost");
  } catch {
    return false;
  }
  if (!url.pathname.startsWith(PIXELLAB_ROUTE_PREFIX)) return false;
  const tail = url.pathname.slice(PIXELLAB_ROUTE_PREFIX.length);

  // /sprite-core/pixellab/health
  if (tail === "health") {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }
    const cfg = opts.readPluginConfig();
    const apiKey = await resolvePixellabApiKey({
      apiKey: cfg?.pixellab?.apiKey,
      configPath: "plugins.entries.sprite-core.config.pixellab.apiKey",
    });
    sendJson(res, 200, {
      configured: typeof apiKey === "string" && apiKey.length > 0,
      apiBase: cfg?.pixellab?.apiBase ?? PIXELLAB_API_BASE,
      activeJobs: opts.bridge.activeCount,
      waitingJobs: opts.bridge.waitingCount,
    });
    return true;
  }

  // /sprite-core/pixellab/voices — ElevenLabs proxy.
  if (tail === "voices") {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }
    const cfg = opts.readPluginConfig();
    const apiKey = await resolveElevenLabsApiKey({
      apiKey: cfg?.streamTts?.apiKey,
      configPath: "plugins.entries.sprite-core.config.streamTts.apiKey",
    });
    if (!apiKey) {
      sendJson(res, 503, {
        error: {
          message:
            "ElevenLabs key not configured (sprite-core.streamTts.apiKey)",
          type: "configuration_error",
        },
      });
      return true;
    }
    try {
      const upstream = await fetch(`${ELEVENLABS_API_BASE}/voices`, {
        headers: { "xi-api-key": apiKey },
      });
      const body = await upstream.text();
      res.statusCode = upstream.status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(body);
    } catch (err) {
      sendJson(res, 502, {
        error: { message: errorMessage(err), type: "upstream_error" },
      });
    }
    return true;
  }

  // /sprite-core/pixellab/jobs[/(:id)?]
  if (tail === "jobs" || tail.startsWith("jobs/")) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }
    if (tail === "jobs") {
      sendJson(res, 200, { jobs: opts.bridge.listJobs() });
      return true;
    }
    const id = decodeURIComponent(tail.slice("jobs/".length));
    const job = opts.bridge.getJob(id);
    if (!job) {
      sendJson(res, 404, {
        error: { message: `unknown job: ${id}`, type: "invalid_request_error" },
      });
      return true;
    }
    sendJson(res, 200, { job });
    return true;
  }

  // /sprite-core/pixellab/characters[...]
  if (tail === "characters" || tail.startsWith("characters/")) {
    return await handleCharactersPath(req, res, tail, opts);
  }

  sendJson(res, 404, {
    error: { message: `unknown pixellab path: ${url.pathname}`, type: "invalid_request_error" },
  });
  return true;
}

async function handleCharactersPath(
  req: IncomingMessage,
  res: ServerResponse,
  tail: string,
  opts: PixellabRouteOptions,
): Promise<boolean> {
  const cfg = opts.readPluginConfig();
  const apiKey = await resolvePixellabApiKey({
    apiKey: cfg?.pixellab?.apiKey,
    configPath: "plugins.entries.sprite-core.config.pixellab.apiKey",
  });
  if (!apiKey) {
    sendJson(res, 503, {
      error: {
        message:
          "PixelLab key not configured (sprite-core.pixellab.apiKey or PIXELLAB_API_KEY env)",
        type: "configuration_error",
      },
    });
    return true;
  }

  // /sprite-core/pixellab/characters
  if (tail === "characters") {
    if (req.method === "GET") {
      try {
        const body = await opts.bridge.getJson<unknown>("/characters", apiKey);
        sendJson(res, 200, body);
      } catch (err) {
        respondPixellabError(res, err);
      }
      return true;
    }
    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, {
          error: { message: errorMessage(err), type: "invalid_request_error" },
        });
        return true;
      }
      const parsed = parseCreateBody(body);
      if ("error" in parsed) {
        sendJson(res, 400, {
          error: { message: parsed.error, type: "invalid_request_error" },
        });
        return true;
      }
      const job = await opts.bridge.startJob({
        apiKey,
        op: "create-character" satisfies JobOp,
        label: `create: ${parsed.name}`,
        submit: async (fetcher) => {
          const r = await fetcher("/create-character-with-4-directions", {
            method: "POST",
            body: JSON.stringify({
              description: parsed.fullDescription,
              image_size: { width: parsed.width, height: parsed.height },
            }),
          });
          if (!r.ok) {
            throw new Error(
              `pixellab create failed: HTTP ${r.status} ${r.statusText}`,
            );
          }
          const submitResult = (await r.json()) as {
            character_id?: string;
            background_job_id?: string;
          };
          if (!submitResult.background_job_id) {
            throw new Error("pixellab response missing background_job_id");
          }
          return {
            pixellabJobId: submitResult.background_job_id,
            submitResult,
          };
        },
      });
      sendJson(res, 202, { job });
      return true;
    }
    sendMethodNotAllowed(res, "GET, POST");
    return true;
  }

  // /sprite-core/pixellab/characters/:id[/...]
  const rest = tail.slice("characters/".length);
  const slashIdx = rest.indexOf("/");
  const charId = decodeURIComponent(slashIdx === -1 ? rest : rest.slice(0, slashIdx));
  const sub = slashIdx === -1 ? "" : rest.slice(slashIdx + 1);

  if (sub === "") {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }
    try {
      const body = await opts.bridge.getJson<unknown>(
        `/characters/${encodeURIComponent(charId)}`,
        apiKey,
      );
      sendJson(res, 200, body);
    } catch (err) {
      respondPixellabError(res, err);
    }
    return true;
  }

  if (sub === "animations") {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }
    try {
      const body = await opts.bridge.getJson<unknown>(
        `/characters/${encodeURIComponent(charId)}/animations`,
        apiKey,
      );
      sendJson(res, 200, body);
    } catch (err) {
      respondPixellabError(res, err);
    }
    return true;
  }

  if (sub === "animate") {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "POST");
      return true;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, {
        error: { message: errorMessage(err), type: "invalid_request_error" },
      });
      return true;
    }
    const parsed = parseAnimateBody(body);
    if ("error" in parsed) {
      sendJson(res, 400, {
        error: { message: parsed.error, type: "invalid_request_error" },
      });
      return true;
    }
    const job = await opts.bridge.startJob({
      apiKey,
      op: "animate-character" satisfies JobOp,
      label: `animate ${charId.slice(0, 8)}: ${parsed.emotion}`,
      submit: async (fetcher) => {
        const reqBody: Record<string, unknown> = {
          character_id: charId,
          action_description: parsed.prompt,
          mode: parsed.mode,
        };
        if (parsed.mode === "v3") {
          reqBody.frame_count = parsed.frameCount;
        }
        if (parsed.directions && parsed.directions.length > 0) {
          reqBody.directions = parsed.directions;
        }
        const r = await fetcher("/animate-character", {
          method: "POST",
          body: JSON.stringify(reqBody),
        });
        if (!r.ok) {
          throw new Error(
            `pixellab animate failed: HTTP ${r.status} ${r.statusText}`,
          );
        }
        const submitResult = (await r.json()) as {
          background_job_ids?: string[];
        };
        const ids = submitResult.background_job_ids ?? [];
        if (ids.length === 0) {
          throw new Error("pixellab animate response had no job ids");
        }
        // animate-character can return multiple ids (one per direction). The
        // bridge tracks one id per slot; we follow the first and let the
        // caller poll the others via /pixellab/jobs/:id/raw or by re-listing
        // animations after this slot completes. For 4-direction animates,
        // pixellab serializes them upstream.
        return {
          pixellabJobId: ids[0]!,
          submitResult,
        };
      },
    });
    sendJson(res, 202, { job });
    return true;
  }

  sendJson(res, 404, {
    error: {
      message: `unknown pixellab path: /sprite-core/pixellab/characters/${charId}/${sub}`,
      type: "invalid_request_error",
    },
  });
  return true;
}

export type PixellabExportRouteOptions = {
  readPluginConfig: () => SpriteCoreConfig | undefined;
};

/**
 * `POST /sprite-core/agents/:id/pixellab-export` — re-pulls the linked
 * pixellab character's bundle, repacks the atlas + manifest, and updates
 * `agent.pixellab.lastSyncedAt`. Body is optional; pass
 * `{ "characterId": "..." }` to override the agent's stored link (used for
 * first-time imports before the link is saved).
 *
 * Returns `false` if the path/method doesn't match so the dispatcher can
 * fall through. Returns `true` once the response has been sent (200 with
 * `{ atlasPath, manifestPath, animations, defaultState }` on success, or
 * an error payload).
 */
export async function handlePixellabExportRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: PixellabExportRouteOptions,
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw) return false;
  let url: URL;
  try {
    url = new URL(urlRaw, "http://localhost");
  } catch {
    return false;
  }
  const PREFIX = "/sprite-core/agents/";
  if (!url.pathname.startsWith(PREFIX)) return false;
  const tail = url.pathname.slice(PREFIX.length);
  if (!tail.endsWith(PIXELLAB_AGENT_EXPORT_SUFFIX)) return false;
  const agentId = decodeURIComponent(
    tail.slice(0, tail.length - PIXELLAB_AGENT_EXPORT_SUFFIX.length),
  );
  if (!agentId || agentId.includes("/")) return false;

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const cfg = opts.readPluginConfig();
  const apiKey = await resolvePixellabApiKey({
    apiKey: cfg?.pixellab?.apiKey,
    configPath: "plugins.entries.sprite-core.config.pixellab.apiKey",
  });
  if (!apiKey) {
    sendJson(res, 503, {
      error: {
        message:
          "PixelLab key not configured (sprite-core.pixellab.apiKey or PIXELLAB_API_KEY env)",
        type: "configuration_error",
      },
    });
    return true;
  }

  const agent = cfg?.agents?.[agentId];
  if (!agent) {
    sendJson(res, 404, {
      error: {
        message: `unknown agent: ${agentId}`,
        type: "invalid_request_error",
      },
    });
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, {
      error: { message: errorMessage(err), type: "invalid_request_error" },
    });
    return true;
  }
  const overrideCharacterId =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { characterId?: unknown }).characterId
      : undefined;
  const characterId =
    typeof overrideCharacterId === "string" && overrideCharacterId.trim()
      ? overrideCharacterId.trim()
      : agent.pixellab?.characterId;
  if (!characterId) {
    sendJson(res, 400, {
      error: {
        message: `agent "${agentId}" has no pixellab link; pass { characterId: "..." } in the body or PUT /pixellab-link first`,
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const assetsRoot = path.join(resolveAssetsDir(cfg?.assets), "avatars");
  try {
    const result = await runExport({
      characterId,
      agentId,
      assetsRoot,
      apiKey,
    });
    // Persist link + lastSyncedAt so the dashboard reflects the sync time.
    try {
      await updateSpriteCoreConfig((c) => {
        const agents = { ...c.agents };
        const a = agents[agentId];
        if (!a) return c;
        agents[agentId] = {
          ...a,
          pixellab: {
            characterId,
            lastSyncedAt: result.exportedAt,
          },
        };
        return { ...c, agents };
      });
    } catch (err) {
      // Surface the export result anyway — the atlas was rebuilt; the link
      // bookkeeping is best-effort.
      sendJson(res, 200, {
        ...result,
        warning: `link save failed: ${errorMessage(err)}`,
      });
      return true;
    }
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 502, {
      error: { message: errorMessage(err), type: "upstream_error" },
    });
  }
  return true;
}

function resolveAssetsDir(cfg: SpriteCoreAssetsConfig | undefined): string {
  const raw =
    typeof cfg?.assetsDir === "string" && cfg.assetsDir.trim().length > 0
      ? cfg.assetsDir.trim()
      : "./assets";
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(resolveStateDir(), raw);
}

/**
 * Handler for `PUT /sprite-core/agents/:id/pixellab-link` and `DELETE` of the
 * same. Returns `false` if the path/method doesn't match so the dispatcher
 * can fall through to the agent/emotion writer.
 */
export async function handlePixellabLinkRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw) return false;
  let url: URL;
  try {
    url = new URL(urlRaw, "http://localhost");
  } catch {
    return false;
  }
  const path = url.pathname;
  const PREFIX = "/sprite-core/agents/";
  if (!path.startsWith(PREFIX)) return false;
  const tail = path.slice(PREFIX.length);
  if (!tail.endsWith(PIXELLAB_AGENT_LINK_SUFFIX)) return false;
  const agentId = decodeURIComponent(
    tail.slice(0, tail.length - PIXELLAB_AGENT_LINK_SUFFIX.length),
  );
  if (!agentId || agentId.includes("/")) return false;

  if (req.method === "DELETE") {
    try {
      await updateSpriteCoreConfig((cfg) => {
        const agents = { ...cfg.agents };
        const agent = agents[agentId];
        if (!agent) {
          throw new Error(`unknown agent: ${agentId}`);
        }
        const next = { ...agent };
        delete next.pixellab;
        agents[agentId] = next;
        return { ...cfg, agents };
      });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      respondConfigError(res, err);
    }
    return true;
  }

  if (req.method !== "PUT") {
    sendMethodNotAllowed(res, "PUT, DELETE");
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, {
      error: { message: errorMessage(err), type: "invalid_request_error" },
    });
    return true;
  }
  const errors: string[] = [];
  const link = validatePixellabLink(body, "body", errors);
  if (!link) {
    sendJson(res, 400, {
      error: {
        message: errors.join("; ") || "invalid pixellab link",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  try {
    await updateSpriteCoreConfig((cfg) => {
      const agents = { ...cfg.agents };
      const agent = agents[agentId];
      if (!agent) {
        throw new Error(`unknown agent: ${agentId}`);
      }
      agents[agentId] = { ...agent, pixellab: link };
      return { ...cfg, agents };
    });
    sendJson(res, 200, { ok: true, link });
  } catch (err) {
    respondConfigError(res, err);
  }
  return true;
}

// ---- helpers ----

type ParsedCreateBody = {
  name: string;
  fullDescription: string;
  width: number;
  height: number;
};

function parseCreateBody(body: unknown): ParsedCreateBody | { error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "body: expected object" };
  }
  const obj = body as Record<string, unknown>;
  const name = typeof obj["name"] === "string" ? obj["name"].trim() : "";
  const description =
    typeof obj["description"] === "string" ? obj["description"].trim() : "";
  if (!name) return { error: "name: required" };
  if (!description) return { error: "description: required" };
  const widthRaw = obj["width"];
  const heightRaw = obj["height"];
  const width =
    typeof widthRaw === "number" && Number.isFinite(widthRaw) ? widthRaw : 96;
  const height =
    typeof heightRaw === "number" && Number.isFinite(heightRaw) ? heightRaw : 96;
  return {
    name,
    fullDescription: `${name}: ${description}`,
    width,
    height,
  };
}

type ParsedAnimateBody = {
  emotion: string;
  prompt: string;
  mode: "template" | "v3" | "pro";
  frameCount: number;
  directions?: string[];
};

function parseAnimateBody(body: unknown): ParsedAnimateBody | { error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "body: expected object" };
  }
  const obj = body as Record<string, unknown>;
  const emotion =
    typeof obj["emotion"] === "string" ? obj["emotion"].trim() : "";
  if (!emotion) return { error: "emotion: required" };
  const prompt =
    typeof obj["prompt"] === "string" && obj["prompt"].trim().length > 0
      ? obj["prompt"].trim()
      : `${emotion} expression`;
  const modeRaw = obj["mode"];
  const mode: ParsedAnimateBody["mode"] =
    modeRaw === "template" || modeRaw === "v3" || modeRaw === "pro" ? modeRaw : "v3";
  const frameCountRaw = obj["frameCount"];
  const frameCount =
    typeof frameCountRaw === "number" && Number.isFinite(frameCountRaw)
      ? clampInt(frameCountRaw, 4, 16)
      : 8;
  let directions: string[] | undefined;
  if (Array.isArray(obj["directions"])) {
    const arr = obj["directions"]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((s) => s.trim());
    if (arr.length > 0) directions = arr;
  }
  return { emotion, prompt, mode, frameCount, directions };
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
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
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

function respondPixellabError(res: ServerResponse, err: unknown): void {
  if (err instanceof PixellabError) {
    const status =
      err.code === "auth"
        ? 401
        : err.code === "not-found"
          ? 404
          : err.code === "rate-limited"
            ? 429
            : 502;
    sendJson(res, status, {
      error: { message: err.message, type: "upstream_error" },
    });
    return;
  }
  sendJson(res, 502, {
    error: { message: errorMessage(err), type: "upstream_error" },
  });
}

function respondConfigError(res: ServerResponse, err: unknown): void {
  const message = errorMessage(err);
  if (/unknown agent/i.test(message)) {
    sendJson(res, 404, {
      error: { message, type: "invalid_request_error" },
    });
    return;
  }
  sendJson(res, 500, {
    error: { message: `config write failed: ${message}`, type: "invalid_request_error" },
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Re-export so the type is available to any callers that only import this
 * module (avoids forcing them to also depend on `./types.js` for a single
 * struct).
 */
export type { SpriteCorePixellabLink };
