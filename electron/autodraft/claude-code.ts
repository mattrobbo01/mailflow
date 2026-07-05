import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { dataDir } from '../db/db'
import { AutodraftConfig } from './config'
import type { DraftEngine } from './engine'

/**
 * DraftEngine backed by headless Claude Code (`claude -p`), running on the
 * user's existing subscription login. The draft run gets read-only tools with
 * cwd = the Obsidian vault so it can hunt context agentically — the same way
 * Matt drafts replies with Claude manually.
 */
export class ClaudeCodeEngine implements DraftEngine {
  constructor(private cfg: AutodraftConfig) {}

  triage(prompt: string): Promise<string> {
    return this.run(
      ['-p', '--output-format', 'json', '--model', this.cfg.triageModel, '--max-turns', '1'],
      prompt,
      this.cfg.triageTimeoutMs,
      dataDir()
    )
  }

  draft(prompt: string): Promise<string> {
    const args = ['-p', '--output-format', 'json', '--allowedTools', 'Read,Grep,Glob', '--max-turns', '30']
    if (this.cfg.draftModel) args.push('--model', this.cfg.draftModel)
    const cwd = existsSync(this.cfg.vaultPath) ? this.cfg.vaultPath : dataDir()
    return this.run(args, prompt, this.cfg.draftTimeoutMs, cwd)
  }

  private run(args: string[], stdin: string, timeoutMs: number, cwd: string): Promise<string> {
    const binary = existsSync(this.cfg.claudeBinary) ? this.cfg.claudeBinary : 'claude'
    return new Promise((resolve, reject) => {
      // Stray provider env vars (dev shells) must not override the CLI's own login.
      const env = { ...process.env }
      delete env.ANTHROPIC_API_KEY
      delete env.ANTHROPIC_AUTH_TOKEN
      delete env.ANTHROPIC_BASE_URL

      const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(() => reject(new Error(`claude timed out after ${Math.round(timeoutMs / 1000)}s`)))
      }, timeoutMs)

      child.stdout.on('data', (c) => (out += c))
      child.stderr.on('data', (c) => (err += c))
      child.on('error', (e) => finish(() => reject(e)))
      child.on('close', (code) => {
        finish(() => {
          try {
            const parsed = JSON.parse(out)
            if (parsed.is_error) {
              reject(new Error(String(parsed.result ?? 'claude returned an error').slice(0, 400)))
            } else {
              resolve(String(parsed.result ?? ''))
            }
          } catch {
            reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 400)}`))
          }
        })
      })

      child.stdin.on('error', () => {
        /* spawn failure surfaces via 'error'/'close'; a dead pipe must not throw */
      })
      child.stdin.end(stdin)
    })
  }
}
