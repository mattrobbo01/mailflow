// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "meetingscribe",
    // Core Audio process taps (CATapDescription / AudioHardwareCreateProcessTap)
    // need macOS 14.4+; requiring 15 keeps the code free of availability checks.
    platforms: [.macOS(.v15)],
    dependencies: [
        // Same spec as LocalFlow — Parakeet ASR + pyannote diarization as CoreML.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.15.4")
    ],
    targets: [
        .executableTarget(
            name: "meetingscribe",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio")
            ],
            path: "Sources/MeetingScribe",
            swiftSettings: [
                // Same language mode as LocalFlow; the capture classes use
                // audio-thread callbacks that Swift 6 strict mode rejects.
                .swiftLanguageMode(.v5)
            ],
            linkerSettings: [
                // Embed Info.plist into the binary (__TEXT,__info_plist) so TCC can
                // identify this CLI and show the System Audio Recording prompt —
                // bare binaries without a bundle identity are silently denied.
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Info.plist"
                ])
            ]
        )
    ]
)
