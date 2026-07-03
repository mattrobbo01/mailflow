#!/bin/bash
# Assemble the meetingscribe sidecar into a real .app bundle in /Applications.
# TCC's System Audio Recording permission wants a proper bundle identity —
# bare CLI binaries can't be added in System Settings or reliably prompt.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="/Applications/MeetingScribe.app"
BIN="sidecar/.build/release/meetingscribe"

(cd sidecar && swift build -c release)

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/meetingscribe"

cat > "$APP/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>meetingscribe</string>
  <key>CFBundleIdentifier</key>
  <string>com.mattrobertson.meetingscribe</string>
  <key>CFBundleName</key>
  <string>MeetingScribe</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>15.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAudioCaptureUsageDescription</key>
  <string>MailFlow captures meeting audio to transcribe your calls locally on this Mac.</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>MailFlow records your side of meetings for local transcription.</string>
</dict>
</plist>
EOF

codesign --force --deep --sign "LocalFlow Dev" "$APP"
echo "Installed $APP"
codesign -dv "$APP" 2>&1 | grep Identifier | head -1
