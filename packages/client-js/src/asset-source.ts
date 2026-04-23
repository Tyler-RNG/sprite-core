import type { CharacterManifest, NodeGetCharacterManifestResult } from "./schema.js";
import { MutableObservable, type Observable } from "./observable.js";

/**
 * Versioned per-agent animation signal. `version` bumps on every
 * `setAgentState` call so UI consumers keyed on the signal re-trigger even
 * when the state name is unchanged. `count` is forwarded from the parsed
 * `<<<state-N>>>` marker and governs playback cadence.
 */
export type AvatarMarkerSignal = {
  state: string;
  count: number | null;
  version: number;
};

export type CachedAgent = {
  agentId: string;
  envelope: NodeGetCharacterManifestResult;
  assetBytes: Readonly<Record<string, Uint8Array>>;
};

export type AssetSourceHooks = {
  fetchManifest: (agentId: string) => Promise<NodeGetCharacterManifestResult | null>;
  fetchAsset: (relativePath: string) => Promise<Uint8Array | null>;
};

/**
 * Client-side unified fetcher + cache for per-agent CharacterManifest
 * envelopes and their asset bytes. Ports the Kotlin `AgentAvatarSource`:
 *
 *   - `characterManifests` — latest envelope per agent
 *   - `characterAssets`    — latest asset bytes map per agent
 *   - `agentMarkerSignals` — monotonic versioned state signal per agent
 *
 * Fetch policy is explicit: callers invoke `refresh(agentIds)`. An agent
 * already present at the same revision is left alone; revision bumps trigger
 * a re-fetch of changed asset refs.
 */
export class AssetSource {
  private readonly _characterManifests = new MutableObservable<
    Readonly<Record<string, NodeGetCharacterManifestResult>>
  >({});
  private readonly _characterAssets = new MutableObservable<
    Readonly<Record<string, Readonly<Record<string, Uint8Array>>>>
  >({});
  private readonly _agentStates = new MutableObservable<Readonly<Record<string, string>>>({});
  private readonly _agentMarkerSignals = new MutableObservable<
    Readonly<Record<string, AvatarMarkerSignal>>
  >({});
  private signalVersionSeq = 0;
  private inflight: Promise<void> | null = null;

  readonly characterManifests: Observable<Readonly<Record<string, NodeGetCharacterManifestResult>>> =
    this._characterManifests;
  readonly characterAssets: Observable<
    Readonly<Record<string, Readonly<Record<string, Uint8Array>>>>
  > = this._characterAssets;
  readonly agentStates: Observable<Readonly<Record<string, string>>> = this._agentStates;
  readonly agentMarkerSignals: Observable<Readonly<Record<string, AvatarMarkerSignal>>> =
    this._agentMarkerSignals;

  constructor(private readonly hooks: AssetSourceHooks) {}

  /**
   * Kick off a refresh for each agent. Returns when all fetches settle.
   * No-ops for agents whose manifest is already cached at the current
   * revision.
   */
  async refresh(agentIds: readonly string[]): Promise<void> {
    if (agentIds.length === 0) return;
    // Serialize refreshes to match the Kotlin Mutex behavior.
    const prev = this.inflight ?? Promise.resolve();
    let release!: () => void;
    this.inflight = new Promise<void>((r) => {
      release = r;
    });
    try {
      await prev;
      for (const agentId of agentIds) {
        await this.refreshOne(agentId);
      }
    } finally {
      release();
    }
  }

  /**
   * Update the current state for an agent. Called when an `<<<state>>>` or
   * `<<<state-N>>>` marker fires.
   */
  setAgentState(agentId: string, stateName: string, count: number | null = null): void {
    this._agentStates.set({ ...this._agentStates.value, [agentId]: stateName });
    this.signalVersionSeq += 1;
    const signal: AvatarMarkerSignal = {
      state: stateName,
      count,
      version: this.signalVersionSeq,
    };
    this._agentMarkerSignals.set({
      ...this._agentMarkerSignals.value,
      [agentId]: signal,
    });
  }

  /**
   * Snapshot of the current cache. Values are consistent per call;
   * concurrent cache updates between calls are expected and safe.
   */
  snapshot(): readonly CachedAgent[] {
    const manifests = this._characterManifests.value;
    const assets = this._characterAssets.value;
    return Object.entries(manifests).map(([agentId, envelope]) => ({
      agentId,
      envelope,
      assetBytes: assets[agentId] ?? {},
    }));
  }

  /** Drop any cached entries for agents no longer in [keepIds]. */
  retainOnly(keepIds: Iterable<string>): void {
    const keep = new Set(keepIds);
    this._characterManifests.set(filterKeys(this._characterManifests.value, keep));
    this._characterAssets.set(filterKeys(this._characterAssets.value, keep));
    this._agentStates.set(filterKeys(this._agentStates.value, keep));
  }

  clear(): void {
    this._characterManifests.set({});
    this._characterAssets.set({});
    this._agentStates.set({});
  }

  /**
   * Resolve the default state name for [agentId] from its cached manifest.
   * Mirrors `AnimationGraph.fromManifest` default-state logic so the two
   * never drift.
   */
  defaultStateFor(agentId: string): string | null {
    const envelope = this._characterManifests.value[agentId];
    if (!envelope) return null;
    return resolveDefaultStateName(envelope.manifest);
  }

  // --- internals ---

  private async refreshOne(agentId: string): Promise<void> {
    const envelope = await this.hooks.fetchManifest(agentId);
    if (!envelope) return;
    const existing = this._characterManifests.value[agentId];
    if (existing && existing.revision === envelope.revision) return;
    this._characterManifests.set({
      ...this._characterManifests.value,
      [agentId]: envelope,
    });

    const refs = envelope.manifest.assets.refs;
    const bytesByRef: Record<string, Uint8Array> = {};
    for (const [refKey, relPath] of Object.entries(refs)) {
      const bytes = await this.hooks.fetchAsset(relPath);
      if (bytes !== null) {
        bytesByRef[refKey] = bytes;
      }
    }
    this._characterAssets.set({
      ...this._characterAssets.value,
      [agentId]: bytesByRef,
    });
  }
}

function filterKeys<V>(
  source: Readonly<Record<string, V>>,
  keep: Set<string>,
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(source)) {
    if (keep.has(k)) out[k] = v;
  }
  return out;
}

function resolveDefaultStateName(manifest: CharacterManifest): string | null {
  const mode = manifest.modes.find((m) => m in manifest.content);
  if (!mode) return null;
  const animations = manifest.content[mode]?.animations;
  if (!animations) return null;
  for (const [, animName] of Object.entries(manifest.stateMap)) {
    if (animName in animations) return animName;
  }
  const first = Object.keys(animations)[0];
  return first ?? null;
}
