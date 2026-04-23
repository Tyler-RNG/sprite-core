package ai.openclaw.spritecore.client

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicLong

/**
 * Client-side unified fetcher + cache for per-agent CharacterManifest
 * envelopes and their asset bytes. Pure JVM — no Android deps — so any
 * Kotlin client (wearable, phone, desktop, JVM server) can use it.
 *
 * Fetch policy is explicit: callers invoke [refresh] with an agent-id list.
 * An agent already present at the same manifest revision is left alone;
 * revision bumps trigger a re-fetch of the asset refs.
 *
 * This is the Kotlin mirror of `@tyler-rng/sprite-core-client`'s
 * `AssetSource`. The two stay behaviourally identical — the conformance
 * suite in `fixtures/` at the repo root enforces it.
 */
class AgentAvatarSource(
    private val scope: CoroutineScope,
    private val fetchManifest: suspend (agentId: String) -> CharacterManifestEnvelope?,
    private val fetchAsset: suspend (relativePath: String) -> ByteArray?,
    private val logger: (level: LogLevel, tag: String, msg: String) -> Unit = { _, _, _ -> },
) {
    enum class LogLevel { DEBUG, WARN }

    private val _characterManifests =
        MutableStateFlow<Map<String, CharacterManifestEnvelope>>(emptyMap())
    val characterManifests: StateFlow<Map<String, CharacterManifestEnvelope>> =
        _characterManifests.asStateFlow()

    private val _characterAssets =
        MutableStateFlow<Map<String, Map<String, ByteArray>>>(emptyMap())
    val characterAssets: StateFlow<Map<String, Map<String, ByteArray>>> =
        _characterAssets.asStateFlow()

    private val _agentStates = MutableStateFlow<Map<String, String>>(emptyMap())
    val agentStates: StateFlow<Map<String, String>> = _agentStates.asStateFlow()

    private val _agentMarkerSignals = MutableStateFlow<Map<String, AvatarMarkerSignal>>(emptyMap())
    val agentMarkerSignals: StateFlow<Map<String, AvatarMarkerSignal>> =
        _agentMarkerSignals.asStateFlow()

    private val signalVersionSeq = AtomicLong(0L)
    private val fetchMutex = Mutex()

    /**
     * Kick off a background fetch for each agent. No-ops for agents whose
     * manifest is already cached at the current revision. Returns immediately;
     * the flows update as results land.
     */
    fun refresh(agentIds: List<String>) {
        if (agentIds.isEmpty()) return
        scope.launch {
            fetchMutex.withLock {
                for (agentId in agentIds) {
                    refreshOne(agentId)
                }
            }
        }
    }

    /**
     * Update the current state for an agent. Called by the chat-reply path
     * when an `<<<state>>>` or `<<<state-N>>>` marker fires.
     */
    fun setAgentState(agentId: String, stateName: String, count: Int? = null) {
        _agentStates.update { it + (agentId to stateName) }
        val signal = AvatarMarkerSignal(
            state = stateName,
            count = count,
            version = signalVersionSeq.incrementAndGet(),
        )
        _agentMarkerSignals.update { it + (agentId to signal) }
    }

    /** Snapshot of the current cache for callers to iterate. */
    fun snapshot(): List<CachedAgent> {
        val manifests = _characterManifests.value
        val assets = _characterAssets.value
        return manifests.map { (agentId, envelope) ->
            CachedAgent(agentId = agentId, envelope = envelope, assetBytes = assets[agentId].orEmpty())
        }
    }

    /** Drop any cached entries for agents no longer in [keepIds]. */
    fun retainOnly(keepIds: Collection<String>) {
        val keep = keepIds.toSet()
        _characterManifests.update { it.filterKeys { id -> id in keep } }
        _characterAssets.update { it.filterKeys { id -> id in keep } }
        _agentStates.update { it.filterKeys { id -> id in keep } }
    }

    fun clear() {
        _characterManifests.update { emptyMap() }
        _characterAssets.update { emptyMap() }
        _agentStates.update { emptyMap() }
    }

    /**
     * Resolve the default state name for [agentId] from its cached manifest.
     * Mirrors [AnimationGraph.fromManifest] default-state logic so the two
     * never drift.
     */
    fun defaultStateFor(agentId: String): String? {
        val envelope = _characterManifests.value[agentId] ?: return null
        val manifest = envelope.manifest
        val mode = manifest.modes.firstOrNull { manifest.content.containsKey(it) } ?: return null
        val animations = manifest.content[mode]?.animations ?: return null
        val firstFromMap = manifest.stateMap.entries.firstOrNull { animations.containsKey(it.value) }
        if (firstFromMap != null) return firstFromMap.value
        return animations.keys.firstOrNull()
    }

    // --- internals ---

    private suspend fun refreshOne(agentId: String) {
        val envelope = fetchManifest(agentId) ?: run {
            logger(LogLevel.DEBUG, TAG, "manifest skip $agentId (no structured avatar or RPC failed)")
            return
        }
        val existing = _characterManifests.value[agentId]
        if (existing != null && existing.revision == envelope.revision) {
            return
        }
        _characterManifests.update { it + (agentId to envelope) }

        val bytesByRef = mutableMapOf<String, ByteArray>()
        for ((refKey, relPath) in envelope.manifest.assets.refs) {
            val bytes = fetchAsset(relPath)
            if (bytes != null) {
                bytesByRef[refKey] = bytes
            } else {
                logger(LogLevel.WARN, TAG, "asset fetch failed $agentId $refKey")
            }
        }
        _characterAssets.update { it + (agentId to bytesByRef) }
        logger(
            LogLevel.DEBUG,
            TAG,
            "cached $agentId rev=${envelope.revision} (${bytesByRef.size}/${envelope.manifest.assets.refs.size} assets)",
        )
    }

    data class CachedAgent(
        val agentId: String,
        val envelope: CharacterManifestEnvelope,
        val assetBytes: Map<String, ByteArray>,
    )

    /**
     * Versioned per-agent animation signal. [version] bumps on every
     * [setAgentState] call so UI consumers keyed on the signal re-trigger
     * their effects even when the state name is unchanged.
     */
    data class AvatarMarkerSignal(
        val state: String,
        val count: Int?,
        val version: Long,
    )

    companion object {
        private const val TAG = "AgentAvatarSource"
    }
}
