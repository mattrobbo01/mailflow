import AVFoundation
import Foundation

// MARK: - meetingscribe
//
// Headless meeting-transcription sidecar for MailFlow. Captures the user's
// mic and the system audio mixdown (remote participants) as two channels,
// segments each with energy VAD, transcribes utterances with Parakeet
// (FluidAudio CoreML), and emits JSON Lines on stdout:
//
//   {"t":"ready"}                                    models loaded
//   {"t":"level","ch":"mic|sys","rms":0.12}          ~4/sec per channel
//   {"t":"seg","ch":"mic|sys","t0":1.2,"t1":3.4,"text":"...","spk":N?}
//   {"t":"error","message":"..."}
//   {"t":"stopped"}
//
// Commands:
//   meetingscribe start                  capture until "stop\n" on stdin,
//                                        stdin EOF, SIGINT, or SIGTERM
//   meetingscribe probe                  one-line JSON diagnostics
//   meetingscribe transcribe-file <wav>  offline pipeline test

// MARK: - Helpers

/// One utterance waiting for transcription.
struct PendingUtterance: Sendable {
    let channel: Channel
    let t0: Double
    let t1: Double
    let samples: [Float]
}

/// Per-channel RMS level events, throttled to ~4/sec.
final class LevelMeter: @unchecked Sendable {
    private let lock = NSLock()
    private var lastEmit: [Channel: TimeInterval] = [:]

    func tick(_ channel: Channel, chunk: [Float]) {
        guard !chunk.isEmpty else { return }
        let now = ProcessInfo.processInfo.systemUptime
        lock.lock()
        if let last = lastEmit[channel], now - last < 0.25 {
            lock.unlock()
            return
        }
        lastEmit[channel] = now
        lock.unlock()

        var sumSquares: Float = 0
        for sample in chunk { sumSquares += sample * sample }
        Emitter.level(channel, rms: (sumSquares / Float(chunk.count)).squareRoot())
    }
}

/// Single-fire gate the main task parks on until stop is requested
/// (stdin "stop", stdin EOF, SIGINT, or SIGTERM).
final class StopGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    private var fired = false

    func wait() async {
        await withCheckedContinuation { newContinuation in
            lock.lock()
            if fired {
                lock.unlock()
                newContinuation.resume()
            } else {
                continuation = newContinuation
                lock.unlock()
            }
        }
    }

    func fire() {
        lock.lock()
        let pending = continuation
        continuation = nil
        let alreadyFired = fired
        fired = true
        lock.unlock()
        if !alreadyFired { pending?.resume() }
    }
}

/// Load any AVFoundation-readable audio file as 16 kHz mono Float32.
func loadAudio16kMono(path: String) throws -> [Float] {
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    let sourceFormat = file.processingFormat
    guard let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false),
        let converter = AVAudioConverter(from: sourceFormat, to: targetFormat)
    else {
        throw NSError(domain: "MeetingScribe", code: 4, userInfo: [
            NSLocalizedDescriptionKey: "Could not build converter for \(path)"])
    }

    let readCapacity: AVAudioFrameCount = 32_768
    guard let inBuffer = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: readCapacity)
    else {
        throw NSError(domain: "MeetingScribe", code: 5, userInfo: [
            NSLocalizedDescriptionKey: "Could not allocate read buffer"])
    }

    var samples: [Float] = []
    var reachedEnd = false
    while true {
        inBuffer.frameLength = 0
        // Note: reading at EOF throws on modern macOS instead of returning
        // zero frames, so gate on framePosition rather than read-until-empty.
        if file.framePosition < file.length {
            try file.read(into: inBuffer, frameCount: readCapacity)
        }
        if inBuffer.frameLength == 0 || file.framePosition >= file.length { reachedEnd = true }

        let ratio = targetFormat.sampleRate / sourceFormat.sampleRate
        let capacity = max(AVAudioFrameCount(Double(inBuffer.frameLength) * ratio) + 1024, 1024)
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity)
        else { break }

        var fed = false
        var conversionError: NSError?
        let status = converter.convert(to: outBuffer, error: &conversionError) { _, outStatus in
            if !fed, inBuffer.frameLength > 0 {
                fed = true
                outStatus.pointee = .haveData
                return inBuffer
            }
            outStatus.pointee = reachedEnd ? .endOfStream : .noDataNow
            return nil
        }
        if let conversionError { throw conversionError }
        if outBuffer.frameLength > 0, let channelData = outBuffer.floatChannelData?[0] {
            samples.append(contentsOf:
                UnsafeBufferPointer(start: channelData, count: Int(outBuffer.frameLength)))
        }
        if status == .endOfStream || (reachedEnd && outBuffer.frameLength == 0) { break }
    }
    return samples
}

func printUsageAndExit() -> Never {
    FileHandle.standardError.write(Data("""
    usage: meetingscribe <command>
      start                   capture mic + system audio, JSONL on stdout;
                              send "stop\\n" on stdin (or SIGTERM) to end
      probe                   print one-line JSON diagnostics and exit
      transcribe-file <path>  run an audio file through the ASR pipeline

    """.utf8))
    exit(2)
}

// MARK: - probe

func runProbe() async {
    let fileManager = FileManager.default
    let modelsRoot = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)
        .first!.appendingPathComponent("FluidAudio/Models")

    func modelPresent(_ name: String) -> Bool {
        let contents = try? fileManager.contentsOfDirectory(
            atPath: modelsRoot.appendingPathComponent(name).path)
        return (contents?.count ?? 0) > 0
    }

    let tap = SystemAudioTap.probeTapCreation()
    Emitter.probe([
        "models": [
            "asr": modelPresent("parakeet-tdt-0.6b-v3"),
            "diarizer": modelPresent("speaker-diarization"),
        ],
        "micPermission": MicRecorder.authorizationStatus(),
        "systemAudioTap": ["ok": tap.ok, "status": Int(tap.status)],
    ])
    exit(0)
}

// MARK: - transcribe-file

func runTranscribeFile(_ path: String) async {
    guard FileManager.default.fileExists(atPath: path) else {
        Emitter.error("no such file: \(path)")
        exit(1)
    }

    let engine = TranscriptionEngine()
    await engine.load()
    if case .failed(let message) = await engine.state {
        Emitter.error("speech model failed to load: \(message)")
        exit(1)
    }

    // MEETINGSCRIBE_DIARIZE=1 exercises the sys-channel speaker labeling
    // in this offline mode too (diagnostics for the pyannote pipeline).
    var diarizer: Diarizer?
    if ProcessInfo.processInfo.environment["MEETINGSCRIBE_DIARIZE"] == "1" {
        let loaded = Diarizer()
        if await loaded.load() {
            diarizer = loaded
        } else {
            Emitter.error("diarization models failed to load; continuing without")
        }
    }
    Emitter.ready()

    do {
        let samples = try loadAudio16kMono(path: path)

        var utterances: [UtteranceSegmenter.Utterance] = []
        let segmenter = UtteranceSegmenter { utterances.append($0) }
        segmenter.append(samples)
        segmenter.finish()

        // Quiet or continuous audio the VAD didn't split: one whole-file segment.
        if utterances.isEmpty, !samples.isEmpty {
            utterances = [UtteranceSegmenter.Utterance(
                t0: 0,
                t1: Double(samples.count) / UtteranceSegmenter.sampleRate,
                samples: samples)]
        }

        for utterance in utterances {
            let result = try await engine.transcribe(utterance.samples)
            let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            let speaker = await diarizer?.dominantSpeaker(in: utterance.samples)
            Emitter.seg(.file, t0: utterance.t0, t1: utterance.t1, text: text, spk: speaker)
        }
        Emitter.stopped()
        exit(0)
    } catch {
        Emitter.error(error.localizedDescription)
        exit(1)
    }
}

// MARK: - start (live capture)

func runStart() async {
    let engine = TranscriptionEngine()
    let diarizer = Diarizer()

    async let diarizerReady = diarizer.load()  // best effort, cached models
    await engine.load()
    if case .failed(let message) = await engine.state {
        Emitter.error("speech model failed to load: \(message)")
        exit(1)
    }
    _ = await diarizerReady

    // Utterances flow from the capture callbacks through the segmenters into
    // this stream; a single consumer task transcribes them in order.
    var utteranceContinuation: AsyncStream<PendingUtterance>.Continuation!
    let utterances = AsyncStream<PendingUtterance> { utteranceContinuation = $0 }
    let yield: @Sendable (PendingUtterance) -> Void = { [utteranceContinuation] in
        utteranceContinuation!.yield($0)
    }

    let micSegmenter = UtteranceSegmenter { utterance in
        yield(PendingUtterance(
            channel: .mic, t0: utterance.t0, t1: utterance.t1, samples: utterance.samples))
    }
    let sysSegmenter = UtteranceSegmenter { utterance in
        yield(PendingUtterance(
            channel: .sys, t0: utterance.t0, t1: utterance.t1, samples: utterance.samples))
    }

    let meter = LevelMeter()
    let mic = MicRecorder { chunk in
        meter.tick(.mic, chunk: chunk)
        micSegmenter.append(chunk)
    }
    let sysTap = SystemAudioTap { chunk in
        meter.tick(.sys, chunk: chunk)
        sysSegmenter.append(chunk)
    }

    var micRunning = false
    var sysRunning = false

    if await MicRecorder.requestMicrophoneAccess() {
        do {
            try mic.start()
            micRunning = true
        } catch {
            Emitter.error("mic capture failed: \(error.localizedDescription)")
        }
    } else {
        Emitter.error("microphone permission not granted (state: \(MicRecorder.authorizationStatus()))")
    }

    do {
        try sysTap.start()
        sysRunning = true
    } catch {
        Emitter.error("system audio tap failed: \(error.localizedDescription)")
    }

    guard micRunning || sysRunning else {
        Emitter.error("no audio channels available; exiting")
        exit(1)
    }
    Emitter.ready()

    let consumer = Task {
        for await pending in utterances {
            do {
                let result = try await engine.transcribe(pending.samples)
                let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                var speaker: Int?
                if pending.channel == .sys {
                    speaker = await diarizer.dominantSpeaker(in: pending.samples)
                }
                Emitter.seg(
                    pending.channel, t0: pending.t0, t1: pending.t1, text: text, spk: speaker)
            } catch {
                Emitter.error("transcription failed: \(error.localizedDescription)")
            }
        }
    }

    // Stop on "stop\n", stdin EOF (parent died), SIGINT, or SIGTERM.
    let gate = StopGate()
    Thread.detachNewThread {
        while let line = readLine(strippingNewline: true) {
            if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
        }
        gate.fire()
    }
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    let signalSources = [SIGINT, SIGTERM].map { number in
        let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
        source.setEventHandler { gate.fire() }
        source.resume()
        return source
    }
    defer { signalSources.forEach { $0.cancel() } }

    await gate.wait()

    // Graceful teardown: stop capture, flush in-flight utterances, drain queue.
    if micRunning { mic.stop() }
    if sysRunning { sysTap.stop() }
    micSegmenter.finish()
    sysSegmenter.finish()
    utteranceContinuation.finish()
    await consumer.value

    Emitter.stopped()
    exit(0)
}

// MARK: - entry point

let arguments = CommandLine.arguments
switch arguments.count > 1 ? arguments[1] : "" {
case "start":
    await runStart()
case "probe":
    await runProbe()
case "transcribe-file":
    guard arguments.count > 2 else { printUsageAndExit() }
    await runTranscribeFile(arguments[2])
default:
    printUsageAndExit()
}
