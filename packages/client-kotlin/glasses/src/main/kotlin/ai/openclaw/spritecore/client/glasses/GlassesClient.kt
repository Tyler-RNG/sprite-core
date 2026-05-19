package ai.openclaw.spritecore.client.glasses

import android.content.res.AssetManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import java.nio.charset.StandardCharsets

/**
 * High-level driver for a Brilliant Frame. Wraps [GlassesBleTransport] with:
 *  - Lua statement execution (`eval`, `print` round-trips)
 *  - Sub-channel framing on top of the 0x01 raw-data byte stream
 *  - Bundled-Lua-app upload + start
 *
 * The on-device app multiplexes mic, IMU and battery telemetry over a single
 * data stream by prefixing each outbound packet with a byte from
 * [GlassesProtocol.Channel]; this class fans those back out as sub-flows.
 */
class GlassesClient internal constructor(
    private val transport: GlassesBleTransport,
    private val scope: CoroutineScope,
) {
    private val _luaResponses = MutableSharedFlow<String>(extraBufferCapacity = 32)
    /** UTF-8 lines emitted by `print(...)` on the device, in arrival order. */
    val luaResponses: SharedFlow<String> = _luaResponses.asSharedFlow()

    private val _data = MutableSharedFlow<DataPacket>(extraBufferCapacity = 256)
    /** Raw sub-channel packets demuxed from the 0x01 stream. */
    val data: SharedFlow<DataPacket> = _data.asSharedFlow()

    private var pumpJob: Job? = null

    data class DataPacket(val channel: Byte, val bytes: ByteArray)

    fun start() {
        pumpJob = scope.launch {
            transport.incoming.collect { raw -> dispatch(raw) }
        }
    }

    fun stop() {
        pumpJob?.cancel()
        pumpJob = null
    }

    /** Maximum bytes that fit in one raw-data write after the 0x01 + sub-channel byte. */
    val maxAppPayload: Int
        get() = (transport.maxWriteLength - 1).coerceAtLeast(1)

    /** Sends a Lua statement as plain UTF-8. Use [evalAndAwaitPrint] if you want a reply. */
    suspend fun eval(lua: String) {
        transport.write(lua.toByteArray(StandardCharsets.UTF_8))
    }

    /**
     * Sends one application packet on a sub-channel. The wire form is
     * `[0x01][channel][bytes...]`. Caller is responsible for chunking if
     * [bytes] exceeds [maxAppPayload].
     */
    suspend fun sendData(channel: Byte, bytes: ByteArray) {
        require(bytes.size <= maxAppPayload) {
            "payload ${bytes.size} exceeds maxAppPayload=$maxAppPayload"
        }
        val framed = ByteArray(bytes.size + 2)
        framed[0] = GlassesProtocol.RAW_DATA_PREFIX
        framed[1] = channel
        System.arraycopy(bytes, 0, framed, 2, bytes.size)
        transport.write(framed)
    }

    /**
     * Uploads the bundled on-device Lua app, writes it to `main.lua` on the
     * Frame filesystem, then requires() it. Subsequent reconnects can skip
     * this and just call [requireApp]; main.lua persists.
     *
     * Wraps each chunk in a Lua long-bracket literal (`[=====[ … ]=====]`)
     * which preserves bytes verbatim — no per-character escaping needed.
     * Picks a `=` level guaranteed not to appear inside the source.
     */
    suspend fun installApp(assets: AssetManager, assetPath: String = LUA_APP_ASSET) {
        val source = assets.open(assetPath).use { it.readBytes().toString(StandardCharsets.UTF_8) }
        val level = pickBracketLevel(source)
        val open = "[" + "=".repeat(level) + "["
        val close = "]" + "=".repeat(level) + "]"
        val wrapperOverhead = "f:write()".length + open.length + close.length
        val chunkSize = (transport.maxWriteLength - wrapperOverhead - 4).coerceAtLeast(32)

        eval("f=frame.file.open('main.lua','w')")
        var i = 0
        while (i < source.length) {
            val end = minOf(i + chunkSize, source.length)
            eval("f:write($open" + source.substring(i, end) + "$close)")
            i = end
        }
        eval("f:close()")
    }

    private fun pickBracketLevel(source: String): Int {
        // Try levels 1..16 until we find one whose ]====] closing sequence
        // never appears in source. 16 is well past anything found in the wild.
        for (n in 1..16) {
            val candidate = "]" + "=".repeat(n) + "]"
            if (!source.contains(candidate)) return n
        }
        error("could not find a safe Lua long-bracket level for source")
    }

    /** Boots the installed app. The Lua side opens its main loop here. */
    suspend fun requireApp() {
        eval("require('main')")
    }

    private fun dispatch(raw: ByteArray) {
        if (raw.isEmpty()) return
        if (raw[0] == GlassesProtocol.RAW_DATA_PREFIX && raw.size >= 2) {
            val channel = raw[1]
            val payload = raw.copyOfRange(2, raw.size)
            _data.tryEmit(DataPacket(channel, payload))
        } else {
            _luaResponses.tryEmit(raw.toString(StandardCharsets.UTF_8))
        }
    }

    companion object {
        const val LUA_APP_ASSET: String = "glasses_app.lua"

        suspend fun connect(
            transport: GlassesBleTransport,
            scope: CoroutineScope,
        ): GlassesClient {
            transport.connect()
            transport.negotiateMtu()
            val client = GlassesClient(transport, scope)
            client.start()
            return client
        }
    }
}
