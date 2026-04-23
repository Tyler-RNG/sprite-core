import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, sendMethodNotAllowed } from "./http-helpers.js";
import { resolveElevenLabsApiKey } from "./provider-auth.js";
import type { SpriteCoreStreamSttConfig } from "./types.js";

export const STT_ROUTE_PATH = "/stream/stt";

export type SttRouteOptions = {
  config: SpriteCoreStreamSttConfig;
  /**
   * Optional override for the upstream fetcher. Primarily for tests.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional override for resolving the provider API key.
   * Primarily for tests that want to bypass the secret runtime.
   */
  resolveApiKey?: () => Promise<string | undefined>;
};

/**
 * Audio MIME allowlist. Matches ElevenLabs' accepted upload formats plus the
 * `audio/pcm;rate=N` variant emitted by Android's `AudioRecord` default.
 * Comparison is against the raw Content-Type header with parameters stripped
 * (so `audio/pcm;rate=16000` matches `audio/pcm`).
 */
const ALLOWED_AUDIO_PREFIXES = [
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "audio/mpeg",
  "audio/pcm",
] as const;

function isAllowedAudioContentType(contentType: string | undefined): boolean {
  if (!contentType || typeof contentType !== "string") {
    return false;
  }
  const base = contentType.split(";")[0].trim().toLowerCase();
  return ALLOWED_AUDIO_PREFIXES.includes(base as (typeof ALLOWED_AUDIO_PREFIXES)[number]);
}

async function resolveProviderApiKey(opts: SttRouteOptions): Promise<string | undefined> {
  if (opts.resolveApiKey) {
    return opts.resolveApiKey();
  }
  return resolveElevenLabsApiKey({
    apiKey: opts.config.apiKey,
    configPath: "plugins.entries.sprite-core.config.streamStt.apiKey",
  });
}

/**
 * Build the static bytes that precede and follow the audio payload in a
 * manually-framed multipart/form-data body. Returns the preamble (text fields
 * + file-part header) and trailer (boundary close) as UTF-8 byte buffers.
 */
function buildMultipartFrame(params: {
  boundary: string;
  model: string;
  language?: string;
  tagAudioEvents?: boolean;
  diarize?: boolean;
  numSpeakers?: number;
  audioContentType: string;
}): { preamble: Uint8Array; trailer: Uint8Array } {
  const crlf = "\r\n";
  const encoder = new TextEncoder();

  const fieldPart = (name: string, value: string): string =>
    `--${params.boundary}${crlf}` +
    `Content-Disposition: form-data; name="${name}"${crlf}${crlf}` +
    `${value}${crlf}`;

  let fields = fieldPart("model_id", params.model);
  if (params.language) {
    fields += fieldPart("language_code", params.language);
  }
  if (params.tagAudioEvents !== undefined) {
    fields += fieldPart("tag_audio_events", String(params.tagAudioEvents));
  }
  if (params.diarize !== undefined) {
    fields += fieldPart("diarize", String(params.diarize));
  }
  if (params.numSpeakers !== undefined) {
    fields += fieldPart("num_speakers", String(params.numSpeakers));
  }

  const filePartHeader =
    `--${params.boundary}${crlf}` +
    `Content-Disposition: form-data; name="file"; filename="audio"${crlf}` +
    `Content-Type: ${params.audioContentType}${crlf}${crlf}`;

  const trailer = `${crlf}--${params.boundary}--${crlf}`;

  return {
    preamble: encoder.encode(fields + filePartHeader),
    trailer: encoder.encode(trailer),
  };
}

function parseOptionalBooleanParam(value: string | null): boolean | undefined {
  if (value === null) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return undefined;
}

function parseOptionalIntParam(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * HTTP handler for `POST /stream/stt`. Registered with `auth: "gateway"` —
 * the plugin HTTP dispatcher enforces gateway auth before this handler runs.
 *
 * The STT proxy always requires auth because it costs money; there is no
 * `publicAssets`-style escape hatch (parallel to the TTS proxy).
 */
export async function handleSttRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: SttRouteOptions,
): Promise<boolean> {
  try {
    return await handleSttRequestInner(req, res, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: {
          message: "Internal server error",
          type: "internal_error",
          detail: message.slice(0, 200),
        },
      });
    } else {
      res.destroy();
    }
    return true;
  }
}

async function handleSttRequestInner(
  req: IncomingMessage,
  res: ServerResponse,
  opts: SttRouteOptions,
): Promise<boolean> {
  if (opts.config.enabled !== true) {
    return false;
  }
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
  if (url.pathname !== STT_ROUTE_PATH && url.pathname !== "/stt") {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  if (opts.config.provider !== "elevenlabs") {
    sendJson(res, 503, {
      error: { message: "STT provider not configured", type: "unavailable" },
    });
    return true;
  }

  const apiKey = await resolveProviderApiKey(opts);
  if (!apiKey) {
    sendJson(res, 503, {
      error: { message: "STT API key not available", type: "unavailable" },
    });
    return true;
  }

  const contentType = req.headers["content-type"];
  if (!isAllowedAudioContentType(contentType)) {
    sendJson(res, 400, {
      error: {
        message: `Unsupported Content-Type: ${contentType ?? "(missing)"}`,
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const contentLengthRaw = req.headers["content-length"];
  const contentLength =
    typeof contentLengthRaw === "string" ? Number.parseInt(contentLengthRaw, 10) : NaN;
  if (Number.isFinite(contentLength) && contentLength === 0) {
    sendJson(res, 400, {
      error: { message: "Missing audio body", type: "invalid_request_error" },
    });
    return true;
  }

  const maxBodyBytes = opts.config.maxBodyBytes;
  if (
    typeof maxBodyBytes === "number" &&
    maxBodyBytes > 0 &&
    Number.isFinite(contentLength) &&
    contentLength > maxBodyBytes
  ) {
    sendJson(res, 413, {
      error: { message: "Audio too large", type: "invalid_request_error" },
    });
    return true;
  }

  const defaultModel =
    (typeof opts.config.defaultModel === "string" && opts.config.defaultModel.trim()) ||
    "scribe_v1";
  const model = url.searchParams.get("model")?.trim() || defaultModel;
  const language = url.searchParams.get("language")?.trim() || undefined;
  const tagAudioEvents = parseOptionalBooleanParam(url.searchParams.get("tag_audio_events"));
  const diarize = parseOptionalBooleanParam(url.searchParams.get("diarize"));
  const numSpeakers = parseOptionalIntParam(url.searchParams.get("num_speakers"));

  const boundary = `----openclaw-stt-${randomUUID()}`;
  const { preamble, trailer } = buildMultipartFrame({
    boundary,
    model,
    language,
    tagAudioEvents,
    diarize,
    numSpeakers,
    audioContentType: contentType as string,
  });

  // Manually framed multipart body. Wrapping Node's IncomingMessage in a Web
  // ReadableStream lets us pipe audio bytes through to ElevenLabs without
  // buffering — the preamble is enqueued first, then each inbound chunk, then
  // the trailer. `duplex: "half"` is required when fetch body is a stream.
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(preamble);
        for await (const chunk of req as AsyncIterable<Buffer>) {
          controller.enqueue(chunk);
        }
        controller.enqueue(trailer);
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const fetchImpl = opts.fetchImpl ?? fetch;

  let upstream: Response;
  try {
    upstream = await fetchImpl("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: body as unknown as BodyInit,
      // @ts-expect-error — `duplex` is part of the fetch spec for streaming
      // request bodies but not yet reflected in lib.dom's RequestInit.
      duplex: "half",
    });
  } catch {
    sendJson(res, 502, {
      error: { message: "Failed to reach STT provider", type: "upstream_error" },
    });
    return true;
  }

  if (upstream.status === 429) {
    sendJson(res, 429, {
      error: { message: "Rate limited by upstream STT provider", type: "rate_limited" },
    });
    return true;
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    sendJson(res, 502, {
      error: {
        message: `Upstream STT error: ${upstream.status}`,
        type: "upstream_error",
        detail: detail.slice(0, 200),
      },
    });
    return true;
  }

  const responseContentType = upstream.headers.get("content-type") ?? "application/json";
  res.statusCode = 200;
  res.setHeader("Content-Type", responseContentType);
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-store");

  const upstreamBody = upstream.body;
  if (!upstreamBody) {
    res.end();
    return true;
  }

  const reader = upstreamBody.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      if (!res.write(chunk.value)) {
        await new Promise<void>((resolve) => res.once("drain", () => resolve()));
      }
    }
    res.end();
  } catch {
    res.destroy();
  }
  return true;
}
