package ai.openclaw.spritecore.client.glasses

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.mapNotNull
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Demuxes tap + heading sub-channels into typed [GlassesInputEvent]s. */
class GlassesInputSource(private val client: GlassesClient) {

    val events: Flow<GlassesInputEvent> = client.data.mapNotNull { packet ->
        when (packet.channel) {
            GlassesProtocol.Channel.IMU_TAP -> GlassesInputEvent.Tap

            GlassesProtocol.Channel.IMU_HEADING -> {
                if (packet.bytes.size < 12) return@mapNotNull null
                val buf = ByteBuffer.wrap(packet.bytes).order(ByteOrder.LITTLE_ENDIAN)
                GlassesInputEvent.Heading(buf.float, buf.float, buf.float)
            }

            else -> null
        }
    }
}
