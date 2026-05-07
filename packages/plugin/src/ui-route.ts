import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendJson, sendMethodNotAllowed } from "./http-helpers.js";

export const UI_ROUTE_PATH = "/sprite-core/ui";

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// UI bundle ships at `<plugin-root>/ui-dist/`. The plugin is consumed in two
// layouts:
//   1. Source / workspace:  src/ui-route.ts sits next to ../ui-dist/
//   2. Bundled (tsdown):    index.js is the whole plugin, with ui-dist/
//                           as a sibling at the same level
// We accept either — probe both candidates and pick the one that exists.
import fsSync from "node:fs";

function resolveUiDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "ui-dist"),
    path.resolve(here, "ui-dist"),
    path.resolve(here, "..", "..", "ui-dist"),
    path.resolve(here, "..", "..", "..", "ui-dist"),
  ];
  for (const c of candidates) {
    if (fsSync.existsSync(path.join(c, "index.html"))) {
      return c;
    }
  }
  // Fall back to the source-layout path; the route handler will emit a 503
  // pointing at the build step if the bundle really isn't there.
  return candidates[0] ?? path.resolve(here, "..", "ui-dist");
}

const UI_DIST_DIR = resolveUiDistDir();

type ValidatedPath =
  | { ok: true; absPath: string; stat: { size: number; mtimeMs: number } }
  | { ok: false; status: number; message: string };

async function resolveRequestedFile(relPath: string): Promise<ValidatedPath> {
  const safe = relPath.replace(/^\/+/, "");
  if (safe.includes("\0")) {
    return { ok: false, status: 400, message: "invalid path" };
  }
  const absPath = path.resolve(UI_DIST_DIR, safe);
  const rel = path.relative(UI_DIST_DIR, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, status: 403, message: "path traversal rejected" };
  }
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      return { ok: false, status: 404, message: "not a file" };
    }
    return { ok: true, absPath, stat: { size: stat.size, mtimeMs: stat.mtimeMs } };
  } catch {
    return { ok: false, status: 404, message: "not found" };
  }
}

function buildEtag(stat: { size: number; mtimeMs: number }): string {
  return `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
}

function isHashedAsset(relPath: string): boolean {
  // Vite emits hashed filenames under /assets/ — cache those for a year.
  // index.html and anything unhashed gets a no-cache policy.
  return relPath.startsWith("assets/") || /[-.][0-9a-f]{8,}\.[a-z0-9]+$/i.test(relPath);
}

/**
 * `GET /sprite-core/ui[/path]` — serves the built UI bundle from
 * `packages/plugin/ui-dist/`. Unknown paths fall back to `index.html` so
 * client-side routing (if we add it later) works. Returns 404 when the
 * bundle hasn't been built yet — the error message points at the build step.
 *
 * Registered as a prefix route with `auth: "plugin"` — the static HTML +
 * JS bundle must be servable to a fresh browser so the SPA can bootstrap.
 * The SPA then makes same-origin API calls to `/sprite-core/*` endpoints
 * that stay gateway-gated. Registering this route with `auth: "gateway"`
 * would 401 the HTML shell itself and block the bundle from loading.
 */
export async function handleUiRequest(
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
  if (url.pathname !== UI_ROUTE_PATH && !url.pathname.startsWith(`${UI_ROUTE_PATH}/`)) {
    return false;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }

  // Strip the route prefix; treat the rest as a path into ui-dist.
  const afterPrefix = url.pathname.slice(UI_ROUTE_PATH.length).replace(/^\//, "");
  const relPath = afterPrefix || "index.html";

  let validated = await resolveRequestedFile(relPath);
  // SPA fallback: any unknown path that doesn't have a file extension gets
  // index.html so client-side routing can handle it. Paths with extensions
  // get a real 404 — a missing `app.123.js` is not an SPA route.
  if (!validated.ok && validated.status === 404 && !path.extname(relPath)) {
    validated = await resolveRequestedFile("index.html");
  }

  if (!validated.ok) {
    // If index.html itself is missing, the bundle hasn't been built.
    if (relPath === "index.html" || (!path.extname(relPath) && validated.status === 404)) {
      sendJson(res, 503, {
        error: {
          message:
            "SpriteCore UI bundle not built. Run `pnpm --filter @tylerwarburton/sprite-core-ui build`.",
          type: "invalid_request_error",
        },
      });
      return true;
    }
    sendJson(res, validated.status, {
      error: { message: validated.message, type: "invalid_request_error" },
    });
    return true;
  }

  const ext = path.extname(validated.absPath).toLowerCase();
  const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";
  const etag = buildEtag(validated.stat);

  if (isHashedAsset(relPath)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "no-cache");
  }
  res.setHeader("ETag", etag);

  if (req.headers["if-none-match"] === etag) {
    res.statusCode = 304;
    res.end();
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", String(validated.stat.size));

  if (req.method === "HEAD") {
    res.end();
    return true;
  }

  const stream = createReadStream(validated.absPath);
  stream.once("error", () => {
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: { message: "read error", type: "invalid_request_error" },
      });
      return;
    }
    res.destroy();
  });
  stream.pipe(res);
  return true;
}
