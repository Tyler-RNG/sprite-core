import Foundation

/// Streaming parser for `<<<state>>>` / `<<<state-N>>>` avatar-state markers
/// embedded in assistant text. Matching markers are stripped from the visible
/// text and surfaced separately; invalid marker shapes are treated as literal
/// text.
///
/// Mirrors the TS `createAvatarMarkerParser()` — the fixtures at the repo
/// root enforce byte-equivalent behaviour.

public let AVATAR_MARKER_OPEN = "<<<"
public let AVATAR_MARKER_CLOSE = ">>>"

public struct AvatarMarker: Equatable, Sendable {
    public let state: String
    /// `nil` for bare markers / zero-count; `N >= 1` for play-N-times markers.
    public let count: Int?
    public init(state: String, count: Int? = nil) {
        self.state = state
        self.count = count
    }
}

public struct AvatarMarkerParseResult: Equatable, Sendable {
    public let cleanedText: String
    public let markers: [AvatarMarker]
    public init(cleanedText: String, markers: [AvatarMarker]) {
        self.cleanedText = cleanedText
        self.markers = markers
    }
}

public struct TextSegmentWithEmotion: Equatable, Sendable {
    public let text: String
    public let emotion: String?
    public let emotionCount: Int?
    public init(text: String, emotion: String?, emotionCount: Int?) {
        self.text = text
        self.emotion = emotion
        self.emotionCount = emotionCount
    }
}

private let stateNameRegex = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]+$")

private func isValidStateName(_ name: String) -> Bool {
    if name.isEmpty { return false }
    let range = NSRange(location: 0, length: name.utf16.count)
    return stateNameRegex.firstMatch(in: name, options: [], range: range) != nil
}

/// Split a raw marker body into (state, count). Triggers on the *last* dash
/// when the suffix is a non-negative integer. Exported for test coverage.
public func resolveStateAndCount(_ body: String) -> (state: String, count: Int?) {
    guard let dashIdx = body.lastIndex(of: "-"), dashIdx != body.startIndex else {
        return (body, nil)
    }
    let after = body.index(after: dashIdx)
    guard after != body.endIndex else { return (body, nil) }
    let countPart = String(body[after...])
    guard Int(countPart) != nil, countPart.allSatisfy(\.isNumber) else {
        return (body, nil)
    }
    guard let count = Int(countPart), count >= 0 else { return (body, nil) }
    let state = String(body[..<dashIdx])
    if state.isEmpty { return (body, nil) }
    return (state, count)
}

public final class AvatarMarkerParser {
    private var buffer: String = ""

    public init() {}

    public func push(_ chunk: String) -> AvatarMarkerParseResult {
        if chunk.isEmpty { return AvatarMarkerParseResult(cleanedText: "", markers: []) }
        let combined = buffer + chunk
        let (cleaned, markers, remainder) = processSafePrefix(combined)
        buffer = remainder
        return AvatarMarkerParseResult(cleanedText: cleaned, markers: markers)
    }

    public func flush() -> AvatarMarkerParseResult {
        if buffer.isEmpty { return AvatarMarkerParseResult(cleanedText: "", markers: []) }
        let leftover = buffer
        buffer = ""
        return AvatarMarkerParseResult(cleanedText: leftover, markers: [])
    }

    public func reset() {
        buffer = ""
    }
}

/// Convenience: parse a complete (non-streamed) string in one shot.
public func parseAvatarMarkers(_ text: String) -> AvatarMarkerParseResult {
    let parser = AvatarMarkerParser()
    let a = parser.push(text)
    let b = parser.flush()
    return AvatarMarkerParseResult(
        cleanedText: a.cleanedText + b.cleanedText,
        markers: a.markers + b.markers
    )
}

/// Split `text` into segments delimited by `<<<state>>>` markers. Each segment
/// carries the preceding marker's state as its `emotion`.
public func splitByMarkers(_ text: String) -> [TextSegmentWithEmotion] {
    if text.isEmpty { return [] }
    var segments: [TextSegmentWithEmotion] = []
    var currentText = ""
    var currentEmotion: String? = nil
    var currentEmotionCount: Int? = nil
    var i = text.startIndex
    while i < text.endIndex {
        guard let openAt = text.range(of: AVATAR_MARKER_OPEN, range: i..<text.endIndex) else {
            currentText.append(contentsOf: text[i...])
            break
        }
        currentText.append(contentsOf: text[i..<openAt.lowerBound])
        guard let closeAt = text.range(of: AVATAR_MARKER_CLOSE, range: openAt.upperBound..<text.endIndex) else {
            currentText.append(contentsOf: text[openAt.lowerBound...])
            break
        }
        let rawBody = String(text[openAt.upperBound..<closeAt.lowerBound])
        if isValidStateName(rawBody) {
            let (state, count) = resolveStateAndCount(rawBody)
            if !currentText.isEmpty {
                segments.append(TextSegmentWithEmotion(
                    text: currentText,
                    emotion: currentEmotion,
                    emotionCount: currentEmotionCount
                ))
                currentText = ""
            }
            currentEmotion = state
            currentEmotionCount = count
        } else {
            currentText.append(contentsOf: text[openAt.lowerBound..<closeAt.upperBound])
        }
        i = closeAt.upperBound
    }
    if !currentText.isEmpty {
        segments.append(TextSegmentWithEmotion(
            text: currentText,
            emotion: currentEmotion,
            emotionCount: currentEmotionCount
        ))
    }
    return segments
}

// MARK: - Internals

private func processSafePrefix(_ combined: String) -> (cleanedText: String, markers: [AvatarMarker], remainder: String) {
    var markers: [AvatarMarker] = []
    var out = ""
    var i = combined.startIndex

    while i < combined.endIndex {
        guard let openRange = combined.range(of: AVATAR_MARKER_OPEN, range: i..<combined.endIndex) else {
            // No complete `<<<` left — buffer trailing `<` characters so the
            // next chunk can complete them.
            var j = combined.endIndex
            while j > i, combined[combined.index(before: j)] == "<" {
                j = combined.index(before: j)
            }
            out += combined[i..<j]
            return (out, markers, String(combined[j..<combined.endIndex]))
        }
        out += combined[i..<openRange.lowerBound]
        guard let closeRange = combined.range(of: AVATAR_MARKER_CLOSE, range: openRange.upperBound..<combined.endIndex) else {
            return (out, markers, String(combined[openRange.lowerBound..<combined.endIndex]))
        }
        let rawBody = String(combined[openRange.upperBound..<closeRange.lowerBound])
        if isValidStateName(rawBody) {
            let (state, count) = resolveStateAndCount(rawBody)
            markers.append(AvatarMarker(state: state, count: count))
        } else {
            out += combined[openRange.lowerBound..<closeRange.upperBound]
        }
        i = closeRange.upperBound
    }
    return (out, markers, "")
}
