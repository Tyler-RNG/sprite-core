#if canImport(SwiftUI) && canImport(ImageIO)
import SwiftUI
import CoreGraphics

/// SwiftUI avatar that renders a `CharacterManifestEnvelope` through the
/// SpriteCore animation engine. Mirrors the Kotlin Compose `CharacterAvatar`
/// — one code path covers sprite, atlas, and flat states via
/// `AnimationGraph.fromManifest` + `SpriteAnimationPlayer`, with
/// `CGImageFrameSource` resolving the bytes.
///
/// Pass a `cgImageTransform` to apply a per-frame crop or filter — e.g. a
/// watchOS dial passing a top-half-square crop to extract a headshot from a
/// full-body sprite. Defaults to identity, so phone- and desktop-sized
/// avatars render the frame as authored.
///
/// Renders an empty (`Color.clear`) view when the manifest has no mode this
/// caller can render or when the first frame hasn't decoded yet; the caller's
/// fallback owns the empty state.
@available(iOS 15.0, macOS 12.0, tvOS 15.0, watchOS 8.0, *)
public struct CharacterAvatarView: View {
    private let agentId: String
    private let envelope: CharacterManifestEnvelope
    private let assetBytes: [String: Data]
    private let currentState: String?
    private let accessibilityLabel: String?
    private let contentMode: ContentMode
    private let cgImageTransform: (CGImage) -> CGImage
    private let playCount: Int?

    public init(
        agentId: String,
        envelope: CharacterManifestEnvelope,
        assetBytes: [String: Data],
        currentState: String?,
        accessibilityLabel: String? = nil,
        contentMode: ContentMode = .fill,
        cgImageTransform: @escaping (CGImage) -> CGImage = { $0 },
        playCount: Int? = nil
    ) {
        self.agentId = agentId
        self.envelope = envelope
        self.assetBytes = assetBytes
        self.currentState = currentState
        self.accessibilityLabel = accessibilityLabel
        self.contentMode = contentMode
        self.cgImageTransform = cgImageTransform
        self.playCount = playCount
    }

    public var body: some View {
        AvatarBody(
            envelope: envelope,
            assetBytes: assetBytes,
            currentState: currentState,
            playCount: playCount,
            accessibilityLabel: accessibilityLabel,
            contentMode: contentMode,
            cgImageTransform: cgImageTransform
        )
        // Reset the engine when the manifest revision changes — the driver
        // captures the envelope + bytes on init, so a new revision needs a
        // fresh driver.
        .id(AvatarIdentity(agentId: agentId, revision: envelope.revision))
    }
}

private struct AvatarIdentity: Hashable {
    let agentId: String
    let revision: Int
}

@available(iOS 15.0, macOS 12.0, tvOS 15.0, watchOS 8.0, *)
private struct AvatarBody: View {
    let envelope: CharacterManifestEnvelope
    let assetBytes: [String: Data]
    let currentState: String?
    let playCount: Int?
    let accessibilityLabel: String?
    let contentMode: ContentMode
    let cgImageTransform: (CGImage) -> CGImage

    @StateObject private var driver: AvatarDriver

    init(
        envelope: CharacterManifestEnvelope,
        assetBytes: [String: Data],
        currentState: String?,
        playCount: Int?,
        accessibilityLabel: String?,
        contentMode: ContentMode,
        cgImageTransform: @escaping (CGImage) -> CGImage
    ) {
        self.envelope = envelope
        self.assetBytes = assetBytes
        self.currentState = currentState
        self.playCount = playCount
        self.accessibilityLabel = accessibilityLabel
        self.contentMode = contentMode
        self.cgImageTransform = cgImageTransform
        _driver = StateObject(wrappedValue: AvatarDriver(envelope: envelope, assetBytes: assetBytes))
    }

    var body: some View {
        Group {
            if let cg = driver.currentImage.map(cgImageTransform) {
                Image(decorative: cg, scale: 1.0)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else {
                Color.clear
            }
        }
        .accessibilityLabel(accessibilityLabel ?? "")
        .onAppear {
            driver.requestState(currentState, playCount: playCount)
        }
        .onChange(of: currentState) { newValue in
            driver.requestState(newValue, playCount: playCount)
        }
        .onChange(of: playCount) { newValue in
            driver.requestState(currentState, playCount: newValue)
        }
        .onDisappear {
            driver.dispose()
        }
    }
}

@available(iOS 15.0, macOS 12.0, tvOS 15.0, watchOS 8.0, *)
@MainActor
private final class AvatarDriver: ObservableObject {
    @Published var currentImage: CGImage?

    private let player: SpriteAnimationPlayer?
    private let frameSource: CGImageFrameSource
    private let envelope: CharacterManifestEnvelope
    private let mode: String?
    private var refTask: Task<Void, Never>?

    init(envelope: CharacterManifestEnvelope, assetBytes: [String: Data]) {
        self.envelope = envelope
        self.frameSource = CGImageFrameSource(bytesByRef: assetBytes)
        let pickedMode = CharacterManifestJson.pickMode(envelope.manifest)
        self.mode = pickedMode
        if let pickedMode,
           let graph = try? AnimationGraph.fromManifest(envelope.manifest, mode: pickedMode) {
            self.player = SpriteAnimationPlayer(graph: graph)
        } else {
            self.player = nil
        }
        startRefStream()
    }

    private func startRefStream() {
        guard let player else { return }
        let frameSource = self.frameSource
        refTask = Task { [weak self] in
            for await ref in await player.refStream() {
                let image: CGImage? = ref.flatMap { frameSource.frame(for: $0) }
                await MainActor.run {
                    self?.currentImage = image
                }
            }
        }
    }

    func requestState(_ state: String?, playCount: Int?) {
        guard let player, let mode else { return }
        guard let stateName = state, !stateName.isEmpty else { return }
        let resolved = envelope.manifest.stateMap[stateName] ?? stateName
        guard envelope.manifest.content[mode]?.animations[resolved] != nil else { return }
        Task { await player.requestState(resolved, playCount: playCount) }
    }

    func dispose() {
        refTask?.cancel()
        refTask = nil
        if let player {
            Task { await player.dispose() }
        }
    }
}
#endif
