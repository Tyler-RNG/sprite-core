import Foundation
#if canImport(ImageIO)
import ImageIO
import CoreGraphics

/// `FrameSource` over `CGImage` that mirrors Kotlin's `BitmapFrameSource`:
/// decodes per-ref bytes lazily via ImageIO, and honors atlas crop rects on
/// `FrameRef` through `CGImage.cropping(to:)`. Whole-image refs return the
/// decoded source unchanged. Slices are cached per `(ref, rect)` pair.
///
/// Cross-Apple-platform — depends only on `ImageIO` + `CoreGraphics`, both
/// available on iOS, macOS, tvOS, and watchOS.
public final class CGImageFrameSource: FrameSource, @unchecked Sendable {
    public typealias Frame = CGImage

    private let bytesByRef: [String: Data]
    private var decoded: [String: CGImage] = [:]
    private var sliceCache: [String: CGImage] = [:]
    private let lock = NSLock()

    public init(bytesByRef: [String: Data]) {
        self.bytesByRef = bytesByRef
    }

    public func frame(for ref: FrameRef) -> CGImage? {
        lock.lock()
        defer { lock.unlock() }
        guard let whole = decodedFor(ref.ref) else { return nil }
        if ref.x == nil, ref.y == nil, ref.w == nil, ref.h == nil {
            return whole
        }
        let x = ref.x ?? 0
        let y = ref.y ?? 0
        let w = ref.w ?? (whole.width - x)
        let h = ref.h ?? (whole.height - y)
        guard w > 0, h > 0, x >= 0, y >= 0, x + w <= whole.width, y + h <= whole.height else {
            return nil
        }
        let key = "\(ref.ref)@\(x),\(y),\(w),\(h)"
        if let cached = sliceCache[key] { return cached }
        guard let slice = whole.cropping(to: CGRect(x: x, y: y, width: w, height: h)) else {
            return nil
        }
        sliceCache[key] = slice
        return slice
    }

    private func decodedFor(_ refKey: String) -> CGImage? {
        if let cached = decoded[refKey] { return cached }
        guard let bytes = bytesByRef[refKey] else { return nil }
        guard let src = CGImageSourceCreateWithData(bytes as CFData, nil) else { return nil }
        guard let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        decoded[refKey] = img
        return img
    }
}
#endif
