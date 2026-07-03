import { google, Auth } from 'googleapis'
type OAuth2Client = Auth.OAuth2Client
type Credentials = Auth.Credentials
import { safeStorage, shell } from 'electron'
import { createServer } from 'http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { dataDir, upsertAccount } from '../db/db'

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly'
]

export type ClientKind = 'work' | 'personal'

interface OAuthClientConfig {
  client_id: string
  client_secret: string
}

/**
 * OAuth client credentials live in ~/Library/Application Support/MailFlow/oauth-clients.json:
 *   { "work": { "client_id": "...", "client_secret": "..." },
 *     "personal": { "client_id": "...", "client_secret": "..." } }
 * See SETUP.md for how to create these in Google Cloud Console.
 */
export function loadClientConfigs(): Partial<Record<ClientKind, OAuthClientConfig>> {
  const path = join(dataDir(), 'oauth-clients.json')
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8'))
}

function tokensDir(): string {
  const dir = join(dataDir(), 'tokens')
  mkdirSync(dir, { recursive: true })
  return dir
}

function tokenPath(email: string): string {
  return join(tokensDir(), `${email.toLowerCase()}.enc`)
}

function saveTokens(email: string, kind: ClientKind, tokens: Credentials) {
  const payload = JSON.stringify({ kind, tokens })
  const enc = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(payload)
    : Buffer.from(payload, 'utf8') // dev fallback; safeStorage is available on macOS in practice
  writeFileSync(tokenPath(email), enc)
}

function loadTokens(email: string): { kind: ClientKind; tokens: Credentials } | null {
  const path = tokenPath(email)
  if (!existsSync(path)) return null
  const raw = readFileSync(path)
  const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
  return JSON.parse(text)
}

export function connectedAccountEmails(): string[] {
  if (!existsSync(join(dataDir(), 'tokens'))) return []
  return readdirSync(tokensDir())
    .filter((f) => f.endsWith('.enc'))
    .map((f) => f.replace(/\.enc$/, ''))
    .filter((email) => {
      // Tokens encrypted by a different build identity (dev Electron vs packaged
      // MailFlow) can't be decrypted — treat as disconnected so the UI offers
      // a clean reconnect instead of failing every sync.
      try {
        return loadTokens(email) !== null
      } catch {
        return false
      }
    })
}

const clientCache = new Map<string, OAuth2Client>()

/** Returns an authorized OAuth2 client for a connected account, refreshing transparently. */
export function getAuthClient(email: string): OAuth2Client {
  const key = email.toLowerCase()
  const cached = clientCache.get(key)
  if (cached) return cached

  const stored = loadTokens(key)
  if (!stored) throw new Error(`No stored tokens for ${email} — connect the account first`)
  const configs = loadClientConfigs()
  const cfg = configs[stored.kind]
  if (!cfg) throw new Error(`oauth-clients.json is missing the "${stored.kind}" client used by ${email}`)

  const client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret)
  client.setCredentials(stored.tokens)
  client.on('tokens', (fresh) => {
    // google-auth-library omits refresh_token on refresh responses; merge to keep it.
    saveTokens(key, stored.kind, { ...stored.tokens, ...fresh })
  })
  clientCache.set(key, client)
  return client
}

/**
 * Interactive loopback OAuth flow. Opens the system browser, waits for the redirect
 * on 127.0.0.1, exchanges the code, stores encrypted tokens keyed by the Gmail
 * profile's email address. Resolves to that email.
 */
export function startAuthFlow(kind: ClientKind): Promise<string> {
  const configs = loadClientConfigs()
  const cfg = configs[kind]
  if (!cfg) {
    return Promise.reject(
      new Error(`No "${kind}" client in oauth-clients.json — see SETUP.md`)
    )
  }

  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      const redirect = `http://127.0.0.1:${port}/callback`
      const oauth2 = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, redirect)
      const url = oauth2.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES
      })

      const timeout = setTimeout(() => {
        server.close()
        reject(new Error('OAuth flow timed out after 5 minutes'))
      }, 5 * 60_000)

      server.on('request', async (req, res) => {
        try {
          const u = new URL(req.url!, redirect)
          if (u.pathname !== '/callback') {
            res.writeHead(404).end()
            return
          }
          const err = u.searchParams.get('error')
          if (err) throw new Error(`Google returned: ${err}`)
          const code = u.searchParams.get('code')
          if (!code) throw new Error('No code in OAuth callback')

          const { tokens } = await oauth2.getToken(code)
          oauth2.setCredentials(tokens)
          const gmail = google.gmail({ version: 'v1', auth: oauth2 })
          const profile = await gmail.users.getProfile({ userId: 'me' })
          const email = profile.data.emailAddress!.toLowerCase()

          saveTokens(email, kind, tokens)
          upsertAccount(email)
          clientCache.delete(email)

          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(`<html><body style="font-family: -apple-system; padding: 40px">
            <h2>✅ ${email} connected to MailFlow</h2>You can close this tab.</body></html>`)
          clearTimeout(timeout)
          server.close()
          resolve(email)
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end(`OAuth failed: ${e.message}`)
          clearTimeout(timeout)
          server.close()
          reject(e)
        }
      })

      shell.openExternal(url)
    })
    server.on('error', reject)
  })
}
