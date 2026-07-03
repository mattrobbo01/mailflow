import AVFoundation

/// Captures microphone audio with AVAudioEngine and streams it as
/// 16 kHz mono Float32 chunks — the format Parakeet expects.
/// Ported from LocalFlow's AudioRecorder, adapted from accumulate-then-return
/// to streaming chunks for live segmentation.
final class MicRecorder {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let onChunk: ([Float]) -> Void
    private(set) var isRecording = false

    static let targetSampleRate: Double = 16_000

    init(onChunk: @escaping ([Float]) -> Void) {
        self.onChunk = onChunk
    }

    static func authorizationStatus() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "authorized"
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .restricted: return "restricted"
        @unknown default: return "unknown"
        }
    }

    static func requestMicrophoneAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }

    func start() throws {
        guard !isRecording else { return }

        let input = engine.inputNode
        // NOTE: do not enable setVoiceProcessingEnabled here — on this
        // hardware it silently zeroes the captured buffers (bars flat,
        // empty transcripts). See LocalFlow's AudioRecorder.
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else {
            throw NSError(domain: "MeetingScribe", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "No microphone input available"])
        }

        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Self.targetSampleRate,
            channels: 1,
            interleaved: false
        ) else {
            throw NSError(domain: "MeetingScribe", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Could not create target audio format"])
        }

        converter = AVAudioConverter(from: inputFormat, to: targetFormat)

        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            self?.append(buffer: buffer, targetFormat: targetFormat)
        }

        engine.prepare()
        try engine.start()
        isRecording = true
    }

    func stop() {
        guard isRecording else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRecording = false
        converter = nil
    }

    /// Called on the audio render thread: resample to 16 kHz mono and forward.
    private func append(buffer: AVAudioPCMBuffer, targetFormat: AVAudioFormat) {
        guard let converter else { return }

        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
        guard let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity)
        else { return }

        var fed = false
        var error: NSError?
        converter.convert(to: converted, error: &error) { _, outStatus in
            if fed {
                outStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard error == nil, converted.frameLength > 0,
              let channel = converted.floatChannelData?[0]
        else { return }

        let chunk = Array(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
        onChunk(chunk)
    }
}
