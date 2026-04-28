import Foundation

/// Timing abstraction for frame advancement. The default implementation uses
/// `Task.sleep`; tests inject a fake ticker that advances virtual time.
public protocol Ticker: Sendable {
    func delay(ms: Int) async throws
}

public struct SystemTicker: Ticker {
    public init() {}
    public func delay(ms: Int) async throws {
        try await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
    }
}
