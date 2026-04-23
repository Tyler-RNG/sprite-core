import Foundation

/// Platform-independent playback engine. One instance per character per mode.
/// Drives `currentRef` forward over time according to the `AnimationGraph`'s
/// animations and transitions; callers materialize frames via their own
/// `FrameSource`.
///
/// Mirrors the Kotlin `SpriteAnimationPlayer` and the TS `SpriteAnimationPlayer`.
/// Observability is via `AsyncStream<FrameRef?>` and `AsyncStream<String>` — a
/// SwiftUI consumer can also read the latest synchronous values through
/// `currentRef` / `currentState`.
public actor SpriteAnimationPlayer {
    private let graph: AnimationGraph
    private let ticker: Ticker
    private let minFrameDelayMs = 16

    private var _currentRef: FrameRef?
    private var _currentState: String
    private var refContinuations: [UUID: AsyncStream<FrameRef?>.Continuation] = [:]
    private var stateContinuations: [UUID: AsyncStream<String>.Continuation] = [:]

    private var runningTask: Task<Void, Never>?

    public init(graph: AnimationGraph, ticker: Ticker = SystemTicker()) {
        self.graph = graph
        self.ticker = ticker
        self._currentState = graph.defaultState
        // Kick off default-state playback on actor init. Use a detached Task
        // because the actor isn't fully initialized until this init returns.
        Task { [weak self] in
            await self?.startDefaultState()
        }
    }

    // MARK: - Public surface

    public var currentRef: FrameRef? { _currentRef }
    public var currentState: String { _currentState }

    public func refStream() -> AsyncStream<FrameRef?> {
        AsyncStream { continuation in
            let id = UUID()
            continuation.yield(_currentRef)
            refContinuations[id] = continuation
            continuation.onTermination = { [weak self] _ in
                Task { await self?.removeRefContinuation(id) }
            }
        }
    }

    public func stateStream() -> AsyncStream<String> {
        AsyncStream { continuation in
            let id = UUID()
            continuation.yield(_currentState)
            stateContinuations[id] = continuation
            continuation.onTermination = { [weak self] _ in
                Task { await self?.removeStateContinuation(id) }
            }
        }
    }

    /// Request a state change. If the graph's transitions table has a match
    /// for `currentState → target`, that transition plays once before the
    /// target state's own loop starts.
    ///
    /// `playCount` semantics (from `<<<state-N>>>`):
    ///   - nil or 0 — loop indefinitely
    ///   - N >= 1   — play N times and hold last frame
    public func requestState(_ target: String, playCount: Int? = nil) async {
        let previousState = _currentState
        let sameState = target == previousState
        let effectiveCount: Int? = (playCount ?? 0) >= 1 ? playCount : nil

        await cancelRunning()

        if sameState && effectiveCount == nil {
            return
        }

        let task = Task { [weak self] in
            guard let self else { return }
            if !sameState {
                if case let .phase(ref) = await self.graph.resolveTransition(from: previousState, to: target) ?? .phase("") {
                    if !ref.isEmpty {
                        let resolved = ResolvedTransition.parse(ref)
                        await self.playPhase(animName: resolved.animation, phase: resolved.phase, loopOverride: .once)
                    }
                }
            }
            await self.playState(target, entering: !sameState, playCountOverride: effectiveCount)
        }
        runningTask = task
    }

    public func dispose() async {
        await cancelRunning()
        for (_, c) in refContinuations { c.finish() }
        for (_, c) in stateContinuations { c.finish() }
        refContinuations.removeAll()
        stateContinuations.removeAll()
    }

    // MARK: - Internals

    private func removeRefContinuation(_ id: UUID) {
        refContinuations.removeValue(forKey: id)
    }

    private func removeStateContinuation(_ id: UUID) {
        stateContinuations.removeValue(forKey: id)
    }

    private func startDefaultState() async {
        let task = Task { [weak self] in
            guard let self else { return }
            await self.playState(await self.graph.defaultState, entering: true, playCountOverride: nil)
        }
        runningTask = task
    }

    private func cancelRunning() async {
        runningTask?.cancel()
        runningTask = nil
    }

    private func setRef(_ ref: FrameRef?) {
        _currentRef = ref
        for (_, c) in refContinuations { c.yield(ref) }
    }

    private func setState(_ state: String) {
        if _currentState != state {
            _currentState = state
            for (_, c) in stateContinuations { c.yield(state) }
        }
    }

    private func playState(_ state: String, entering: Bool, playCountOverride: Int?) async {
        setState(state)
        guard let anim = graph.animations[state] else { return }
        if entering, anim.intro != nil {
            await playPhase(animName: state, phase: .intro, loopOverride: nil)
            if Task.isCancelled { return }
        }
        if let count = playCountOverride, count >= 1 {
            await playPhaseFinite(animName: state, phase: .loop, times: count)
            return
        }
        await playPhase(animName: state, phase: .loop, loopOverride: nil)
    }

    private func playPhaseFinite(animName: String, phase: Phase, times: Int) async {
        guard let anim = graph.animations[animName], let seq = pickPhase(anim, phase), !seq.frames.isEmpty else { return }
        let frameDelayMs = max(1000 / seq.fps, minFrameDelayMs)
        for _ in 0..<times {
            for ref in seq.frames {
                if Task.isCancelled { return }
                setRef(ref)
                do { try await ticker.delay(ms: frameDelayMs) } catch { return }
            }
        }
        if let last = seq.frames.last { setRef(last) }
        // Hold indefinitely until cancelled.
        while !Task.isCancelled {
            do { try await ticker.delay(ms: 1000) } catch { return }
        }
    }

    private func playPhase(animName: String, phase: Phase, loopOverride: LoopMode?) async {
        guard let anim = graph.animations[animName], let seq = pickPhase(anim, phase), !seq.frames.isEmpty else { return }
        let frameDelayMs = max(1000 / seq.fps, minFrameDelayMs)
        let loop = loopOverride ?? seq.loop

        switch loop {
        case .once:
            for ref in seq.frames {
                if Task.isCancelled { return }
                setRef(ref)
                do { try await ticker.delay(ms: frameDelayMs) } catch { return }
            }
            if !seq.holdLastFrame { setRef(nil) }
        case .pingPong:
            let cap = seq.iterations ?? .max
            var rounds = 0
            while rounds < cap, !Task.isCancelled {
                for ref in seq.frames {
                    if Task.isCancelled { return }
                    setRef(ref)
                    do { try await ticker.delay(ms: frameDelayMs) } catch { return }
                }
                if seq.frames.count > 2 {
                    for i in stride(from: seq.frames.count - 2, through: 1, by: -1) {
                        if Task.isCancelled { return }
                        setRef(seq.frames[i])
                        do { try await ticker.delay(ms: frameDelayMs) } catch { return }
                    }
                }
                rounds += 1
            }
        case .infinite:
            while !Task.isCancelled {
                for ref in seq.frames {
                    if Task.isCancelled { return }
                    setRef(ref)
                    do { try await ticker.delay(ms: frameDelayMs) } catch { return }
                }
            }
        }
    }

    private func pickPhase(_ anim: Animation, _ phase: Phase) -> FrameSequence? {
        switch phase {
        case .intro: return anim.intro
        case .outro: return anim.outro
        case .loop:  return anim.effectiveLoop
        }
    }
}
