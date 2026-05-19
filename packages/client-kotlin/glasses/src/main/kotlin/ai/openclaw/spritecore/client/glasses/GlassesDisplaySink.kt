package ai.openclaw.spritecore.client.glasses

import android.graphics.Bitmap
import android.graphics.Color
import ai.openclaw.spritecore.client.FrameRef
import ai.openclaw.spritecore.client.FrameSource

/**
 * Adapter from sprite-core's [FrameSource]&lt;Bitmap&gt; surface to the Brilliant
 * Frame's 16-color display. One sink instance corresponds to one on-screen
 * sprite slot — call [show] each tick with the current [FrameRef] from
 * `SpriteAnimationPlayer.currentRef`.
 *
 * The Frame display is 640×400 with at most 16 colors per frame from a 255
 * palette. This sink uses a fixed 16-entry sprite palette ([DEFAULT_PALETTE])
 * installed once via [installPalette]; per-frame work is quantize → pack 4bpp
 * → stream as DISPLAY_BEGIN + N×CHUNK + COMMIT packets.
 */
class GlassesDisplaySink(
    private val client: GlassesClient,
    private val source: FrameSource<Bitmap>,
    private val palette: IntArray = DEFAULT_PALETTE,
    private val originX: Int = 0,
    private val originY: Int = 0,
) {
    init {
        require(palette.size == PALETTE_SIZE) {
            "palette must have $PALETTE_SIZE entries; got ${palette.size}"
        }
    }

    /** Sends 16 `frame.display.assign_color` calls so the device knows the palette. */
    suspend fun installPalette() {
        val sb = StringBuilder()
        for (i in palette.indices) {
            val c = palette[i]
            val r = (c shr 16) and 0xFF
            val g = (c shr 8) and 0xFF
            val b = c and 0xFF
            sb.append("frame.display.assign_color($i,$r,$g,$b);")
        }
        client.eval(sb.toString())
    }

    /** Quantize, pack, stream one frame. No-op if [ref] resolves to null. */
    suspend fun show(ref: FrameRef) {
        val bitmap = source.frame(ref) ?: return
        val packed = quantizeAndPack(bitmap, palette)
        sendBegin(originX, originY, bitmap.width, bitmap.height)
        val chunkSize = client.maxAppPayload
        var offset = 0
        while (offset < packed.size) {
            val end = minOf(offset + chunkSize, packed.size)
            client.sendData(GlassesProtocol.Channel.DISPLAY_CHUNK, packed.copyOfRange(offset, end))
            offset = end
        }
        client.sendData(GlassesProtocol.Channel.DISPLAY_COMMIT, EMPTY)
    }

    private suspend fun sendBegin(x: Int, y: Int, w: Int, h: Int) {
        val header = ByteArray(8)
        header[0] = (x ushr 8).toByte(); header[1] = x.toByte()
        header[2] = (y ushr 8).toByte(); header[3] = y.toByte()
        header[4] = (w ushr 8).toByte(); header[5] = w.toByte()
        header[6] = (h ushr 8).toByte(); header[7] = h.toByte()
        client.sendData(GlassesProtocol.Channel.DISPLAY_BEGIN, header)
    }

    companion object {
        const val PALETTE_SIZE = 16

        /**
         * Default 16-color palette: indices 0..7 = grayscale ramp,
         * 8..15 = saturated primaries. Tuned to be legible against the
         * Frame's emissive panel, not to match any particular brand.
         */
        val DEFAULT_PALETTE: IntArray = intArrayOf(
            0x000000, 0x222222, 0x444444, 0x666666,
            0x888888, 0xAAAAAA, 0xCCCCCC, 0xFFFFFF,
            0xFF0000, 0x00FF00, 0x0000FF, 0xFFFF00,
            0xFF00FF, 0x00FFFF, 0xFF8000, 0x80FF00,
        )

        private val EMPTY = ByteArray(0)

        /** Nearest-neighbour quantize to [palette], then pack 2 pixels per byte. */
        internal fun quantizeAndPack(bm: Bitmap, palette: IntArray): ByteArray {
            val w = bm.width; val h = bm.height
            val pixels = IntArray(w * h)
            bm.getPixels(pixels, 0, w, 0, 0, w, h)
            val packed = ByteArray((w * h + 1) / 2)
            var i = 0
            while (i < pixels.size) {
                val a = nearest(pixels[i], palette)
                val b = if (i + 1 < pixels.size) nearest(pixels[i + 1], palette) else 0
                packed[i / 2] = ((a shl 4) or b).toByte()
                i += 2
            }
            return packed
        }

        private fun nearest(argb: Int, palette: IntArray): Int {
            val pr = Color.red(argb); val pg = Color.green(argb); val pb = Color.blue(argb)
            var bestIdx = 0
            var bestD = Int.MAX_VALUE
            for (i in palette.indices) {
                val c = palette[i]
                val dr = ((c shr 16) and 0xFF) - pr
                val dg = ((c shr 8) and 0xFF) - pg
                val db = (c and 0xFF) - pb
                val d = dr * dr + dg * dg + db * db
                if (d < bestD) { bestD = d; bestIdx = i }
            }
            return bestIdx
        }
    }
}
