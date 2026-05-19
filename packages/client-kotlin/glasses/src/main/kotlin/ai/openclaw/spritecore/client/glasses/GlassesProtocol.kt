package ai.openclaw.spritecore.client.glasses

import java.util.UUID

/**
 * Wire-level constants for the Brilliant Frame BLE protocol.
 *
 * Source: docs.brilliant.xyz/frame/frame-sdk-bluetooth-specs/
 * One GATT service exposes a TX characteristic (host→Frame) and an RX
 * characteristic (Frame→host, via notifications).
 *
 * Payloads on TX:
 *  - UTF-8 string → Lua statement evaluated by the Frame REPL
 *  - First byte 0x01 + bytes → raw data, delivered to the Lua callback
 *    registered via `frame.bluetooth.receive_callback`
 *
 * Payloads on RX are the symmetric counterpart: Lua `print(...)` output
 * arrives as UTF-8 bytes; raw bytes sent from Lua via `frame.bluetooth.send`
 * arrive prefixed with 0x01.
 */
object GlassesProtocol {
    val SERVICE_UUID: UUID = UUID.fromString("7A230001-5475-A6A4-654C-8431F6AD49C4")
    val TX_CHARACTERISTIC: UUID = UUID.fromString("7A230002-5475-A6A4-654C-8431F6AD49C4")
    val RX_CHARACTERISTIC: UUID = UUID.fromString("7A230003-5475-A6A4-654C-8431F6AD49C4")
    val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805F9B34FB")

    /** Marker byte that distinguishes raw data from a Lua statement. */
    const val RAW_DATA_PREFIX: Byte = 0x01

    /**
     * Per-packet header bytes the host loses to framing. Brilliant docs cite
     * MTU − 4 as the usable payload for raw data.
     */
    const val RAW_DATA_OVERHEAD: Int = 4

    /**
     * App-level sub-channels multiplexed over the single raw-data byte stream.
     * The on-device Lua app prefixes each outbound packet with one of these,
     * and the [GlassesClient] dispatches incoming raw frames accordingly. The
     * 0x01 raw-data prefix is stripped by the protocol layer before the
     * sub-channel byte is inspected.
     */
    object Channel {
        const val MIC: Byte = 0x10
        const val IMU_TAP: Byte = 0x20
        const val IMU_HEADING: Byte = 0x21
        const val BATTERY: Byte = 0x30

        /**
         * Display draw protocol. BEGIN carries 8 bytes of [x_hi][x_lo][y_hi]
         * [y_lo][w_hi][w_lo][h_hi][h_lo] (big-endian u16s); CHUNK carries
         * 4-bits-per-pixel data in raster order; COMMIT carries no payload
         * and triggers `frame.display.show()`. Palette is set once at boot
         * via Lua eval — see [GlassesDisplaySink.installPalette].
         */
        const val DISPLAY_BEGIN: Byte = 0x40
        const val DISPLAY_CHUNK: Byte = 0x41
        const val DISPLAY_COMMIT: Byte = 0x42

        const val ACK: Byte = 0x7F
    }
}
