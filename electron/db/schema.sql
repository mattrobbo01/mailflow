-- MailFlow schema. All Gmail ids are provider ids; (account_id, id) is the natural key.
-- messages.rid is the FTS rowid link.

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,              -- email address
  display_name TEXT,
  color TEXT,
  kind TEXT DEFAULT 'gmail',
  history_id TEXT,                  -- newest historyId we have fully applied
  backfill_state TEXT DEFAULT 'pending',  -- pending | running | done
  backfill_page_token TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS threads (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  subject TEXT,
  snippet TEXT,
  last_ts INTEGER,
  message_count INTEGER DEFAULT 0,
  label_ids TEXT DEFAULT '[]',      -- JSON array of Gmail label ids (union of messages)
  is_unread INTEGER DEFAULT 0,
  is_inbox INTEGER DEFAULT 0,
  snoozed_until INTEGER,
  participants TEXT DEFAULT '[]',   -- JSON [{name, email}]
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS idx_threads_last_ts ON threads(last_ts DESC);
CREATE INDEX IF NOT EXISTS idx_threads_inbox ON threads(is_inbox, last_ts DESC);
CREATE INDEX IF NOT EXISTS idx_threads_snoozed ON threads(snoozed_until) WHERE snoozed_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
  rid INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  from_name TEXT,
  from_email TEXT,
  to_json TEXT DEFAULT '[]',        -- JSON [{name, email}]
  cc_json TEXT DEFAULT '[]',
  reply_to TEXT,
  message_id_header TEXT,           -- RFC 2822 Message-ID (for References on reply)
  references_header TEXT,
  ts INTEGER,
  snippet TEXT,
  label_ids TEXT DEFAULT '[]',
  has_attachments INTEGER DEFAULT 0,
  attachments_json TEXT DEFAULT '[]', -- JSON [{partId, filename, mimeType, size, attachmentId}]
  body_html TEXT,                   -- raw provider HTML; sanitized at render time
  body_text TEXT,
  body_state TEXT DEFAULT 'none',   -- none (metadata only) | full
  UNIQUE (account_id, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(account_id, thread_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_email);

-- Standalone FTS; rowid == messages.rid. Kept in sync by db.ts upsert/delete paths.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, sender, recipients, body,
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE TABLE IF NOT EXISTS labels (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT,
  type TEXT,                        -- system | user
  color TEXT,
  PRIMARY KEY (account_id, id)
);

-- Modifier queue (Superhuman pattern): modify() already mutated local rows;
-- persist() drains this table, serialized per thread, idempotent, with backoff.
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  thread_id TEXT,
  type TEXT NOT NULL,               -- modifyLabels | trash | send | ...
  payload TEXT NOT NULL,            -- JSON
  state TEXT DEFAULT 'pending',     -- pending | inflight | done | failed
  attempts INTEGER DEFAULT 0,
  not_before INTEGER DEFAULT 0,
  last_error TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_actions_pending ON actions(state, not_before);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- send | unsnooze
  send_at INTEGER NOT NULL,
  draft_id TEXT,                    -- real Gmail draft id (safety net for kind=send)
  thread_id TEXT,                   -- for kind=unsnooze
  payload TEXT DEFAULT '{}',
  state TEXT DEFAULT 'pending',     -- pending | done | failed
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON scheduled_jobs(state, send_at);

-- People spine: merged from HubSpot contacts, Gmail correspondents, Robbo2 People/*.md
CREATE TABLE IF NOT EXISTS people (
  email TEXT PRIMARY KEY,           -- lowercase
  name TEXT,
  company TEXT,
  role TEXT,
  hubspot_id TEXT,
  robbo2_note TEXT,                 -- path to People/*.md if any
  voice_embedding BLOB,             -- WeSpeaker embedding for transcript auto-match
  first_seen INTEGER DEFAULT (unixepoch()),
  last_emailed INTEGER
);

CREATE TABLE IF NOT EXISTS hs_contacts (
  hubspot_id TEXT PRIMARY KEY,
  email TEXT,
  properties TEXT DEFAULT '{}',     -- JSON of relevant properties
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_hs_contacts_email ON hs_contacts(email);

CREATE TABLE IF NOT EXISTS hs_deals (
  hubspot_id TEXT PRIMARY KEY,
  name TEXT,
  stage TEXT,
  amount REAL,
  pipeline TEXT,
  close_date INTEGER,
  properties TEXT DEFAULT '{}',
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS hs_deal_contacts (
  deal_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  PRIMARY KEY (deal_id, contact_id)
);

CREATE TABLE IF NOT EXISTS hs_notes (
  hubspot_id TEXT PRIMARY KEY,
  contact_id TEXT,
  body TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_hs_notes_contact ON hs_notes(contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  calendar_event_id TEXT,
  markdown_path TEXT,               -- Robbo2 export location
  source TEXT DEFAULT 'mailflow'
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  transcript_id INTEGER NOT NULL REFERENCES transcripts(id),
  seq INTEGER NOT NULL,
  channel TEXT,                     -- mic | system
  speaker TEXT,                     -- resolved display name or "Speaker N"
  person_email TEXT,
  t0 REAL, t1 REAL,
  text TEXT,
  PRIMARY KEY (transcript_id, seq)
);

CREATE TABLE IF NOT EXISTS transcript_attendees (
  transcript_id INTEGER NOT NULL REFERENCES transcripts(id),
  person_email TEXT NOT NULL,
  PRIMARY KEY (transcript_id, person_email)
);
CREATE INDEX IF NOT EXISTS idx_tattendees_person ON transcript_attendees(person_email);

CREATE TABLE IF NOT EXISTS palette_frecency (
  command_id TEXT PRIMARY KEY,
  uses INTEGER DEFAULT 0,
  last_used INTEGER
);
