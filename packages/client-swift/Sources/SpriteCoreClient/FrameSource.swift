import Foundation

/// Platform-specific resolver from a `FrameRef` to a concrete renderable
/// (e.g. `UIImage`, `CGImage`, or raw bytes). The kit itself never constructs
/// frames — callers own the pixel pipeline and feed the player's emitted
/// `FrameRef` into their own `FrameSource` when rendering.
///
/// Atlas sources honor the optional `x/y/w/h` fields on `FrameRef`; sprite
/// sources ignore them and treat `ref` as the whole-image key.
public protocol FrameSource {
    associatedtype Frame
    func frame(for ref: FrameRef) -> Frame?
}

/// Simple in-memory sprite source: callers prime bytes per ref key, decode
/// happens lazily through the closure. Useful for tests + thin clients that
/// don't need a platform-specific image type.
public final class InMemorySpriteSource<Frame>: FrameSource, @unchecked Sendable {
    private let decode: (Data) -> Frame?
    private var bytesByRef: [String: Data] = [:]
    private var cache: [String: Frame] = [:]
    private let lock = NSLock()

    public init(decode: @escaping (Data) -> Frame?) {
        self.decode = decode
    }

    public func put(_ refKey: String, bytes: Data) {
        lock.lock()
        defer { lock.unlock() }
        bytesByRef[refKey] = bytes
        cache.removeValue(forKey: refKey)
    }

    public func keys() -> Set<String> {
        lock.lock()
        defer { lock.unlock() }
        return Set(bytesByRef.keys)
    }

    public func frame(for ref: FrameRef) -> Frame? {
        lock.lock()
        defer { lock.unlock() }
        if let cached = cache[ref.ref] { return cached }
        guard let bytes = bytesByRef[ref.ref] else { return nil }
        guard let decoded = decode(bytes) else { return nil }
        cache[ref.ref] = decoded
        return decoded
    }
}
