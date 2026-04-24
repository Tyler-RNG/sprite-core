import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAgents } from "./api/client.js";
import { EmotionEditor } from "./components/EmotionEditor.js";
import { AvatarPreview } from "./preview/AvatarPreview.js";
import type { AgentEntry } from "./api/types.js";

export function App(): JSX.Element {
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: ({ signal }) => getAgents(signal),
  });
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const agents = agentsQuery.data?.agents ?? {};
  const agentIds = useMemo(() => Object.keys(agents).sort(), [agents]);
  const activeId = selectedAgentId && agents[selectedAgentId] ? selectedAgentId : agentIds[0] ?? null;
  const active: AgentEntry | null = activeId ? agents[activeId] ?? null : null;

  return (
    <div className="shell">
      <header className="header">
        <h1>SpriteCore</h1>
        <span className="dim">dashboard · plugin UI</span>
      </header>
      <aside className="sidebar">
        <h2>Agents</h2>
        {agentsQuery.isLoading && <div className="empty">loading…</div>}
        {agentsQuery.isError && (
          <div className="empty status error">{String(agentsQuery.error)}</div>
        )}
        {!agentsQuery.isLoading && agentIds.length === 0 && (
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
        {active && activeId ? (
          <AgentPane agentId={activeId} agent={active} />
        ) : (
          <div className="empty">Select an agent to begin.</div>
        )}
      </main>
    </div>
  );
}

function AgentPane({ agentId, agent }: { agentId: string; agent: AgentEntry }): JSX.Element {
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
