import Foundation

/// Pure-Swift mirror of the `CharacterManifest` wire schema served by the
/// gateway at `node.getCharacterManifest`. Zero platform deps beyond Foundation
/// so iOS, macOS, tvOS, watchOS, and Linux clients all decode the same bytes.
///
/// Source of truth lives in `schema/src/display.ts` at the repo root. This
/// Swift mirror must stay byte-compatible — the conformance suite in
/// `fixtures/` at the repo root enforces it.

public struct CharacterManifest: Codable, Sendable, Equatable {
    public let version: Int
    public let agentId: String
    public let name: String?
    public let modes: [String]
    public let stateMap: [String: String]
    public let content: [String: ModeContent]
    public let assets: AssetBundle
    public let emotions: [String: EmotionEntry]?

    public init(
        version: Int,
        agentId: String,
        name: String? = nil,
        modes: [String],
        stateMap: [String: String],
        content: [String: ModeContent],
        assets: AssetBundle,
        emotions: [String: EmotionEntry]? = nil
    ) {
        self.version = version
        self.agentId = agentId
        self.name = name
        self.modes = modes
        self.stateMap = stateMap
        self.content = content
        self.assets = assets
        self.emotions = emotions
    }
}

public struct ModeContent: Codable, Sendable, Equatable {
    public let atlas: AtlasRef?
    public let animations: [String: Animation]
    public let transitions: [String: TransitionRef]?

    public init(atlas: AtlasRef? = nil, animations: [String: Animation], transitions: [String: TransitionRef]? = nil) {
        self.atlas = atlas
        self.animations = animations
        self.transitions = transitions
    }
}

public struct AtlasRef: Codable, Sendable, Equatable {
    public let image: String
    public let size: Size
    public let frameSize: Size?

    public init(image: String, size: Size, frameSize: Size? = nil) {
        self.image = image
        self.size = size
        self.frameSize = frameSize
    }
}

public struct Size: Codable, Sendable, Equatable {
    public let w: Int
    public let h: Int
    public init(w: Int, h: Int) { self.w = w; self.h = h }
}

public struct FrameRef: Codable, Sendable, Equatable, Hashable {
    public let ref: String
    public let x: Int?
    public let y: Int?
    public let w: Int?
    public let h: Int?

    public init(ref: String, x: Int? = nil, y: Int? = nil, w: Int? = nil, h: Int? = nil) {
        self.ref = ref
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }
}

public enum LoopMode: String, Codable, Sendable {
    case infinite
    case once
    case pingPong = "ping-pong"
}

public struct FrameSequence: Codable, Sendable, Equatable {
    public let frames: [FrameRef]
    public let fps: Int
    public let loop: LoopMode
    public let holdLastFrame: Bool
    public let iterations: Int?

    public init(frames: [FrameRef], fps: Int, loop: LoopMode, holdLastFrame: Bool = false, iterations: Int? = nil) {
        self.frames = frames
        self.fps = fps
        self.loop = loop
        self.holdLastFrame = holdLastFrame
        self.iterations = iterations
    }

    private enum CodingKeys: String, CodingKey {
        case frames, fps, loop, holdLastFrame, iterations
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.frames = try c.decode([FrameRef].self, forKey: .frames)
        self.fps = try c.decode(Int.self, forKey: .fps)
        self.loop = try c.decode(LoopMode.self, forKey: .loop)
        self.holdLastFrame = try c.decodeIfPresent(Bool.self, forKey: .holdLastFrame) ?? false
        self.iterations = try c.decodeIfPresent(Int.self, forKey: .iterations)
    }
}

public struct Animation: Codable, Sendable, Equatable {
    public let description: String?
    public let sequence: FrameSequence?
    public let intro: FrameSequence?
    public let loop: FrameSequence?
    public let outro: FrameSequence?

    public init(
        description: String? = nil,
        sequence: FrameSequence? = nil,
        intro: FrameSequence? = nil,
        loop: FrameSequence? = nil,
        outro: FrameSequence? = nil
    ) {
        self.description = description
        self.sequence = sequence
        self.intro = intro
        self.loop = loop
        self.outro = outro
    }

    /// Treat a flat sequence as the `loop` phase so the player can always
    /// look up phases by name without special-casing flat vs phased.
    public var effectiveLoop: FrameSequence? { loop ?? sequence }
}

/// Transition target: either a named phase reference (e.g. `"thinking.intro"`)
/// played once on swap, or an inline blend directive the runtime applies as a
/// visual effect during the swap.
public enum TransitionRef: Codable, Sendable, Equatable {
    case phase(String)
    case crossfade(ms: Int)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let s = try? container.decode(String.self) {
            self = .phase(s)
            return
        }
        struct Blend: Codable { let blend: String; let ms: Int }
        let b = try container.decode(Blend.self)
        self = .crossfade(ms: b.ms)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .phase(let s):
            try c.encode(s)
        case .crossfade(let ms):
            struct Blend: Codable { let blend: String; let ms: Int }
            try c.encode(Blend(blend: "crossfade", ms: ms))
        }
    }
}

public struct AssetBundle: Codable, Sendable, Equatable {
    public let refs: [String: String]
    public init(refs: [String: String]) { self.refs = refs }

    /// Look up the asset path for a frame ref. Returns nil if the ref is unknown.
    public func path(for ref: FrameRef) -> String? { refs[ref.ref] }
}

public struct EmotionEntry: Codable, Sendable, Equatable {
    public let directive: EmotionDirective?
    public init(directive: EmotionDirective? = nil) { self.directive = directive }
}

public struct EmotionDirective: Codable, Sendable, Equatable {
    public let voiceId: String?
    public let stability: Double?
    public let similarity: Double?
    public let style: Double?
    public let speakerBoost: Bool?
    public let speed: Double?
    public let audioTag: String?

    public init(
        voiceId: String? = nil,
        stability: Double? = nil,
        similarity: Double? = nil,
        style: Double? = nil,
        speakerBoost: Bool? = nil,
        speed: Double? = nil,
        audioTag: String? = nil
    ) {
        self.voiceId = voiceId
        self.stability = stability
        self.similarity = similarity
        self.style = style
        self.speakerBoost = speakerBoost
        self.speed = speed
        self.audioTag = audioTag
    }
}

public struct CharacterManifestEnvelope: Codable, Sendable, Equatable {
    public let manifest: CharacterManifest
    public let revision: Int
    public init(manifest: CharacterManifest, revision: Int) {
        self.manifest = manifest
        self.revision = revision
    }
}

/// JSON parser for the envelope published by `node.getCharacterManifest`.
public enum CharacterManifestJson {
    public static func parse(_ data: Data) -> CharacterManifestEnvelope? {
        try? JSONDecoder().decode(CharacterManifestEnvelope.self, from: data)
    }

    public static func parse(_ text: String) -> CharacterManifestEnvelope? {
        guard let data = text.data(using: .utf8) else { return nil }
        return parse(data)
    }

    /// Pick the first mode in `manifest.modes` whose content is present.
    public static func pickMode(_ manifest: CharacterManifest) -> String? {
        manifest.modes.first { manifest.content[$0] != nil }
    }
}

/// Returns true when every asset ref declared by `envelope.manifest.assets.refs`
/// has bytes in `assetBytes`. Empty refs returns true.
public func characterManifestBytesReady(
    envelope: CharacterManifestEnvelope,
    assetBytes: [String: Data]
) -> Bool {
    let refs = envelope.manifest.assets.refs.keys
    if refs.isEmpty { return true }
    return refs.allSatisfy { assetBytes[$0] != nil }
}
