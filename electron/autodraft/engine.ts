import { AutodraftConfig } from './config'
import { ClaudeCodeEngine } from './claude-code'

/**
 * Provider abstraction for the auto-draft pipeline. Both methods take a fully
 * assembled prompt and return raw model text; prompt construction and output
 * parsing live in prompts.ts / worker.ts so engines stay dumb pipes.
 */
export interface DraftEngine {
  /** Cheap gate: "does this email warrant a reply?" No tool access. */
  triage(prompt: string): Promise<string>
  /** Context-heavy drafting run; may search the vault with read-only tools. */
  draft(prompt: string): Promise<string>
}

export function getEngine(cfg: AutodraftConfig): DraftEngine {
  switch (cfg.engine) {
    case 'claude-code':
      return new ClaudeCodeEngine(cfg)
    default:
      throw new Error(`Unknown autodraft engine: ${cfg.engine}`)
  }
}
