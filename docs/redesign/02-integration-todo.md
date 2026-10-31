# Integration to-do after the backend build (31 Oct 2026)

The three backend workstreams (learning, media/speech, inbox/insights) finished and typecheck. These cross-owner items were reported by the agents and must be closed in the integration phase, together with running the DB integration tests (PGlite socket recipe: see the project memory note) and the full gates.

## Must fix
- [x] `package-lock.json` does not include the new `@dealdock/speech` workspace; run `npm install` once so `npm ci` works (a manual `node_modules` link was used locally).
- [x] `persistSendIntent` (packages/db/src/repos/drafts.ts): confirm text sends set `Message.origin = "dealdock"` on create and on update (media reports voice notes/echoes already do).
- [x] Draft history must use `Message.transcript` for audio messages (learning context / prompts).
- [x] `apps/api/src/routes/thread-detail.ts`: pass `speechProviderKind()` as the third argument to `isSpeakingVoiceReady` so `canSendVoice` is false after a provider switch.
- [x] `AuditRow.asVoice`: comes from `SendIntent` joined via `detail.intentId` — verify `persistSendIntent` writes `intentId` into the `message.sent` audit detail and the audit repo joins it.
- [x] Leak-scan → voice refresh: add the one-line `scheduleVoiceRefreshAfterScan(...)` call right after `scanAccountHistory` returns in `apps/api/src/graph-maintenance.ts` (today a 2-minute delayed refresh is queued instead).
- [x] Web dev bridge allowlist (`apps/web/src/app/api/dev/[...path]/route.ts`): confirm `voice`, `drafts`, `media` and every new top-level path are present.
- [x] Reuse `toDraftDto` + `resolveDraftContext` in `POST /threads/:id/draft` so both endpoints return the identical `DraftDto` (learning reports it does; verify).

## Run (never run yet against Postgres)
- [x] New integration tests: `voice-learning.integration.test.ts`, `media.integration.test.ts`, `insights.integration.test.ts` (+ the existing 21) via the PGlite socket server; the new raw SQL in `loadVoiceCorpus`, inbox cursor paging and insights queries are only typechecked so far.
- [x] Full gates: build, typecheck, unit tests, lint, boundaries, safety, design:check.

## Known limits (document, not blockers)
- CSV export dates are still UTC; nudge/high-value pushes are dropped (not deferred) in quiet hours; no cap on offers per org.
- Voice revocation at account deletion is immediate (cancelling deletion does not restore the voice); generated reply clips expire within 24h rather than on revoke.
- Not verified on a live Instagram account: HUMAN_AGENT tag on Instagram Login, voice-note bubble rendering, CDN host allowlist, how voice notes appear in history.

## Frontend
- [x] Rebuilt every screen in DESIGN.md v3 on the kept store/data layer; web typecheck, unit tests and `next build` pass.

## Closed on 31 Oct 2026
- Lockfile now lists `@dealdock/speech` (`npm install --package-lock-only`).
- Text and voice sends both set `origin = "dealdock"`; `message.sent` audit detail now carries `asVoice`, so Activity shows voice-note sends.
- Draft history already used transcripts (`prompts.ts` renders `transcript` for audio).
- `thread-detail.ts` passes `speechProviderKind()`; the send route already compared providers.
- The post-scan voice refresh is queued by the leak-scan job itself, after the history is enqueued, instead of a fixed delay at request time.
- Dev bridge allowlist covers every API root except health, ready and webhooks (by design).
- `POST /threads/:id/draft` now maps through `resolveDraftContext` like GET and /draft/choose.
- DB integration tests: 38/38 passed on Postgres (PGlite over the wire protocol); migrations apply cleanly and `prisma migrate diff` reports no drift. Redis-backed gates (BullMQ graph budget, the full integration gate, browser e2e) still need Redis and were not run.
- Gates run: build (9/9), typecheck (all workspaces), unit tests (all workspaces), boundaries lint + rule tests, safety tests, design:check.
