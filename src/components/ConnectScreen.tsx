import { useState } from 'react'
import type { Account } from '../types.d'

interface Props {
  accounts: Account[]
  clientsConfigured: { work: boolean; personal: boolean }
  onConnected: () => void
}

export default function ConnectScreen({ accounts, clientsConfigured, onConnected }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function connect(kind: 'work' | 'personal') {
    setBusy(kind)
    setError(null)
    try {
      await window.mailflow.startAuth(kind)
      onConnected()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  const neitherConfigured = !clientsConfigured.work && !clientsConfigured.personal

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-zinc-100">MailFlow</h1>
        <p className="mt-2 max-w-md text-sm text-zinc-500">
          Local-first mail. Your email syncs directly between this Mac and Google — no servers in between.
        </p>
      </div>

      {neitherConfigured ? (
        <div className="max-w-md rounded-lg border border-amber-900/50 bg-amber-950/30 p-4 text-sm text-amber-200/90">
          No OAuth clients configured yet. Follow <code className="text-amber-100">SETUP.md</code> to create your
          Google Cloud OAuth credentials, then save them to
          <code className="mt-1 block text-[12px] text-amber-100/80">
            ~/Library/Application Support/MailFlow/oauth-clients.json
          </code>
        </div>
      ) : (
        <div className="flex gap-3">
          <ConnectButton
            label="Connect work (usehabits.com)"
            disabled={!clientsConfigured.work || busy !== null}
            busy={busy === 'work'}
            connected={accounts.some((a) => a.id.endsWith('@usehabits.com') && a.connected)}
            onClick={() => connect('work')}
          />
          <ConnectButton
            label="Connect personal (gmail.com)"
            disabled={!clientsConfigured.personal || busy !== null}
            busy={busy === 'personal'}
            connected={accounts.some((a) => a.id.endsWith('@gmail.com') && a.connected)}
            onClick={() => connect('personal')}
          />
        </div>
      )}

      {error && <div className="max-w-md text-sm text-red-400">{error}</div>}
    </div>
  )
}

function ConnectButton({
  label, disabled, busy, connected, onClick
}: {
  label: string; disabled: boolean; busy: boolean; connected: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || connected}
      className={`rounded-lg px-4 py-2.5 text-sm font-medium transition
        ${connected
          ? 'cursor-default border border-emerald-800 bg-emerald-950/40 text-emerald-300'
          : 'border border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40'}`}
    >
      {connected ? '✓ Connected' : busy ? 'Waiting for browser…' : label}
    </button>
  )
}
