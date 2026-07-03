import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { networkInterfaces } from 'os'
import { join, normalize, extname } from 'path'
import { getHandlers, fetchAttachmentToCache } from './ipc'
import { onBroadcast } from './broadcast'
import { dataDir } from './db/db'

/**
 * LAN bridge for iPhone access: serves the built renderer as a PWA and mirrors
 * the IPC surface over HTTP (POST /rpc/:channel) + SSE (GET /events). Every
 * data route requires the pairing key from bridge.json (?key= or x-mailflow-key);
 * the static app shell itself carries no mail data so it is served ungated.
 */

const PORT = 8484

// Only push events a remote client can act on; window-targeted channels
// (open-thread from a Mac banner click) stay desktop-only.
const SSE_CHANNELS = new Set([
  'sync:updated', 'sync:backfill-progress', 'meeting:detected',
  'transcription:event', 'transcription:finished'
])

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
}

interface BridgeConfig {
  token: string
  port: number
}

function loadConfig(): BridgeConfig {
  const path = join(dataDir(), 'bridge.json')
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw.token === 'string' && raw.token.length >= 16) {
      return { token: raw.token, port: Number(raw.port) || PORT }
    }
  } catch {
    /* first run */
  }
  const config = { token: randomBytes(24).toString('hex'), port: PORT }
  const { writeFileSync } = require('fs') as typeof import('fs')
  writeFileSync(path, JSON.stringify(config, null, 2))
  return config
}

function keyOk(req: IncomingMessage, token: string): boolean {
  const url = new URL(req.url ?? '/', 'http://x')
  const supplied = (req.headers['x-mailflow-key'] as string) || url.searchParams.get('key') || ''
  const a = Buffer.from(supplied)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function lanAddresses(): string[] {
  const out: string[] = []
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address)
    }
  }
  return out
}

function cors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MailFlow-Key')
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  cors(res)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body ?? null))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 40 * 1024 * 1024) reject(new Error('Body too large')) // sends can carry 20MB attachments as base64
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

let bridgeInfo: { port: number; token: string } | null = null
export function getBridgeInfo() {
  return bridgeInfo
}

export function startBridge() {
  const config = loadConfig()
  const staticRoot = join(__dirname, '../renderer')

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const path = url.pathname

      if (req.method === 'OPTIONS') {
        cors(res)
        res.writeHead(204)
        res.end()
        return
      }

      if (path === '/health') {
        sendJson(res, 200, { app: 'mailflow', ok: true })
        return
      }

      // ---- authenticated data routes ----
      if (path.startsWith('/rpc/') || path === '/events' || path === '/attachment') {
        if (!keyOk(req, config.token)) {
          sendJson(res, 401, { ok: false, error: 'Bad or missing pairing key' })
          return
        }
      }

      // Phones report their real viewport geometry here — debugging layout
      // remotely from screenshots is guesswork; this gives ground truth.
      if (req.method === 'POST' && path === '/client-metrics') {
        if (!keyOk(req, config.token)) {
          sendJson(res, 401, { ok: false })
          return
        }
        const body = await readBody(req)
        const { appendFileSync } = await import('fs')
        appendFileSync(join(dataDir(), 'client-metrics.jsonl'), body.replace(/\n/g, ' ') + '\n')
        sendJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && path.startsWith('/rpc/')) {
        const channel = decodeURIComponent(path.slice('/rpc/'.length))
        const handler = getHandlers()[channel]
        if (!handler) {
          sendJson(res, 404, { ok: false, error: `Unknown channel ${channel}` })
          return
        }
        const body = await readBody(req)
        const args = body ? (JSON.parse(body).args ?? []) : []
        try {
          const result = await handler(...args)
          sendJson(res, 200, { ok: true, result: result ?? null })
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
        return
      }

      if (path === '/events') {
        cors(res)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })
        res.write(': connected\n\n')
        const off = onBroadcast((channel, payload) => {
          if (!SSE_CHANNELS.has(channel)) return
          res.write(`data: ${JSON.stringify({ channel, payload })}\n\n`)
        })
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
        req.on('close', () => {
          clearInterval(ping)
          off()
        })
        return
      }

      if (path === '/attachment') {
        const account = url.searchParams.get('account') ?? ''
        const messageId = url.searchParams.get('messageId') ?? ''
        const attachmentId = url.searchParams.get('attachmentId') ?? ''
        const filename = url.searchParams.get('filename') ?? 'attachment'
        const mime = url.searchParams.get('mime') || 'application/octet-stream'
        try {
          const filePath = await fetchAttachmentToCache(account, messageId, attachmentId, filename)
          cors(res)
          res.writeHead(200, {
            'Content-Type': mime,
            'Content-Disposition': `inline; filename="${filename.replace(/"/g, '')}"`
          })
          res.end(readFileSync(filePath))
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
        return
      }

      // ---- static renderer (PWA shell) ----
      if (req.method === 'GET') {
        let rel = path === '/' ? '/index.html' : path
        const file = normalize(join(staticRoot, rel))
        if (!file.startsWith(staticRoot)) {
          res.writeHead(403)
          res.end()
          return
        }
        const target = existsSync(file) ? file : join(staticRoot, 'index.html') // SPA fallback
        const type = MIME[extname(target)] ?? 'application/octet-stream'
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
        res.end(readFileSync(target))
        return
      }

      res.writeHead(405)
      res.end()
    } catch (e: any) {
      try {
        sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
      } catch {
        /* headers already sent */
      }
    }
  })

  // The port is briefly held by the outgoing instance during an app update —
  // keep retrying instead of silently losing the bridge until the next launch.
  let attempts = 0
  server.on('error', (e: any) => {
    if (e?.code === 'EADDRINUSE' && attempts < 20) {
      attempts += 1
      setTimeout(() => server.listen(config.port, '0.0.0.0'), 3000)
      return
    }
    // Never take the mail client down over the bridge.
    console.error(`[bridge] not started: ${e?.message ?? e}`)
  })

  server.on('listening', () => {
    bridgeInfo = { port: config.port, token: config.token }
    const urls = lanAddresses().map((a) => `http://${a}:${config.port}/?key=${config.token}`)
    console.log(`[bridge] listening on :${config.port}\n${urls.map((u) => `[bridge]   ${u}`).join('\n')}`)
  })

  server.listen(config.port, '0.0.0.0')
}
