// Acceptance tests for the MailFlow MCP server. Runs against the live local DB.
// Personal-data specifics come from env so nothing private lives in the repo:
//   MCP_TEST_QUERY        search term expected to hit on the personal account
//   MCP_TEST_PARTICIPANT  substring expected among that thread's participants
// Run: MCP_TEST_QUERY=... MCP_TEST_PARTICIPANT=... node test/acceptance.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const QUERY = process.env.MCP_TEST_QUERY
const PARTICIPANT = process.env.MCP_TEST_PARTICIPANT

const client = new Client({ name: 'acceptance', version: '1.0.0' })
await client.connect(
  new StdioClientTransport({ command: 'node', args: [new URL('../dist/index.js', import.meta.url).pathname] })
)

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args })
  const text = res.content?.[0]?.text ?? ''
  return { isError: !!res.isError, text, data: res.isError ? null : JSON.parse(text) }
}

// 1. personal-account search surfaces the expected thread (the exact case the
//    work-only claude.ai Gmail connector cannot serve)
if (QUERY) {
  const { data, isError } = await call('search_email', { query: QUERY, account: 'personal' })
  const hit =
    !isError &&
    data.results.some(
      (r) =>
        !PARTICIPANT ||
        JSON.stringify(r.participants).toLowerCase().includes(PARTICIPANT.toLowerCase())
    )
  check(`search_email ${QUERY}/personal finds expected thread`, hit, `${data?.count ?? 0} results`)
  const work = await call('search_email', { query: QUERY, account: 'work' })
  check(
    'search_email respects account filter',
    !work.isError && work.data.results.every((r) => r.account.endsWith('@gmail.com') === false)
  )
} else {
  console.log('SKIP  personal-search case (set MCP_TEST_QUERY / MCP_TEST_PARTICIPANT)')
}

// 2. list_recent people since yesterday, both accounts
{
  const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString()
  const { data, isError } = await call('list_recent', { category: 'people', since, limit: 50 })
  check('list_recent people since yesterday returns threads', !isError && data.count >= 0, `${data?.count} threads`)
  const cats = new Set((data?.threads ?? []).map((t) => t.category))
  check('list_recent category filter clean', [...cats].every((c) => c === 'people'))
}

// 3. get_thread round-trip: truncation + full
{
  const s = await call('list_recent', { limit: 1, since: new Date(Date.now() - 14 * 86400e3).toISOString() })
  const t = s.data.threads[0]
  if (t) {
    const short = await call('get_thread', { thread_id: t.thread_id })
    const full = await call('get_thread', { thread_id: t.thread_id, full: true })
    check('get_thread returns messages', !short.isError && short.data.messages.length > 0, `${short.data?.messages.length} messages`)
    const shortLen = short.data.messages.reduce((n, m) => n + m.body.length, 0)
    const fullLen = full.data.messages.reduce((n, m) => n + m.body.length, 0)
    check('get_thread full >= truncated', fullLen >= shortLen, `${shortLen} vs ${fullLen} chars`)
    check('get_thread bodies capped at 2000 unless full', short.data.messages.every((m) => m.body.length <= 2000))
  }
}

// 4. safety: injection-shaped queries fail closed; only read-only tools exposed
{
  const inj = await call('search_email', { query: 'x" OR 1=1; SELECT * FROM tokens --' })
  check('search_email survives injection-shaped query', !inj.isError, inj.isError ? inj.text.slice(0, 80) : `${inj.data.count} results`)
  const tools = await client.listTools()
  const names = tools.tools.map((t) => t.name).sort()
  check(
    'only the six read-only tools exposed',
    names.join(',') === 'get_thread,get_transcript,list_accounts,list_recent,list_transcripts,search_email',
    names.join(',')
  )
}

// 5. transcripts + accounts
{
  const lt = await call('list_transcripts', {})
  check('list_transcripts', !lt.isError, `${lt.data?.count} transcripts`)
  if (lt.data?.count > 0) {
    const gt = await call('get_transcript', { transcript_id: lt.data.transcripts[0].transcript_id, format: 'full' })
    check('get_transcript full', !gt.isError && gt.data.segments.length > 0, `${gt.data?.segments?.length} segments`)
  }
  const la = await call('list_accounts', {})
  check('list_accounts reports accounts', !la.isError && la.data.accounts.length > 0, la.data?.accounts.map((a) => a.kind).join(' '))
  check('list_accounts freshness fields present', 'possibly_stale' in (la.data ?? {}) && !!la.data.db_last_write, `last write ${la.data?.db_last_write}`)
}

await client.close()
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
process.exit(failures ? 1 : 0)
