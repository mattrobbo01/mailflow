# MailFlow MCP server

Read-only [MCP](https://modelcontextprotocol.io) stdio server over MailFlow's local SQLite
store. Gives Claude (Desktop, Code, scheduled tasks) direct search/read access to **all
connected Gmail accounts** and meeting transcripts — working even when MailFlow.app is
closed, since it reads the database file directly rather than going through the app.

**v1 is strictly read-only.** No send, no draft, no archive. Queries are limited to an
allowlist of tables (`mcp/src/db.ts`); nothing credential-adjacent is reachable.

## Tools

| Tool | Purpose |
| --- | --- |
| `search_email` | FTS5 full-history search; `account` = work \| personal \| all, plus from/to/date filters |
| `get_thread` | Full thread by id; bodies truncated to ~2k chars with quoted trails folded unless `full: true` |
| `list_recent` | Recent incoming threads (inbox + archived), category/unread/since filters — built for daily ingestion |
| `list_transcripts` | Meeting transcripts with attendees and duration |
| `get_transcript` | One transcript: `summary` (metadata + AI summary + first/last segments) or `full` |
| `list_accounts` | Connected accounts + data-freshness signals (`possibly_stale` when the store hasn't been written in >6h) |

## Build & register

Requires Node ≥ 22.5 (uses the built-in `node:sqlite` — no native modules to rebuild).

```bash
cd mcp && npm install && npm run build
```

Claude Desktop (`claude_desktop_config.json`) or any stdio-capable client:

```json
"mcpServers": {
  "mailflow": { "command": "node", "args": ["<repo>/mcp/dist/index.js"] }
}
```

Claude Code: `claude mcp add --scope user mailflow -- node <repo>/mcp/dist/index.js`

Set `MAILFLOW_DB` to point at a different database file (testing).

## Notes

- The DB is opened read-only with a 5s busy timeout; WAL mode means reads coexist with the
  running app without lock errors.
- Data is only as fresh as MailFlow's last sync — callers should check `list_accounts`
  before trusting recency (the store keeps syncing only while the app or its runner runs).
- Tests: `node test/acceptance.mjs` (see file header for optional env-provided search cases).
