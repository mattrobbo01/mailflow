// Renders build/icon.png — MailFlow app icon: LocalFlow-family grey with a teal paper-plane.
// Run: swift scripts/make-icon.swift
import AppKit

let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext

// macOS rounded square with margin
let margin: CGFloat = size * 0.09
let rect = CGRect(x: margin, y: margin, width: size - 2 * margin, height: size - 2 * margin)
NSBezierPath(roundedRect: rect, xRadius: size * 0.185, yRadius: size * 0.185).addClip()

// Grey gradient (Cursor/LocalFlow family)
NSGradient(
  starting: NSColor(calibratedRed: 0.30, green: 0.32, blue: 0.36, alpha: 1),   // #4d525c
  ending: NSColor(calibratedRed: 0.13, green: 0.14, blue: 0.16, alpha: 1)      // #212429
)!.draw(in: rect, angle: -75)

// Paper-plane (send) glyph on the 24-unit grid used in the app's Send icon,
// scaled and centered. Body filled teal; the fold drawn as a grey slit.
let s = rect.width * 0.62 / 24.0
let ox = rect.midX - 12 * s - 0.6 * s   // slight optical centering
let oy = rect.midY - 12 * s
func pt(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
  NSPoint(x: ox + x * s, y: oy + (24 - y) * s)   // flip y (grid is y-down)
}

let teal = NSColor(calibratedRed: 0.21, green: 0.76, blue: 0.83, alpha: 1)     // #35c3d4

ctx.setShadow(offset: CGSize(width: 0, height: -size * 0.010), blur: size * 0.030,
              color: NSColor.black.withAlphaComponent(0.35).cgColor)
let body = NSBezierPath()
body.move(to: pt(21, 3))
body.line(to: pt(14, 21))
body.line(to: pt(10.5, 13.5))
body.line(to: pt(3, 10))
body.close()
body.lineJoinStyle = .round
teal.setFill()
teal.setStroke()
body.lineWidth = 1.6 * s
body.stroke()
body.fill()
ctx.setShadow(offset: .zero, blur: 0, color: nil)

// Fold slit from tip to the notch, in the background grey.
let slit = NSBezierPath()
slit.move(to: pt(21, 3))
slit.line(to: pt(10.5, 13.5))
slit.lineWidth = 1.1 * s
slit.lineCapStyle = .round
NSColor(calibratedRed: 0.16, green: 0.17, blue: 0.20, alpha: 1).setStroke()
slit.stroke()

image.unlockFocus()

let out = FileManager.default.currentDirectoryPath + "/build/icon.png"
try? FileManager.default.createDirectory(atPath: FileManager.default.currentDirectoryPath + "/build", withIntermediateDirectories: true)
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
