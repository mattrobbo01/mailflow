# MailFlow setup — one-time Google OAuth configuration

MailFlow talks directly to the Gmail API from your Mac. You need two OAuth clients
(one per Google account) because the accounts live in different worlds:

- **matt@usehabits.com** → an *Internal* app inside your Workspace org. No verification,
  no warnings, refresh tokens never expire.
- **matthew.g.robertson@gmail.com** → an *External* app left in *Testing* mode. Works
  immediately, but Google expires testing-mode refresh tokens every 7 days — MailFlow
  shows a one-click Reconnect when that happens (~5 seconds).

## 1. Work account (usehabits.com) — Internal app

1. Go to https://console.cloud.google.com **while signed in as matt@usehabits.com**.
2. Create a project (e.g. `mailflow`).
3. **APIs & Services → Library** → enable **Gmail API** and **Google Calendar API**.
4. **APIs & Services → OAuth consent screen** → User type: **Internal** → fill in app
   name `MailFlow`, your email, save. (No scopes/verification needed for Internal.)
5. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Desktop app** (permits loopback redirects on any port —
     do NOT use "Web application", which requires exact pre-registered URIs and
     fails with `redirect_uri_mismatch` against MailFlow's random-port callback).
   - Name: `MailFlow desktop`
6. Copy the **Client ID** and **Client secret**.

## 2. Personal account (gmail.com) — External app in Testing

1. Same flow, but in a project owned by **matthew.g.robertson@gmail.com**
   (or the same project if you prefer — the consent screen type is what matters).
2. OAuth consent screen → User type: **External** → Publishing status: leave in **Testing**.
3. Add `matthew.g.robertson@gmail.com` under **Test users**.
4. Enable **Gmail API** + **Google Calendar API**, create an OAuth client as above.

## 3. Give the credentials to MailFlow

Create `~/Library/Application Support/MailFlow/oauth-clients.json`:

```json
{
  "work":     { "client_id": "….apps.googleusercontent.com", "client_secret": "…" },
  "personal": { "client_id": "….apps.googleusercontent.com", "client_secret": "…" }
}
```

## 4. Connect

Run MailFlow (`npm run dev` during development), click **Connect work** / **Connect
personal**. Your browser opens Google's consent page; after approving, tokens are
encrypted with the macOS Keychain (Electron `safeStorage`) and stored at
`~/Library/Application Support/MailFlow/tokens/`.

First sync backfills 12 months of full email bodies plus headers for everything
older — expect ~30–60 minutes per account depending on volume. The app is usable
while it runs; newest mail lands first.

## Scopes requested

- `gmail.modify` — read mail, change labels (archive/read/snooze)
- `gmail.send` — send and schedule mail
- `calendar.readonly` — detect meetings for transcription and attribute attendees

## Notes

- Nothing is sent anywhere except Google's own APIs. No third-party servers.
- Database: `~/Library/Application Support/MailFlow/mailflow.db` (SQLite, WAL).
- If the personal account's weekly token expiry annoys you, the alternative is
  auto-forwarding personal → work plus a "Send mail as" alias in Gmail, and
  connecting only the work account.
