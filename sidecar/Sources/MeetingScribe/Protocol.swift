import Foundation

/// Audio channel identifiers used throughout the JSONL protocol.
enum Channel: String, Sendable {
    case mic   // the user's microphone (always Matt)
    case sys   // system audio — the remote meeting participants
    case file  // offline transcribe-file test mode
}

/// Serialized JSON Lines writer for stdout. Every event the Electron app
/// consumes goes through here so lines never interleave.
enum Emitter {
    private static let queue = DispatchQueue(label: "meetingscribe.emitter")

    private static func emit(_ object: [String: Any]) {
        queue.sync {
            guard let data = try? JSONSerialization.data(withJSONObject: object),
                  let line = String(data: data, encoding: .utf8)
            else { return }
            fputs(line + "\n", stdout)
            fflush(stdout)
        }
    }

    /// `{"t":"ready"}` — models loaded, capture (or file processing) underway.
    static func ready() {
        emit(["t": "ready"])
    }

    /// Clean fixed-precision JSON numbers (avoids 5.6100000000000003 artifacts).
    private static func number(_ value: Double, decimals: Int) -> NSDecimalNumber {
        NSDecimalNumber(string: String(format: "%.\(decimals)f", value))
    }

    /// `{"t":"level","ch":"mic|sys","rms":0.12}` — throttled ~4/sec upstream.
    static func level(_ ch: Channel, rms: Float) {
        emit(["t": "level", "ch": ch.rawValue, "rms": number(Double(rms), decimals: 3)])
    }

    /// `{"t":"seg","ch":...,"t0":12.3,"t1":15.8,"text":"...","spk":N?}`
    static func seg(_ ch: Channel, t0: Double, t1: Double, text: String, spk: Int? = nil) {
        var object: [String: Any] = [
            "t": "seg",
            "ch": ch.rawValue,
            "t0": number(t0, decimals: 2),
            "t1": number(t1, decimals: 2),
            "text": text,
        ]
        if let spk { object["spk"] = spk }
        emit(object)
    }

    /// `{"t":"error","message":"..."}` — non-fatal errors are emitted and
    /// capture continues on whatever channels still work.
    static func error(_ message: String) {
        emit(["t": "error", "message": message])
    }

    /// `{"t":"stopped"}` — capture has ended; no more events follow.
    static func stopped() {
        emit(["t": "stopped"])
    }

    /// Free-form status line for `meetingscribe probe`.
    static func probe(_ fields: [String: Any]) {
        var object = fields
        object["t"] = "probe"
        emit(object)
    }
}
