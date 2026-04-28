import { authHeader } from "./auth.js";
import type {
  AgentEntry,
  AgentsResponse,
  EmotionEntry,
  LoopMode,
  PixellabCharactersResponse,
  PixellabHealth,
  PixellabJobEntry,
  PixellabLink,
} from "./types.js";

export type AtlasAnimationPatch = {
  rename?: string;
  fps?: number;
  loop?: LoopMode;
  /** `false` clears the flag; `true` sets it. */
  holdLastFrame?: boolean;
  /** `null` clears; positive integer sets. */
  iterations?: number | null;
};

// The UI is served from the same origin as the plugin routes, so relative
// paths "just work" under `/sprite-core/ui/`. In Vite dev the config proxies
// `/sprite-core/*` to a gateway URL, also matching this base.
const BASE = "/sprite-core";

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = JSON.parse(text);
      if (body?.error?.message) {
        message = body.error.message;
      }
    } catch {
      if (text) {
        message = text;
      }
    }
    throw new Error(message);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export async function getAgents(signal?: AbortSignal): Promise<AgentsResponse> {
  const res = await fetch(`${BASE}/agents`, {
    signal,
    credentials: "same-origin",
    headers: { ...authHeader() },
  });
  return parseJson<AgentsResponse>(res);
}

export async function putAgent(agentId: string, entry: AgentEntry): Promise<void> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(entry),
  });
  await parseJson<{ ok: true }>(res);
}

export async function putEmotion(
  agentId: string,
  state: string,
  entry: EmotionEntry,
): Promise<void> {
  const res = await fetch(
    `${BASE}/agents/${encodeURIComponent(agentId)}/emotions/${encodeURIComponent(state)}`,
    {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(entry),
    },
  );
  await parseJson<{ ok: true }>(res);
}

export async function patchAtlasAnimation(
  agentId: string,
  animation: string,
  patch: AtlasAnimationPatch,
): Promise<void> {
  const res = await fetch(
    `${BASE}/agents/${encodeURIComponent(agentId)}/atlas/animations/${encodeURIComponent(animation)}`,
    {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(patch),
    },
  );
  await parseJson<{ ok: true }>(res);
}

export async function deleteAtlasAnimation(
  agentId: string,
  animation: string,
): Promise<void> {
  const res = await fetch(
    `${BASE}/agents/${encodeURIComponent(agentId)}/atlas/animations/${encodeURIComponent(animation)}`,
    {
      method: "DELETE",
      credentials: "same-origin",
      headers: { ...authHeader() },
    },
  );
  await parseJson<{ ok: true }>(res);
}

// ----- pixellab.ai bridge -----

export async function getPixellabHealth(signal?: AbortSignal): Promise<PixellabHealth> {
  const res = await fetch(`${BASE}/pixellab/health`, {
    signal,
    credentials: "same-origin",
    headers: { ...authHeader() },
  });
  return parseJson<PixellabHealth>(res);
}

export async function getPixellabCharacters(
  signal?: AbortSignal,
): Promise<PixellabCharactersResponse> {
  const res = await fetch(`${BASE}/pixellab/characters`, {
    signal,
    credentials: "same-origin",
    headers: { ...authHeader() },
  });
  return parseJson<PixellabCharactersResponse>(res);
}

export async function putPixellabLink(
  agentId: string,
  link: PixellabLink,
): Promise<void> {
  const res = await fetch(
    `${BASE}/agents/${encodeURIComponent(agentId)}/pixellab-link`,
    {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(link),
    },
  );
  await parseJson<{ ok: true }>(res);
}

export async function deletePixellabLink(agentId: string): Promise<void> {
  const res = await fetch(
    `${BASE}/agents/${encodeURIComponent(agentId)}/pixellab-link`,
    {
      method: "DELETE",
      credentials: "same-origin",
      headers: { ...authHeader() },
    },
  );
  await parseJson<{ ok: true }>(res);
}

export async function getPixellabJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<{ job: PixellabJobEntry }> {
  const res = await fetch(`${BASE}/pixellab/jobs/${encodeURIComponent(jobId)}`, {
    signal,
    credentials: "same-origin",
    headers: { ...authHeader() },
  });
  return parseJson<{ job: PixellabJobEntry }>(res);
}

export async function getPixellabJobs(
  signal?: AbortSignal,
): Promise<{ jobs: PixellabJobEntry[] }> {
  const res = await fetch(`${BASE}/pixellab/jobs`, {
    signal,
    credentials: "same-origin",
    headers: { ...authHeader() },
  });
  return parseJson<{ jobs: PixellabJobEntry[] }>(res);
}

export type PixellabExportResult = {
  agentId: string;
  characterId: string;
  atlasPath: string;
  manifestPath: string;
  animations: Array<{
    name: string;
    description: string;
    frameCount: number;
    fps: number;
    loop: "infinite" | "once";
    holdLastFrame: boolean;
  }>;
  defaultState: string;
  exportedAt: number;
  warning?: string;
};

export async function runPixellabExport(
  agentId: string,
  characterId?: string,
): Promise<PixellabExportResult> {
  const res = await fetch(
    `${BASE}/agents/${encodeURIComponent(agentId)}/pixellab-export`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(characterId ? { characterId } : {}),
    },
  );
  return parseJson<PixellabExportResult>(res);
}
