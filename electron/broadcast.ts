import { BrowserWindow } from 'electron'

type Listener = (channel: string, payload: unknown) => void

const listeners = new Set<Listener>()

/** Bridge (SSE) taps the event stream here; returns an unsubscribe. */
export function onBroadcast(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Send to every desktop window AND every subscribed bridge client. */
export function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
  for (const l of listeners) {
    try {
      l(channel, payload)
    } catch {
      /* a dead SSE socket must not break desktop sends */
    }
  }
}
