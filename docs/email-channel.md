# Email channel (Gmail)

A creator connects a Gmail inbox in Settings → Email. DealDock reads their recent
conversations, classifies them and drafts replies exactly as it does Instagram
DMs (same Thread / Message / Classification / Draft rows), and sends an approved
reply as a threaded Gmail reply. Nothing is sent without a person approving it.

## Setup

1. Google Cloud project → enable the **Gmail API**.
2. OAuth consent screen: add the scopes `openid`, `email`,
   `https://www.googleapis.com/auth/gmail.readonly` and
   `https://www.googleapis.com/auth/gmail.send`.
   The two Gmail scopes are **restricted**: production use needs Google's OAuth
   verification, including a third-party security assessment. Until then keep
   the app in **Testing** mode, where up to 100 listed test users can connect
   (their refresh tokens expire after 7 days in Testing mode).
3. Credentials → OAuth client ID, type **Web application**, authorized redirect
   URI `https://<api-host>/email/callback`.
4. Set on the **API only** (the worker refuses `GOOGLE_CLIENT_SECRET` at startup):
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.
   Without all three, every email route answers `409 { error: "email_not_configured" }`
   and no sync runs.

### Optional: near-real-time push (Pub/Sub)

5. Create a Pub/Sub topic and grant `gmail-api-push@system.gserviceaccount.com`
   the **Pub/Sub Publisher** role on it.
6. Add a **push** subscription whose endpoint is
   `https://<api-host>/webhooks/gmail?token=<secret>` (24+ random characters).
7. Set `GMAIL_PUBSUB_TOPIC=projects/<project>/topics/<topic>` and
   `GMAIL_PUBSUB_VERIFICATION_TOKEN=<secret>` on the API.

With push on, DealDock calls Gmail `users.watch` when an inbox connects and renews
every watch daily (they lapse after 7 days); each push queues an incremental sync,
and a 15-minute poll remains as a safety net. Without push, inboxes are polled
every 2 minutes. The push token is checked in constant time; requests without it
get 401. (Pub/Sub's OIDC-token auth would avoid a secret in the URL; not built yet.)

## How it works

- **Accounts.** An inbox is an `IgAccount` row: `platform "email"`, `provider "gmail"`,
  `igUserId` = the lowercased address, `handle` = the address, access and refresh
  tokens AES-256-GCM encrypted like Instagram's. It belongs to one creator
  (`ownerAccountId` = that creator's Instagram account).
- **Limits.** One live inbox per creator, so a Roster workspace can have several.
  On Roster, `GET /email/connect` needs the creator's `igAccountId`; on Solo/Studio
  it defaults to the workspace's Instagram account. An address still live for
  another creator must be disconnected there first.
- **Where it runs.** All Gmail I/O is in the API process (a BullMQ queue,
  `email-sync`, like Graph maintenance). The token carries `gmail.send`, which is
  send capability, so the worker never holds it; it only receives normalized
  messages through the ingestion outbox.
- **What syncs.** Primary mail: anything Gmail did not file under Promotions,
  Social, Updates or Forums, in the inbox or archived; never spam, trash, chats or
  drafts. A thread needs at least one such message from someone else, so threads of
  only your own sends are skipped — but your replies inside synced threads are
  ingested (outbound), so "unreplied" and voice learning stay true.
  - First sync: the last 30 days (newest 300 threads), as `leak_scan` — classified,
    no drafts pre-generated, no pushes.
  - Then incremental from `IngestionCheckpoint.syncCursor` (Gmail `historyId`), as
    `live`. If Gmail no longer has that history (about a week) or more than 300
    threads changed, it falls back to the 30-day window; ingestion dedupes.
- **Threads and messages.** A Gmail thread is a DealDock thread (`igThreadId` =
  Gmail `threadId`, `Thread.subject` set). The participant is the first sender of
  Primary mail who isn't you, using their `Reply-To` when present (where Gmail's
  own Reply goes); `participantName` comes from the header's display name.
  `igMessageId` is the Gmail message id. Message text is only the new part: plain
  part preferred, HTML converted to text, quoted history (Gmail/Apple/Outlook/Yahoo
  attributions, `>` lines, Outlook headers) and signatures (`-- `, mobile footers)
  cut; forwarded content is kept. Capped at 10,000 characters.
- **Attachments.** Noted in the text as `[Attachment: brief.pdf]`; metadata
  (`partId`, Gmail `attachmentId`, `filename`, `mimeType`, `size`) is in
  `Message.raw.attachments`. Embedded images (signature logos) are skipped. Files are
  never stored: `GET /email/messages/:messageId/attachments/:partId` fetches one from
  Gmail on demand, org-scoped, always as a download.
- **Sending.** `POST /threads/:id/send` with the same draft/intent/idempotency rules.
  Email skips Instagram's reply window (status `"none"`) and HUMAN_AGENT tagging,
  refuses voice notes (`409 voice_not_supported`), refreshes the access token before
  anything is claimed, and sends a plain-text RFC 2822 reply to the newest message
  (`Re:` subject, `In-Reply-To`, `References`, `threadId`). `SendOptions.attachments`
  sends files as `multipart/mixed` (up to 3 MB per reply; Instagram ignores the field).
  The echo of our send arrives with the same Gmail id and is deduped.
- **Tokens.** Access tokens last an hour and are refreshed two minutes before expiry;
  a 401 refreshes once and retries. When Google refuses the refresh token the inbox
  becomes `token_expired` and Settings should offer a reconnect. Disconnecting drops
  both tokens (and stops push).

## Adding WhatsApp or TikTok

Write one more `MessagingProvider` in `packages/messaging` (as `GmailProvider` and
`InstagramGraphAdapter` do), add its `Platform`/`MessagingProviderKind` values, store
its account as an `IgAccount` row with an `ownerAccountId`, and pick it in the API's
`providerFor` (send gate). Inbound mail arrives either by webhook (`verifyWebhook` +
`parseWebhook`, like Instagram) or by an API-side sync that writes the ingestion
outbox (like `email-sync.ts`); everything after the outbox — classification,
drafting, deals — is channel-agnostic.
