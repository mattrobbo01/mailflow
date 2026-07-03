import Foundation

/// Simple energy-based voice activity detection, in the spirit of LocalFlow's
/// per-utterance capture: an utterance starts when frame RMS crosses a
/// threshold and ends after a sustained silence gap. Feeds complete
/// utterances (with a little pre-roll so onsets aren't clipped) to a callback.
///
/// Not thread-safe by design — each capture channel owns one segmenter and
/// feeds it from its single audio callback thread.
final class UtteranceSegmenter {
    struct Utterance {
        let t0: Double        // seconds since capture start
        let t1: Double
        let samples: [Float]  // 16 kHz mono
    }

    static let sampleRate: Double = 16_000

    // Tuning — frames are 32 ms.
    private let frameSize = 512
    private let startThreshold: Float = 0.015   // RMS to open an utterance
    private let endThreshold: Float = 0.008     // RMS considered silence
    private let hangoverFrames = 25             // ~0.8 s of silence ends it
    private let preRollFrames = 8               // ~0.26 s kept before onset
    private let minSpeechFrames = 8             // utterances under ~0.26 s of speech are dropped
    private let maxUtteranceSamples = 16_000 * 30  // force a cut at 30 s

    private let onUtterance: (Utterance) -> Void

    private var pending: [Float] = []       // partial frame carry-over
    private var absSamples = 0              // total samples consumed (frame-aligned)
    private var preRoll: [[Float]] = []
    private var inSpeech = false
    private var current: [Float] = []
    private var currentStartSample = 0
    private var silentFrames = 0
    private var speechFrames = 0

    init(onUtterance: @escaping (Utterance) -> Void) {
        self.onUtterance = onUtterance
    }

    func append(_ chunk: [Float]) {
        pending.append(contentsOf: chunk)
        while pending.count >= frameSize {
            let frame = Array(pending.prefix(frameSize))
            pending.removeFirst(frameSize)
            process(frame: frame)
        }
    }

    /// Flush any in-progress utterance (capture is ending).
    func finish() {
        if !pending.isEmpty, inSpeech {
            current.append(contentsOf: pending)
        }
        pending.removeAll()
        if inSpeech {
            endUtterance()
        }
    }

    private func process(frame: [Float]) {
        var sumSquares: Float = 0
        for sample in frame { sumSquares += sample * sample }
        let rms = (sumSquares / Float(frame.count)).squareRoot()

        if !inSpeech {
            preRoll.append(frame)
            if preRoll.count > preRollFrames { preRoll.removeFirst() }
            if rms > startThreshold {
                inSpeech = true
                current = preRoll.flatMap { $0 }
                currentStartSample = absSamples + frameSize - current.count
                preRoll.removeAll()
                silentFrames = 0
                speechFrames = 1
            }
        } else {
            current.append(contentsOf: frame)
            if rms < endThreshold {
                silentFrames += 1
            } else {
                silentFrames = 0
                if rms > startThreshold { speechFrames += 1 }
            }
            if silentFrames >= hangoverFrames || current.count >= maxUtteranceSamples {
                endUtterance()
            }
        }
        absSamples += frameSize
    }

    private func endUtterance() {
        defer {
            inSpeech = false
            current = []
            silentFrames = 0
            speechFrames = 0
        }
        guard speechFrames >= minSpeechFrames else { return }

        // Trim most of the trailing hangover silence, keep ~0.2 s of tail.
        var samples = current
        let keepTailFrames = 6
        if silentFrames > keepTailFrames {
            let trim = (silentFrames - keepTailFrames) * frameSize
            if trim < samples.count { samples.removeLast(trim) }
        }

        let t0 = Double(currentStartSample) / Self.sampleRate
        let t1 = t0 + Double(samples.count) / Self.sampleRate
        onUtterance(Utterance(t0: t0, t1: t1, samples: samples))
    }
}
