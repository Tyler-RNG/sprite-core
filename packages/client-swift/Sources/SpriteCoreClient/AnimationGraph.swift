import Foundation

/// Resolved animation table + transition graph for a single mode of a single
/// character. Both sprite and atlas manifests project into this shape so the
/// player stays format-agnostic.
public struct AnimationGraph: Sendable {
    public let defaultState: String
    public let animations: [String: Animation]
    public let transitions: [String: TransitionRef]

    public init(defaultState: String, animations: [String: Animation], transitions: [String: TransitionRef]) {
        self.defaultState = defaultState
        self.animations = animations
        self.transitions = transitions
    }

    /// Resolve a state→state transition against the transitions table using
    /// wildcard pattern matching. Specificity order (most→least specific):
    ///
    ///   `"<from>-><to>"` → `"<from>->*"` → `"*-><to>"` → `"*->*"`
    ///
    /// Returns nil when nothing matches.
    public func resolveTransition(from: String, to: String) -> TransitionRef? {
        let keys = ["\(from)->\(to)", "\(from)->*", "*->\(to)", "*->*"]
        for k in keys {
            if let t = transitions[k] { return t }
        }
        return nil
    }

    /// Extract a single mode's animation graph from a character manifest.
    public static func fromManifest(_ manifest: CharacterManifest, mode: String) throws -> AnimationGraph {
        guard let content = manifest.content[mode] else {
            throw GraphError.modeNotFound(mode: mode, available: Array(manifest.content.keys))
        }
        let defaultState = try resolveDefaultState(stateMap: manifest.stateMap, animations: content.animations)
        return AnimationGraph(
            defaultState: defaultState,
            animations: content.animations,
            transitions: content.transitions ?? [:]
        )
    }
}

public enum GraphError: Error, CustomStringConvertible {
    case modeNotFound(mode: String, available: [String])
    case noAnimations

    public var description: String {
        switch self {
        case .modeNotFound(let mode, let available):
            return "manifest has no content for mode '\(mode)'. Available: \(available)"
        case .noAnimations:
            return "manifest mode has no animations"
        }
    }
}

private func resolveDefaultState(stateMap: [String: String], animations: [String: Animation]) throws -> String {
    for (_, animName) in stateMap {
        if animations[animName] != nil { return animName }
    }
    if let first = animations.keys.first { return first }
    throw GraphError.noAnimations
}

/// The three phases of a phased animation; flat animations use `.loop`.
public enum Phase: String, Sendable {
    case intro
    case loop
    case outro
}

/// A transition target resolved for playback: which animation + phase to
/// play once before entering the target state's own loop.
public struct ResolvedTransition: Sendable {
    public let animation: String
    public let phase: Phase

    /// Parse `"thinking.intro"` → `(thinking, .intro)`. Unqualified → `.loop`.
    public static func parse(_ ref: String) -> ResolvedTransition {
        if let dot = ref.firstIndex(of: ".") {
            let phase = Phase(rawValue: String(ref[ref.index(after: dot)...])) ?? .loop
            return ResolvedTransition(animation: String(ref[..<dot]), phase: phase)
        }
        return ResolvedTransition(animation: ref, phase: .loop)
    }
}
