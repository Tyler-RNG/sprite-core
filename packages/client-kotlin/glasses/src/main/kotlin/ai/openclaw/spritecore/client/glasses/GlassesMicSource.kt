package ai.openclaw.spritecore.client.glasses

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map

/**
 * Exposes the on-device mic stream as a [Flow] of raw PCM byte chunks. The
 * Lua app starts the mic at 8 kHz / 8-bit (320-byte chunks ≈ 40 ms each)
 * and forwards each `frame.microphone.read` result on
 * [GlassesProtocol.Channel.MIC]. Sample format matches what openclaw's STT
 * route expects when [pcm8kMono8bit] is true.
 */
class GlassesMicSource(private val client: GlassesClient) {

    val pcm8kMono8bit: Flow<ByteArray> = client.data
        .filter { it.channel == GlassesProtocol.Channel.MIC }
        .map { it.bytes }

    /** Convenience commands the Lua app exposes as global functions. */
    suspend fun start(sampleRate: Int = 8000, bitDepth: Int = 8) {
        client.eval(
            "mic_start($sampleRate,$bitDepth)"
        )
    }

    suspend fun stop() {
        client.eval("mic_stop()")
    }
}
