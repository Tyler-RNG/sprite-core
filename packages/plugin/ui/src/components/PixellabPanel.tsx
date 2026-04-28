import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deletePixellabLink,
  getPixellabCharacters,
  getPixellabHealth,
  putPixellabLink,
  runPixellabExport,
} from "../api/client.js";
import type { AgentEntry, PixellabCharacter } from "../api/types.js";

type Props = {
  agentId: string;
  agent: AgentEntry;
};

/**
 * Per-agent panel showing the link to a pixellab.ai character. Renders one of
 * three states:
 *
 *  - bridge not configured → 503 explanation, no link controls
 *  - linked → preview card + "unlink" + "open in pixellab" affordances
 *  - unlinked → "Link to PixelLab character" button that opens the picker
 *
 * The picker fetches all characters from `/sprite-core/pixellab/characters`
 * and surfaces them as a thumbnailed grid; clicking one PUTs the link via
 * `/sprite-core/agents/:id/pixellab-link`.
 */
export function PixellabPanel({ agentId, agent }: Props): JSX.Element {
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);

  const health = useQuery({
    queryKey: ["pixellab-health"],
    queryFn: ({ signal }) => getPixellabHealth(signal),
    staleTime: 30_000,
  });

  // Lazily fetch characters only when picker opens or when we have a linked id
  // we want to render details for.
  const enabled =
    Boolean(health.data?.configured) &&
    (pickerOpen || Boolean(agent.pixellab?.characterId));
  const characters = useQuery({
    queryKey: ["pixellab-characters"],
    queryFn: ({ signal }) => getPixellabCharacters(signal),
    enabled,
    staleTime: 60_000,
  });

  const linked = useMemo(() => {
    if (!agent.pixellab?.characterId) return null;
    return (
      characters.data?.characters.find((c) => c.id === agent.pixellab?.characterId) ??
      null
    );
  }, [agent.pixellab?.characterId, characters.data]);

  const linkMutation = useMutation({
    mutationFn: async (characterId: string) => {
      await putPixellabLink(agentId, {
        characterId,
        lastSyncedAt: agent.pixellab?.lastSyncedAt,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["agents"] });
      setPickerOpen(false);
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: () => deletePixellabLink(agentId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  const exportMutation = useMutation({
    mutationFn: () => runPixellabExport(agentId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  if (health.isLoading) {
    return (
      <section className="pixellab-panel">
        <header className="pixellab-panel__head">
          <h3>PixelLab</h3>
          <span className="dim">checking…</span>
        </header>
      </section>
    );
  }

  if (health.isError) {
    return (
      <section className="pixellab-panel">
        <header className="pixellab-panel__head">
          <h3>PixelLab</h3>
        </header>
        <div className="status error">{String(health.error)}</div>
      </section>
    );
  }

  if (!health.data?.configured) {
    return (
      <section className="pixellab-panel">
        <header className="pixellab-panel__head">
          <h3>PixelLab</h3>
          <span className="status dim">not configured</span>
        </header>
        <div className="dim">
          Set <code>plugins.entries.sprite-core.config.pixellab.apiKey</code> to a
          SecretRef pointing at <code>PIXELLAB_API_KEY</code> in your
          <code>openclaw.json</code>, and ensure the env var is available to the
          gateway. See the plugin README for details.
        </div>
      </section>
    );
  }

  return (
    <section className="pixellab-panel">
      <header className="pixellab-panel__head">
        <h3>PixelLab</h3>
        <span className="status dim">
          {health.data.activeJobs} active · {health.data.waitingJobs} waiting
        </span>
      </header>

      {agent.pixellab?.characterId ? (
        <LinkedRow
          characterId={agent.pixellab.characterId}
          character={linked}
          loading={enabled && characters.isLoading}
          lastSyncedAt={agent.pixellab.lastSyncedAt}
          onUnlink={() => {
            if (!window.confirm(`Unlink agent "${agentId}" from PixelLab?`)) return;
            unlinkMutation.mutate();
          }}
          unlinkPending={unlinkMutation.isPending}
          onChange={() => setPickerOpen(true)}
          onRePull={() => {
            if (
              !window.confirm(
                `Re-pull "${agentId}" from PixelLab? This rebuilds the atlas from whatever's currently on PixelLab — it overwrites local frame edits but keeps your emotion descriptions.`,
              )
            )
              return;
            exportMutation.mutate();
          }}
          rePullPending={exportMutation.isPending}
        />
      ) : (
        <UnlinkedRow onLink={() => setPickerOpen(true)} />
      )}

      {linkMutation.isError && (
        <div className="status error">{String(linkMutation.error)}</div>
      )}
      {unlinkMutation.isError && (
        <div className="status error">{String(unlinkMutation.error)}</div>
      )}
      {exportMutation.isError && (
        <div className="status error">re-pull failed: {String(exportMutation.error)}</div>
      )}
      {exportMutation.isSuccess && exportMutation.data && (
        <div className="status ok">
          re-pulled {exportMutation.data.animations.length} animation
          {exportMutation.data.animations.length === 1 ? "" : "s"} ·{" "}
          {new Date(exportMutation.data.exportedAt).toLocaleTimeString()}
          {exportMutation.data.warning ? ` (${exportMutation.data.warning})` : ""}
        </div>
      )}

      {pickerOpen && (
        <PixellabPicker
          currentCharacterId={agent.pixellab?.characterId ?? null}
          characters={characters.data?.characters ?? []}
          loading={characters.isLoading}
          error={characters.error ? String(characters.error) : null}
          onClose={() => setPickerOpen(false)}
          onPick={(c) => linkMutation.mutate(c.id)}
          pending={linkMutation.isPending}
        />
      )}
    </section>
  );
}

function LinkedRow({
  characterId,
  character,
  loading,
  lastSyncedAt,
  onUnlink,
  unlinkPending,
  onChange,
  onRePull,
  rePullPending,
}: {
  characterId: string;
  character: PixellabCharacter | null;
  loading: boolean;
  lastSyncedAt: number | undefined;
  onUnlink: () => void;
  unlinkPending: boolean;
  onChange: () => void;
  onRePull: () => void;
  rePullPending: boolean;
}): JSX.Element {
  return (
    <div className="pixellab-panel__linked">
      <div className="pixellab-panel__thumb">
        {character?.preview_url ? (
          <img src={character.preview_url} alt={character.name ?? characterId} />
        ) : loading ? (
          <span className="dim">loading…</span>
        ) : (
          <span className="dim">no preview</span>
        )}
      </div>
      <div className="pixellab-panel__meta">
        <div className="pixellab-panel__name">
          {character?.name ? truncate(character.name, 80) : characterId}
        </div>
        <div className="dim">
          <code className="pixellab-panel__id">{characterId.slice(0, 8)}</code>
          {character ? (
            <>
              {" · "}
              {character.animation_count ?? 0} animations
              {character.size
                ? ` · ${character.size.width}×${character.size.height}`
                : ""}
            </>
          ) : null}
          {lastSyncedAt
            ? ` · synced ${formatRelative(lastSyncedAt)}`
            : " · never synced"}
        </div>
        <div className="pixellab-panel__actions">
          <button
            type="button"
            className="primary"
            onClick={onRePull}
            disabled={rePullPending}
            title="Re-pull this character's frames from PixelLab and rebuild the atlas"
          >
            {rePullPending ? "re-pulling…" : "↻ re-pull from PixelLab"}
          </button>
          <button type="button" onClick={onChange}>change</button>
          <button
            type="button"
            className="pixellab-panel__unlink"
            onClick={onUnlink}
            disabled={unlinkPending}
          >
            {unlinkPending ? "unlinking…" : "unlink"}
          </button>
          <a
            className="link-btn"
            href={`https://www.pixellab.ai/characters/${encodeURIComponent(characterId)}`}
            target="_blank"
            rel="noreferrer"
          >
            open in pixellab ↗
          </a>
        </div>
      </div>
    </div>
  );
}

function UnlinkedRow({ onLink }: { onLink: () => void }): JSX.Element {
  return (
    <div className="pixellab-panel__unlinked">
      <div className="dim">
        Not linked. Link this agent to a PixelLab character so the dashboard can
        animate, regenerate, and re-export from PixelLab without leaving the
        page.
      </div>
      <button type="button" className="primary" onClick={onLink}>
        Link to PixelLab character
      </button>
    </div>
  );
}

function PixellabPicker({
  currentCharacterId,
  characters,
  loading,
  error,
  onClose,
  onPick,
  pending,
}: {
  currentCharacterId: string | null;
  characters: PixellabCharacter[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onPick: (c: PixellabCharacter) => void;
  pending: boolean;
}): JSX.Element {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return characters;
    return characters.filter(
      (c) =>
        c.name?.toLowerCase().includes(f) ||
        c.id.toLowerCase().includes(f) ||
        c.prompt?.toLowerCase().includes(f),
    );
  }, [characters, filter]);

  return (
    <div className="pixellab-picker__backdrop" role="dialog" aria-modal>
      <div className="pixellab-picker">
        <header className="pixellab-picker__head">
          <h3>Link to PixelLab character</h3>
          <input
            className="pixellab-picker__filter"
            placeholder="filter by name / id / prompt…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
          />
          <button type="button" onClick={onClose}>close</button>
        </header>

        {loading && <div className="empty">loading characters…</div>}
        {error && <div className="status error">{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="empty">no characters match.</div>
        )}

        <div className="pixellab-picker__grid">
          {filtered.map((c) => {
            const current = c.id === currentCharacterId;
            return (
              <button
                key={c.id}
                type="button"
                className={
                  "pixellab-picker__item" +
                  (current ? " pixellab-picker__item--current" : "")
                }
                disabled={pending || current}
                onClick={() => onPick(c)}
                title={c.prompt ?? c.name}
              >
                <div className="pixellab-picker__thumb">
                  {c.preview_url ? (
                    <img src={c.preview_url} alt={c.name} />
                  ) : (
                    <span className="dim">—</span>
                  )}
                </div>
                <div className="pixellab-picker__name">{truncate(c.name, 60)}</div>
                <div className="pixellab-picker__meta dim">
                  {c.animation_count ?? 0} anims
                  {current ? " · current" : ""}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}
