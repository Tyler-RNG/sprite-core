import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { handleSttRequest } from "./stt-route.js";

type MakeReqOpts = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  bodyChunks?: Buffer[];
};

function makeReq(opts: MakeReqOpts): IncomingMessage {
  const body = opts.bodyChunks ?? [];
  return {
    url: opts.url,
    method: opts.method ?? "POST",
    headers: opts.headers ?? {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of body) {
        yield chunk;
      }
    },
  } as unknown as IncomingMessage;
}

type FakeResponse = {
  statusCode: number;
  headers: Record<string, string | number>;
  body: string;
  ended: boolean;
  writes: Buffer[];
  setHeader: (name: string, value: string | number) => void;
  end: (chunk?: string) => void;
  write: (chunk: unknown) => boolean;
  once: (event: string, listener: () => void) => void;
  destroy: () => void;
  get headersSent(): boolean;
};

function makeRes(): FakeResponse {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    ended: false,
    writes: [],
    setHeader(name: string, value: string | number) {
      this.headers[name] = value;
    },
    end(chunk?: string) {
      if (chunk) {
        this.body += chunk;
      }
      this.ended = true;
    },
    write(chunk: unknown) {
      if (Buffer.isBuffer(chunk)) {
        this.writes.push(chunk);
      } else if (chunk instanceof Uint8Array) {
        this.writes.push(Buffer.from(chunk));
      }
      return true;
    },
    once() {},
    destroy() {},
    get headersSent() {
      return this.ended;
    },
  };
}

async function readReadableStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

const AUDIO_HEADERS = {
  "content-type": "audio/mp4",
  "content-length": "42",
};

const AUDIO_BODY = [Buffer.from([0, 1, 2, 3])];

describe("sprite-core stt-route", () => {
  it("returns false when disabled (route unmatched)", async () => {
    const res = makeRes();
    const handled = await handleSttRequest(
      makeReq({ url: "/stream/stt", headers: AUDIO_HEADERS, bodyChunks: AUDIO_BODY }),
      res as unknown as ServerResponse,
      { config: { enabled: false } },
    );
    expect(handled).toBe(false);
  });

  it("returns false for non-stt paths", async () => {
    const res = makeRes();
    const handled = await handleSttRequest(
      makeReq({ url: "/other", headers: AUDIO_HEADERS, bodyChunks: AUDIO_BODY }),
      res as unknown as ServerResponse,
      { config: { enabled: true, provider: "elevenlabs" } },
    );
    expect(handled).toBe(false);
  });

  it("accepts the /stt alias path", async () => {
    const res = makeRes();
    const fetchImpl = async () =>
      new Response(JSON.stringify({ text: "hi" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as unknown as Response;
    await handleSttRequest(
      makeReq({ url: "/stt", headers: AUDIO_HEADERS, bodyChunks: AUDIO_BODY }),
      res as unknown as ServerResponse,
      {
        config: { enabled: true, provider: "elevenlabs" },
        resolveApiKey: async () => "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res.statusCode).toBe(200);
  });

  it("405 on non-POST", async () => {
    const res = makeRes();
    await handleSttRequest(
      makeReq({ url: "/stream/stt", method: "GET", headers: AUDIO_HEADERS }),
      res as unknown as ServerResponse,
      { config: { enabled: true, provider: "elevenlabs" } },
    );
    expect(res.statusCode).toBe(405);
  });

  it("503 when provider not configured", async () => {
    const res = makeRes();
    await handleSttRequest(
      makeReq({ url: "/stream/stt", headers: AUDIO_HEADERS, bodyChunks: AUDIO_BODY }),
      res as unknown as ServerResponse,
      { config: { enabled: true } },
    );
    expect(res.statusCode).toBe(503);
  });

  it("503 when API key unavailable", async () => {
    const res = makeRes();
    await handleSttRequest(
      makeReq({ url: "/stream/stt", headers: AUDIO_HEADERS, bodyChunks: AUDIO_BODY }),
      res as unknown as ServerResponse,
      {
        config: { enabled: true, provider: "elevenlabs" },
        resolveApiKey: async () => undefined,
      },
    );
    expect(res.statusCode).toBe(503);
  });

  it("400 on unsupported Content-Type", async () => {
    const res = makeRes();
    await handleSttRequest(
      makeReq({
        url: "/stream/stt",
        headers: { "content-type": "text/plain", "content-length": "42" },
        bodyChunks: AUDIO_BODY,
      }),
      res as unknown as ServerResponse,
      {
        config: { enabled: true, provider: "elevenlabs" },
        resolveApiKey: async () => "k",
      },
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Unsupported Content-Type");
  });

  it("accepts audio/pcm with rate parameter (Android AudioRecord default)", async () => {
    const res = makeRes();
    const fetchImpl = async () =>
      new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as unknown as Response;
    await handleSttRequest(
      makeReq({
        url: "/stream/stt",
        headers: { "content-type": "audio/pcm;rate=16000", "content-length": "42" },
        bodyChunks: AUDIO_BODY,
      }),
      res as unknown as ServerResponse,
      {
        config: { enabled: true, provider: "elevenlabs" },
        resolveApiKey: async () => "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res.statusCode).toBe(200);
  });

  it("400 on empty body (content-length 0)", async () => {
    const res = makeRes();
    await handleSttRequest(
      makeReq({
        url: "/stream/stt",
        headers: { "content-type": "audio/mp4", "content-length": "0" },
      }),
      res as unknown as ServerResponse,
      {
        config: { enabled: true, provider: "elevenlabs" },
        resolveApiKey: async () => "k",
      },
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Missing audio body");
  });

  it("413 when content-length exceeds maxBodyBytes", async () => {
    const res = makeRes();
    await handleSttRequest(
      makeReq({
        url: "/stream/stt",
        headers: { "content-type": "audio/mp4", "content-length": "100" },
        bodyChunks: AUDIO_BODY,
      }),
      res as unknown as ServerResponse,
      {
        config: { enabled: true, provider: "elevenlabs", maxBodyBytes: 50 },
        resolveApiKey: async () => "k",
      },
    );
    expect(res.statusCode).toBe(413);
    expect(res.body).toContain("Audio too large");
  });

  it("forwards ElevenLabs 2xx response passthrough", async () => {
    const res = makeRes();
    const fakeJson = { language_code: "en", text: "hello", words: [] };
    const fetchImpl = async () =>
      new Response(JSON.stringify(fakeJson), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as unknown as Response;
    await handleSttRequest(
      makeReq({ url: "/stream/stt", headers: AUDIO_HEADERS, bodyChunks: AUDIO_BODY }),
      res as unknown as ServerResponse,
      {
        config: { enabled: true, provider: "elevenlabs" },
        resolveApiKey: async () => "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
    const responseBody = Buffer.concat(res.writes).toString("utf-8");
    expect(JSON.parse(responseBody)).toEqual(fakeJson);
  });

  it("maps upstream 429 to 429 rate_limited", async () => {
    const res = makeRes();
    const fetchImpl = async () => new Response("", { status: 429 }) as unknown as Response;
    await handleSttRequest(
      makeReq({ url: "/stream/stt", headers: AUDIO_HEADERS, bodyChunks: AUDIO_BODY }),
      res as unknown as ServerResponse,
      {
        config: { enabled: true, provider: "elevenlabs" },
        resolveApiKey: async () => "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res.statusCode).toBe(429);
    expect(res.body).toContain("rate_limited");
  });

  it("maps upstream 5xx to 502 with truncated detail", async () => {
    const res = makeRes();
    const longDetail = "x".repeat(500);
    const fetchImpl = async () =>
      new Response(longDetail, { status: 500 }) as unknown as Response;
    await handleSttRequest(
      makeReq({ url: "/stream/stt", headers: AUDIO_HEADERS, bodyChunks: AUDIO_BODY }),
      res as unknown as ServerResponse,
      {
        config: { enabled: true, provider: "elevenlabs" },
        resolveApiKey: async () => "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res.statusCode).toBe(502);
    const parsed = JSON.parse(res.body) as { error: { detail?: string; type?: string } };
    expect(parsed.error.type).toBe("upstream_error");
    expect(parsed.error.detail).toBeDefined();
    expect((parsed.error.detail ?? "").length).toBeLessThanOrEqual(200);
  });

  it("502 on fetch throwing (network failure)", async () => {
    const res = makeRes();
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    await handleSttRequest(
      makeReq({ url: "/stream/stt", headers: AUDIO_HEADERS, bodyChunks: AUDIO_BODY }),
      res as unknown as ServerResponse,
      {
        config: { enabled: true, provider: "elevenlabs" },
        resolveApiKey: async () => "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain("Failed to reach STT provider");
  });

  it("forwards model, language, tag_audio_events, diarize, num_speakers as multipart fields", async () => {
    const res = makeRes();
    let capturedBody: string | undefined;
    let capturedContentType: string | undefined;
    const fetchImpl = async (_url: unknown, init: unknown) => {
      const request = init as { body?: ReadableStream<Uint8Array>; headers?: Record<string, string> };
      if (request.body) {
        capturedBody = await readReadableStream(request.body);
      }
      capturedContentType = request.headers?.["Content-Type"];
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as unknown as Response;
    };
    await handleSttRequest(
      makeReq({
        url: "/stream/stt?model=scribe_v1&language=en&tag_audio_events=true&diarize=false&num_speakers=2",
        headers: AUDIO_HEADERS,
        bodyChunks: AUDIO_BODY,
      }),
      res as unknown as ServerResponse,
      {
        config: { enabled: true, provider: "elevenlabs" },
        resolveApiKey: async () => "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res.statusCode).toBe(200);
    expect(capturedContentType).toMatch(/^multipart\/form-data; boundary=----openclaw-stt-/);
    expect(capturedBody).toBeDefined();
    expect(capturedBody).toContain('name="model_id"\r\n\r\nscribe_v1');
    expect(capturedBody).toContain('name="language_code"\r\n\r\nen');
    expect(capturedBody).toContain('name="tag_audio_events"\r\n\r\ntrue');
    expect(capturedBody).toContain('name="diarize"\r\n\r\nfalse');
    expect(capturedBody).toContain('name="num_speakers"\r\n\r\n2');
    expect(capturedBody).toContain('name="file"; filename="audio"');
    expect(capturedBody).toContain("Content-Type: audio/mp4");
  });

  it("falls back to configured defaultModel when ?model= is absent", async () => {
    const res = makeRes();
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: unknown, init: unknown) => {
      const request = init as { body?: ReadableStream<Uint8Array> };
      if (request.body) {
        capturedBody = await readReadableStream(request.body);
      }
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as unknown as Response;
    };
    await handleSttRequest(
      makeReq({ url: "/stream/stt", headers: AUDIO_HEADERS, bodyChunks: AUDIO_BODY }),
      res as unknown as ServerResponse,
      {
        config: { enabled: true, provider: "elevenlabs", defaultModel: "scribe_v2" },
        resolveApiKey: async () => "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(capturedBody).toContain('name="model_id"\r\n\r\nscribe_v2');
  });

  it("omits optional query params from multipart when absent", async () => {
    const res = makeRes();
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: unknown, init: unknown) => {
      const request = init as { body?: ReadableStream<Uint8Array> };
      if (request.body) {
        capturedBody = await readReadableStream(request.body);
      }
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as unknown as Response;
    };
    await handleSttRequest(
      makeReq({ url: "/stream/stt", headers: AUDIO_HEADERS, bodyChunks: AUDIO_BODY }),
      res as unknown as ServerResponse,
      {
        config: { enabled: true, provider: "elevenlabs" },
        resolveApiKey: async () => "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(capturedBody).not.toContain('name="language_code"');
    expect(capturedBody).not.toContain('name="tag_audio_events"');
    expect(capturedBody).not.toContain('name="diarize"');
    expect(capturedBody).not.toContain('name="num_speakers"');
    // Still has model and file.
    expect(capturedBody).toContain('name="model_id"');
    expect(capturedBody).toContain('name="file"');
  });

  it("catches unexpected handler throws and emits a structured JSON 500", async () => {
    // Regression: the SecretRef `mode: "strict"` bug leaked through as
    // Node's default plaintext 500 because the throw escaped the handler.
    // The outer try/catch now converts any uncaught throw into a JSON error
    // envelope so clients get a diagnosable response shape.
    const res = makeRes();
    await handleSttRequest(
      makeReq({ url: "/stream/stt", headers: AUDIO_HEADERS, bodyChunks: AUDIO_BODY }),
      res as unknown as ServerResponse,
      {
        config: { enabled: true, provider: "elevenlabs" },
        resolveApiKey: async () => {
          throw new Error("simulated unexpected failure");
        },
      },
    );
    expect(res.statusCode).toBe(500);
    const parsed = JSON.parse(res.body) as {
      error: { type?: string; message?: string; detail?: string };
    };
    expect(parsed.error.type).toBe("internal_error");
    expect(parsed.error.message).toBe("Internal server error");
    expect(parsed.error.detail).toContain("simulated unexpected failure");
  });

  it("streams inbound audio bytes through into the multipart file part", async () => {
    const res = makeRes();
    let capturedBody: Uint8Array | undefined;
    const fetchImpl = async (_url: unknown, init: unknown) => {
      const request = init as { body?: ReadableStream<Uint8Array> };
      if (request.body) {
        const reader = request.body.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          chunks.push(value);
        }
        const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.length;
        }
        capturedBody = merged;
      }
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as unknown as Response;
    };
    const audioBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    await handleSttRequest(
      makeReq({
        url: "/stream/stt",
        headers: AUDIO_HEADERS,
        bodyChunks: [audioBytes],
      }),
      res as unknown as ServerResponse,
      {
        config: { enabled: true, provider: "elevenlabs" },
        resolveApiKey: async () => "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(capturedBody).toBeDefined();
    // The audio bytes should appear verbatim somewhere inside the multipart body.
    const asText = Buffer.from(capturedBody!).toString("latin1");
    expect(asText).toContain(audioBytes.toString("latin1"));
  });
});
