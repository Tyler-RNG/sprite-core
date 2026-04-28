import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAgents } from "./api/client.js";
import {
  clearOverrideToken,
  MissingAuthTokenError,
  readOverrideToken,
  setOverrideToken,
} from "./api/auth.js";
import { EmotionEditor } from "./components/EmotionEditor.js";
import { AnimationStudio } from "./components/AnimationStudio.js";
import { AvatarPreview } from "./preview/AvatarPreview.js";
import { useOpenclawTheme, type OpenclawThemeState } from "./use-openclaw-theme.js";
import type { AgentEntry } from "./api/types.js";

export function App(): JSX.Element {
  const theme = useOpenclawTheme();
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: ({ signal }) => getAgents(signal),
    retry: false,
  });
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const agents = agentsQuery.data?.agents ?? {};
  const agentIds = useMemo(() => Object.keys(agents).sort(), [agents]);
  const activeId = selectedAgentId && agents[selectedAgentId] ? selectedAgentId : agentIds[0] ?? null;
  const active: AgentEntry | null = activeId ? agents[activeId] ?? null : null;

  const error = agentsQuery.error;
  const needsToken =
    error instanceof MissingAuthTokenError ||
    (error instanceof Error && /401|unauthorized/i.test(error.message));

  return (
    <div className="shell">
      <header className="header">
        <h1>SpriteCore</h1>
        <span className="dim">dashboard · plugin UI</span>
        <ThemeChip theme={theme} />
      </header>
      <aside className="sidebar">
        <h2>Agents</h2>
        {agentsQuery.isLoading && <div className="empty">loading…</div>}
        {agentsQuery.isError && !needsToken && (
          <div className="empty status error">{String(agentsQuery.error)}</div>
        )}
        {!agentsQuery.isLoading && !agentsQuery.isError && agentIds.length === 0 && (
          <div className="empty">no agents configured</div>
        )}
        <ul>
          {agentIds.map((id) => (
            <li key={id}>
              <button
                className={id === activeId ? "active" : undefined}
                onClick={() => setSelectedAgentId(id)}
              >
                {id}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="main">
        {needsToken ? (
          <TokenPrompt error={error as Error} />
        ) : active && activeId ? (
          <AgentPane agentId={activeId} agent={active} />
        ) : (
          <div className="empty">Select an agent to begin.</div>
        )}
      </main>
    </div>
  );
}

function ThemeChip({ theme }: { theme: OpenclawThemeState }): JSX.Element {
  const { mode, selection } = theme;
  const icon = mode === "dark" ? "🌙" : "☀";
  const tip =
    selection === "system"
      ? `synced from Control UI · system → ${mode}`
      : `synced from Control UI · ${selection}`;
  return (
    <span
      className="theme-chip"
      data-mode={mode}
      title={tip}
      aria-label={`theme: ${mode}, ${tip}`}
    >
      <span className="theme-chip__icon" aria-hidden>{icon}</span>
      <span className="theme-chip__label">{mode}</span>
    </span>
  );
}

function TokenPrompt({ error }: { error: Error }): JSX.Element {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(() => readOverrideToken() ?? "");
  const existing = readOverrideToken();
  return (
    <section style={{ maxWidth: 640 }}>
      <h2>Sign-in needed</h2>
      <p className="dim">
        The dashboard couldn't find a Control UI auth token in your browser
        storage on this origin, so every API call returns 401. Paste your
        gateway token below — you'll find it in your{" "}
        <code>~/.openclaw/openclaw.json</code> at <code>gateway.auth.token</code>,
        or in the OpenClaw Control UI under Settings → Gateway. The token is
        kept in <code>localStorage</code> on this device only.
      </p>
      <div className="card" style={{ display: "grid", gap: 8 }}>
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="gateway token"
          spellCheck={false}
          autoComplete="off"
          style={{ fontFamily: "monospace" }}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => {
              setOverrideToken(draft);
              qc.invalidateQueries({ queryKey: ["agents"] });
            }}
            disabled={!draft.trim()}
          >
            Save & retry
          </button>
          {existing && (
            <button
              onClick={() => {
                clearOverrideToken();
                setDraft("");
                qc.invalidateQueries({ queryKey: ["agents"] });
              }}
            >
              Clear saved token
            </button>
          )}
        </div>
        <div className="empty status error" style={{ marginTop: 4 }}>
          {error.message}
        </div>
      </div>
    </section>
  );
}

function AgentPane({ agentId, agent }: { agentId: string; agent: AgentEntry }): JSX.Element {
  const kind = agent.avatar?.kind;
  if (kind === "sprites" || kind === "atlas") {
    return (
      <div className="studio-shell">
        <AnimationStudio agentId={agentId} agent={agent} />
      </div>
    );
  }
  return <LegacyAgentPane agentId={agentId} agent={agent} />;
}

function LegacyAgentPane({
  agentId,
  agent,
}: {
  agentId: string;
  agent: AgentEntry;
}): JSX.Element {
  const emotionKeys = useMemo(() => {
    const fromEmotions = Object.keys(agent.emotions ?? {});
    const fromAvatar = avatarStates(agent);
    // Union: everything that has a description OR is an avatar state, sorted.
    return Array.from(new Set([...fromEmotions, ...fromAvatar])).sort();
  }, [agent]);

  return (
    <>
      <section>
        <h2>{agentId}</h2>
        {emotionKeys.length === 0 && (
          <div className="card">
            <div className="empty">
              No avatar states or emotions configured for this agent.
            </div>
          </div>
        )}
        {emotionKeys.map((state) => (
          <EmotionEditor
            key={`${agentId}:${state}`}
            agentId={agentId}
            stateName={state}
            initial={
              agent.emotions?.[state] ?? {
                description: agent.prompting?.descriptions?.[state] ?? "",
              }
            }
          />
        ))}
      </section>
      <aside>
        <AvatarPreview agentId={agentId} availableStates={avatarStates(agent)} />
      </aside>
    </>
  );
}

function avatarStates(agent: AgentEntry): string[] {
  const avatar = agent.avatar;
  if (!avatar) return [];
  if (avatar.kind === "states") return Object.keys(avatar.states);
  if (avatar.kind === "sprites") return Object.keys(avatar.states);
  if (avatar.kind === "atlas") return Object.keys(avatar.descriptions ?? {});
  return [];
}
