import AVFoundation
import CoreAudio
import Foundation

/// Captures system audio output — the remote side of a meeting — using a
/// Core Audio process tap (macOS 14.4+): a global mono mixdown of every
/// process's output, wired into a private aggregate device whose IOProc
/// hands us the tapped buffers. Streams 16 kHz mono Float32 chunks.
final class SystemAudioTap {
    private let onChunk: ([Float]) -> Void

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var tapFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?
    private let ioQueue = DispatchQueue(label: "meetingscribe.systap.io")
    private(set) var isRunning = false

    init(onChunk: @escaping ([Float]) -> Void) {
        self.onChunk = onChunk
    }

    deinit { stop() }

    func start() throws {
        guard !isRunning else { return }

        // 1. Global mono mixdown of all processes' output.
        let description = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        description.name = "MeetingScribe System Tap"
        description.muteBehavior = .unmuted   // meeting audio keeps playing
        description.isPrivate = true

        var newTapID = AudioObjectID(kAudioObjectUnknown)
        var status = AudioHardwareCreateProcessTap(description, &newTapID)
        guard status == noErr, newTapID != kAudioObjectUnknown else {
            throw Self.error("AudioHardwareCreateProcessTap failed", status)
        }
        tapID = newTapID

        do {
            // 2. The tap's stream format (typically mono Float32 at the device rate).
            var asbd = AudioStreamBasicDescription()
            var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
            var address = AudioObjectPropertyAddress(
                mSelector: kAudioTapPropertyFormat,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &asbd)
            guard status == noErr, let format = AVAudioFormat(streamDescription: &asbd) else {
                throw Self.error("could not read tap stream format", status)
            }
            tapFormat = format

            guard let target = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: 16_000,
                channels: 1,
                interleaved: false
            ) else {
                throw Self.error("could not create target audio format", -1)
            }
            targetFormat = target
            converter = AVAudioConverter(from: format, to: target)

            // 3. Private aggregate device that pulls from the tap. The default
            //    output device rides along as the clock master.
            let outputUID = try Self.defaultOutputDeviceUID()
            let aggregateDescription: [String: Any] = [
                kAudioAggregateDeviceNameKey: "MeetingScribe Tap",
                kAudioAggregateDeviceUIDKey: UUID().uuidString,
                kAudioAggregateDeviceMainSubDeviceKey: outputUID,
                kAudioAggregateDeviceIsPrivateKey: true,
                kAudioAggregateDeviceIsStackedKey: false,
                // Without auto-start the tap is attached but never begins
                // delivering — the IOProc fires once with silence and stalls.
                kAudioAggregateDeviceTapAutoStartKey: true,
                kAudioAggregateDeviceSubDeviceListKey: [
                    [kAudioSubDeviceUIDKey: outputUID]
                ],
                kAudioAggregateDeviceTapListKey: [
                    [
                        kAudioSubTapUIDKey: description.uuid.uuidString,
                        kAudioSubTapDriftCompensationKey: true,
                    ]
                ],
            ]
            var newAggregateID = AudioObjectID(kAudioObjectUnknown)
            status = AudioHardwareCreateAggregateDevice(
                aggregateDescription as CFDictionary, &newAggregateID)
            guard status == noErr, newAggregateID != kAudioObjectUnknown else {
                throw Self.error("AudioHardwareCreateAggregateDevice failed", status)
            }
            aggregateID = newAggregateID

            // 4. IOProc: input buffers carry the tapped system audio.
            status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, ioQueue) {
                [weak self] _, inInputData, _, _, _ in
                self?.handle(bufferList: inInputData)
            }
            guard status == noErr, ioProcID != nil else {
                throw Self.error("AudioDeviceCreateIOProcIDWithBlock failed", status)
            }

            status = AudioDeviceStart(aggregateID, ioProcID)
            guard status == noErr else {
                throw Self.error("AudioDeviceStart failed", status)
            }
            isRunning = true
        } catch {
            teardown()
            throw error
        }
    }

    func stop() {
        guard tapID != kAudioObjectUnknown || aggregateID != kAudioObjectUnknown else { return }
        teardown()
    }

    private func teardown() {
        if aggregateID != kAudioObjectUnknown {
            if let ioProcID {
                AudioDeviceStop(aggregateID, ioProcID)
                AudioDeviceDestroyIOProcID(aggregateID, ioProcID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        ioProcID = nil
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        converter = nil
        isRunning = false
    }

    /// Called on the IO queue: wrap the tap buffers, resample to 16 kHz mono, forward.
    private func handle(bufferList: UnsafePointer<AudioBufferList>) {
        guard let tapFormat, let targetFormat, let converter else { return }
        if ProcessInfo.processInfo.environment["MEETINGSCRIBE_DEBUG"] != nil {
            let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: bufferList))
            var summary = "[tap] buffers=\(list.count) fmt=\(tapFormat.sampleRate)Hz ch\(tapFormat.channelCount)"
            for (index, buffer) in list.enumerated() {
                let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
                var peak: Float = 0
                if let data = buffer.mData?.assumingMemoryBound(to: Float.self) {
                    for i in 0..<count { peak = max(peak, abs(data[i])) }
                }
                summary += " b\(index)[ch=\(buffer.mNumberChannels) n=\(count) peak=\(peak)]"
            }
            fputs(summary + "\n", stderr)
        }
        let mutableList = UnsafeMutablePointer(mutating: bufferList)
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: tapFormat, bufferListNoCopy: mutableList, deallocator: nil),
            buffer.frameLength > 0
        else { return }

        let ratio = targetFormat.sampleRate / tapFormat.sampleRate
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

        onChunk(Array(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength))))
    }

    // MARK: - Probing

    /// Try to create (and immediately destroy) a global process tap.
    /// Returns (ok, OSStatus). Used by `meetingscribe probe` for diagnostics.
    static func probeTapCreation() -> (ok: Bool, status: Int32) {
        let description = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        description.name = "MeetingScribe Probe Tap"
        description.isPrivate = true
        var tapID = AudioObjectID(kAudioObjectUnknown)
        let status = AudioHardwareCreateProcessTap(description, &tapID)
        if status == noErr, tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            return (true, status)
        }
        return (false, status)
    }

    // MARK: - Helpers

    private static func defaultOutputDeviceUID() throws -> String {
        var deviceID = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID)
        guard status == noErr, deviceID != kAudioObjectUnknown else {
            throw error("could not find default output device", status)
        }

        var uid: CFString = "" as CFString
        size = UInt32(MemoryLayout<CFString>.size)
        address.mSelector = kAudioDevicePropertyDeviceUID
        status = withUnsafeMutablePointer(to: &uid) { pointer in
            AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, pointer)
        }
        guard status == noErr else {
            throw error("could not read output device UID", status)
        }
        return uid as String
    }

    private static func error(_ message: String, _ status: Int32) -> NSError {
        NSError(domain: "MeetingScribe", code: Int(status), userInfo: [
            NSLocalizedDescriptionKey: "\(message) (OSStatus \(status))"
        ])
    }
}
