package ai.openclaw.spritecore.client.compose

import ai.openclaw.spritecore.client.AgentAvatarSource
import ai.openclaw.spritecore.client.AnimationGraph
import ai.openclaw.spritecore.client.CharacterManifestEnvelope
import ai.openclaw.spritecore.client.CharacterManifestJson
import ai.openclaw.spritecore.client.SpriteAnimationPlayer
import ai.openclaw.spritecore.client.android.BitmapFrameSource
import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale

/**
 * Compose-driven avatar that renders a [CharacterManifestEnvelope] through the
 * SpriteCore animation engine. One code path covers sprite, atlas, and flat
 * states: every shape projects through [AnimationGraph.fromManifest] and
 * [SpriteAnimationPlayer], with [BitmapFrameSource] resolving the bytes.
 *
 * Pass a [bitmapTransform] to apply a per-frame crop or filter — e.g. a
 * watch face passing a top-half-square crop to extract a headshot from a
 * full-body sprite. Defaults to identity, so phone-sized avatars render the
 * frame as-authored.
 *
 * State-change inputs ([markerSignal] vs [currentState] / [playCount]):
 * - [markerSignal] takes precedence when non-null. Its monotonic
 *   [AgentAvatarSource.AvatarMarkerSignal.version] keys the launched effect
 *   so a model emitting the same `<<<wink-1>>>` twice in a row visibly
 *   replays — repeat markers don't get swallowed because `(state, count)`
 *   match. Pair with [AgentAvatarSource.setAgentState] on the producer side.
 * - When [markerSignal] is null, falls back to [currentState] +
 *   [playCount] keyed directly. Suitable for callers (e.g. a watch dial)
 *   that don't need same-marker replay semantics.
 *
 * Returns silently (paints nothing) when the manifest has no mode this
 * caller can render or when the first frame hasn't decoded yet; the caller's
 * fallback owns the empty state.
 */
@Composable
fun CharacterAvatar(
    agentId: String,
    envelope: CharacterManifestEnvelope,
    assetBytes: Map<String, ByteArray>,
    currentState: String?,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    contentScale: ContentScale = ContentScale.Crop,
    bitmapTransform: (Bitmap) -> Bitmap = { it },
    playCount: Int? = null,
    markerSignal: AgentAvatarSource.AvatarMarkerSignal? = null,
) {
    val mode = remember(envelope.revision, agentId) {
        CharacterManifestJson.pickMode(envelope.manifest)
    }
    if (mode == null) return
    val graph = remember(envelope.revision, agentId, mode) {
        runCatching { AnimationGraph.fromManifest(envelope.manifest, mode) }.getOrNull()
    } ?: return

    // Key the FrameSource by revision so byte changes (new manifest version)
    // force re-decode of bitmaps; within a revision the sliceCache + decode
    // cache stay warm across recompositions.
    val frameSource = remember(envelope.revision, agentId, assetBytes) {
        BitmapFrameSource(assetBytes)
    }
    val player = remember(envelope.revision, agentId, mode) {
        SpriteAnimationPlayer(graph)
    }
    DisposableEffect(player) { onDispose { player.dispose() } }

    if (markerSignal != null) {
        LaunchedEffect(player, markerSignal.version) {
            val resolved = envelope.manifest.stateMap[markerSignal.state] ?: markerSignal.state
            if (envelope.manifest.content[mode]?.animations?.containsKey(resolved) == true) {
                player.requestState(resolved, playCount = markerSignal.count)
            }
        }
    } else {
        LaunchedEffect(player, currentState, playCount) {
            currentState?.takeIf { it.isNotBlank() }?.let { stateName ->
                val resolved = envelope.manifest.stateMap[stateName] ?: stateName
                if (envelope.manifest.content[mode]?.animations?.containsKey(resolved) == true) {
                    player.requestState(resolved, playCount)
                }
            }
        }
    }

    val ref by player.currentRef.collectAsState()
    val bitmap: Bitmap? = ref?.let { frameSource.frame(it) }
    if (bitmap == null) return
    val transformed = remember(bitmap, bitmapTransform) { bitmapTransform(bitmap) }
    Image(
        bitmap = transformed.asImageBitmap(),
        contentDescription = contentDescription,
        contentScale = contentScale,
        modifier = modifier.fillMaxSize(),
    )
}
