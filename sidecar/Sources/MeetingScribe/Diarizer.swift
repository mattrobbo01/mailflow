import Foundation
import FluidAudio

/// Optional speaker labeling for the sys channel (pyannote segmentation +
/// WeSpeaker embeddings via FluidAudio CoreML, as in LocalFlow's VoiceFilter).
///
/// Per-utterance strategy: tile the utterance's samples to a full 10 s
/// analysis window (repeating the voice instead of zero-padding — LocalFlow
/// found zero-padded windows produce garbage embeddings), extract one
/// WeSpeaker embedding, and match it against running per-speaker centroids
/// by cosine distance. New voices get the next number: 1, 2, 3, …
///
/// Fail-open by design: if models are unavailable or an utterance can't be
/// embedded, segments simply go out without a "spk" field.
actor Diarizer {
    private struct KnownSpeaker {
        let number: Int
        var centroid: [Float]
        var utteranceCount: Int
    }

    /// Same scale as LocalFlow's voice-match threshold (cosine distance);
    /// slightly tighter here because we separate speakers rather than
    /// verify one enrolled voice.
    private let matchThreshold: Float = 0.55
    private let windowSamples = 160_000   // 10 s @ 16 kHz
    private let minSamples = 8_000        // 0.5 s of speech minimum to judge

    private var manager: DiarizerManager?
    private var speakers: [KnownSpeaker] = []

    /// Best-effort model load; returns whether diarization is available.
    @discardableResult
    func load() async -> Bool {
        guard manager == nil else { return true }
        do {
            let models = try await DiarizerModels.downloadIfNeeded()
            let manager = DiarizerManager()
            manager.initialize(models: models)
            self.manager = manager
            return true
        } catch {
            return false
        }
    }

    var isAvailable: Bool { manager != nil }

    /// Speaker label for one utterance of 16 kHz mono samples, as a stable
    /// small integer (1, 2, 3, …). Nil if diarization is unavailable or the
    /// utterance is too short to judge.
    func dominantSpeaker(in samples: [Float]) -> Int? {
        guard let manager, samples.count >= minSamples else { return nil }

        // Tile to a full analysis window so the embedding sees only this voice.
        var tiled = samples
        tiled.reserveCapacity(windowSamples)
        while tiled.count < windowSamples {
            tiled.append(contentsOf: samples.prefix(windowSamples - tiled.count))
        }
        if tiled.count > windowSamples { tiled = Array(tiled.prefix(windowSamples)) }

        guard let embedding = try? manager.extractSpeakerEmbedding(from: tiled) else { return nil }

        var bestIndex = -1
        var bestDistance = Float.greatestFiniteMagnitude
        for (index, speaker) in speakers.enumerated() {
            let distance = 1 - Self.cosineSimilarity(embedding, speaker.centroid)
            if distance < bestDistance {
                bestDistance = distance
                bestIndex = index
            }
        }

        if bestIndex >= 0, bestDistance < matchThreshold {
            // Fold this utterance into the running centroid.
            var speaker = speakers[bestIndex]
            let weight = Float(speaker.utteranceCount)
            for i in 0..<speaker.centroid.count where i < embedding.count {
                speaker.centroid[i] = (speaker.centroid[i] * weight + embedding[i]) / (weight + 1)
            }
            speaker.utteranceCount += 1
            speakers[bestIndex] = speaker
            return speaker.number
        }

        let number = speakers.count + 1
        speakers.append(KnownSpeaker(number: number, centroid: embedding, utteranceCount: 1))
        return number
    }

    private static func cosineSimilarity(_ a: [Float], _ b: [Float]) -> Float {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        var dot: Float = 0, normA: Float = 0, normB: Float = 0
        for i in 0..<a.count {
            dot += a[i] * b[i]
            normA += a[i] * a[i]
            normB += b[i] * b[i]
        }
        let denominator = normA.squareRoot() * normB.squareRoot()
        return denominator > 0 ? dot / denominator : 0
    }
}
