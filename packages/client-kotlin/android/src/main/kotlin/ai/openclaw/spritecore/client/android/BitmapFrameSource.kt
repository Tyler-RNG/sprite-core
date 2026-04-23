package ai.openclaw.spritecore.client.android

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import ai.openclaw.spritecore.client.FrameRef
import ai.openclaw.spritecore.client.FrameSource

/**
 * Bridges the pure-JVM client kit to the Android `Bitmap` world. Given a
 * [CharacterManifest] and the raw bytes for each `assets.refs` entry,
 * [BitmapFrameSource] resolves any [FrameRef] the player emits to a
 * concrete [Bitmap]:
 *
 * - **Sprite-style** frames reference a whole-image asset by key; the full
 *   decoded bitmap is returned.
 * - **Atlas-style** frames reference the atlas image and carry an
 *   `x/y/w/h` crop rect; the returned bitmap is a
 *   `createBitmap(src, x, y, w, h)` slice of the decoded atlas, cached per
 *   `(ref, rect)` pair.
 *
 * Parsing + ready-check helpers live on the pure-JVM core
 * ([ai.openclaw.spritecore.client.CharacterManifestJson],
 * [ai.openclaw.spritecore.client.characterManifestBytesReady]).
 */
class BitmapFrameSource(
    private val bytesByRef: Map<String, ByteArray>,
) : FrameSource<Bitmap> {
    private val decoded = mutableMapOf<String, Bitmap>()
    private val sliceCache = mutableMapOf<String, Bitmap>()

    override fun frame(ref: FrameRef): Bitmap? {
        val whole = decodedFor(ref.ref) ?: return null
        if (ref.x == null && ref.y == null && ref.w == null && ref.h == null) {
            return whole
        }
        val key = "${ref.ref}@${ref.x},${ref.y},${ref.w},${ref.h}"
        sliceCache[key]?.let { return it }
        val x = ref.x ?: 0
        val y = ref.y ?: 0
        val w = ref.w ?: (whole.width - x)
        val h = ref.h ?: (whole.height - y)
        if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > whole.width || y + h > whole.height) {
            Log.w(
                TAG,
                "slice out of bounds ref=${ref.ref} rect=($x,$y,$w,$h) size=(${whole.width},${whole.height})",
            )
            return null
        }
        return try {
            val slice = Bitmap.createBitmap(whole, x, y, w, h)
            sliceCache[key] = slice
            slice
        } catch (e: Throwable) {
            Log.w(TAG, "slice failed for $key", e)
            null
        }
    }

    private fun decodedFor(refKey: String): Bitmap? {
        decoded[refKey]?.let { return it }
        val bytes = bytesByRef[refKey] ?: return null
        return try {
            val bm = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            if (bm != null) decoded[refKey] = bm
            bm
        } catch (e: Throwable) {
            Log.w(TAG, "decode failed for $refKey", e)
            null
        }
    }

    companion object {
        private const val TAG = "BitmapFrameSource"
    }
}
