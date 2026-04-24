import { authHeader } from "./auth.js";
import type { AgentEntry, AgentsResponse, EmotionEntry } from "./types.js";

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
