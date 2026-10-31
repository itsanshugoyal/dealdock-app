# DealDock redesign — decisions & build contract (31 Oct 2026)

Source research: `docs/research/01-premium-ux.md` (visual + UX), `02-competitors-and-gaps.md` (features), `03-voice-cloning-and-audio.md` (speech), `04-writing-style-learning.md` (learning loop), `05a-frontend-inventory.md`, `05b-backend-inventory.md` (what exists, invariants, e2e selectors). Shared TypeScript contract: `packages/core/src/api-types.ts` (exported from `@dealdock/core` as types).

## 1. Product decisions

> **Superseded (31 Oct 2026):** decisions 1, 2 and the "gold/highlighter" part of 7 describe the first direction, which was rejected with three mockup rounds. The shipped look is **DESIGN.md v3, "Native money messaging"**: iOS-grade neutrals, emerald as the only money colour, Geist for everything (no serif, no mono money), dark hero cards, slide-to-send on touch. Everything else below still holds.

1. **Visual direction (superseded): "Paper & Highlighter"** (research 01 §A). Light-first with a full dark theme from one token set; follows the system setting, with a manual override in Settings → Appearance (stored in `localStorage["dealdock.theme"]`, a UI preference, never data). The yellow highlighter `#F9D84A` is a *fill behind money that needs action*, never body text. Confirmed/recovered money is green-ink `#2F5E43` (dark `#7FB894`); estimates are always visually distinct from confirmed money (estimates: muted mono with "est." prefix, or range; confirmed: solid). Plum `#2A1B3D` hero cards are reserved for the Leak Scan reveal and the monthly recap.
2. **Type:** Geist Sans (UI), Geist Mono (money in rows/tables, tabular numerals), an editorial serif for a handful of display headlines — **Instrument Serif** (OFL; self-hosted woff2 in `apps/web/src/app/fonts/`). Devanagari fallback: **Noto Sans Devanagari** (OFL, self-hosted, subset OK). All via `next/font/local`; no runtime font CDN.
3. **Icons:** `lucide-react`. No Unicode-symbol icons, no ✦ sparkle "AI" badges.
4. **Navigation:** mobile bottom tabs **Today · Inbox · Revenue · You**. Desktop left rail: Today, Inbox, Revenue, Your voice, Offers (+ Roster when tier = roster), with Settings + account at the bottom; ⌘K command palette (`cmdk`) everywhere. Review is not a top-level tab: it is the Inbox "Check these" group, surfaced on Today, and `/review` stays as a focus mode (route must keep returning 200).
5. **Inbox grouping by money + state:** Big ones (commerce, value ≥ threshold) · Everything else (commerce) · Follow-ups due · Check these (review) · Waiting · Closed. Desktop is a split pane (list | conversation) via a shared route-group layout; mobile pushes a full-screen conversation.
6. **AI confidence in words**, never "87%": "Looks like a brand deal" / "Probably a brand deal" / "Not sure" + one-line reason.
7. **Sending:** "Approve & send" (gold/highlighter primary). ⌘↵ in the composer = approve. Every approval gets a **5-second "Sending… Undo"** window *client-side before* the API call; nothing is queued offline; nothing auto-sends. After send: "Move to waiting?" + learned-style hint ("Noted: you open with 'Heyy' — keep it?").
8. **Closing a deal:** "Record a sale" → sheet "Record a confirmed sale" (keypad-first amount, offer type chips/select, note). Celebration is a quiet "stamp" — no confetti.
9. **Streaks are replaced** by a weekly reply-speed rhythm (resets Monday) + monthly recap. No guilt pushes.
10. **⌘↵ conflict** with the old prototype's "no key combo approves" rule is resolved in favour of ⌘↵ *with* the 5s undo.

## 2. Feature scope for this build (all end-to-end: DB → API → UI → demo mode)

| # | Feature | Notes |
|---|---|---|
| F1 | Premium redesign of every screen | sign-in, onboarding (13 steps incl. offers, voice reveal, first recovery), Today, Inbox, Thread, Review, Revenue, Your voice, Offers, Settings/You, Roster, Audit, system states |
| F2 | Drafts that learn | VoiceRule + DraftFeedback, exemplar retrieval, edit-diff distillation (heuristic + Claude batch), provenance (`Message.origin`), rule promotion/decay, chips/instruction/variants, Voice Studio, automatic extraction after consent, per-account resample |
| F3 | Offers & rate card | CRUD + used as draft context + quick-insert in composer + seeds value estimates |
| F4 | Reply window + Human Agent tag | countdown on rows/thread; tagged sends 24h–7d only when `META_HUMAN_AGENT_ENABLED=true`; "Reply in Instagram" handoff after |
| F5 | Sender context | User Profile API (name, avatar, followers, verified, follows-you) cached on Thread, mock fixtures; lifetime closed revenue from the ledger |
| F6 | Close-out detection | `detectDealSignal` + amount extraction (core, pure, tested) → "Looks like this closed — record ₹X?" |
| F7 | Insights | `/insights`: goal ring, 6-month trend, by-type, pipeline/at-risk, speed-to-lead, voice match, leak baseline, top deals; monthly goal setting |
| F8 | Voice notes in | detect `attachments[].type=audio`, download (allowlisted CDN hosts, 25 MB cap) → `AudioAsset`, transcribe (speech provider) → classify transcript; signed playback URL |
| F9 | Voice notes out (cloned voice) | `packages/speech` (ElevenLabs IVC first; self-hosted Chatterbox via OpenAI-compatible server; mock); in-app recording (WAV, 3 takes ≈ 90 s incl. spoken consent); preview; "send as voice note" through the existing human send gate (`asVoice`); disclosure on by default; revoke deletes provider voice + assets |
| F10 | Weekly digest push + nudge fixes | weekly summary producer (org tz, Monday 09:00), nudge no longer repeats every 30 min; dismiss resets clock |
| F11 | Audit trail endpoint + screen | creators see who sent what (seat, edit distance, voice/text) |
| F12 | Command palette + keyboard triage | j/k, enter, e (edit), r (regenerate), w (waiting), c (record sale), ? help; swipe on mobile mirrors visible buttons |

Explicitly **not** built (PRD non-goals / research "do not build"): auto-send of any kind, comment-to-DM automations, bulk outbound, pipelines/kanban/contact records/tags, media kits/public rate pages/invoicing/payments, scheduled send, market benchmarks, real-time voice persona chat, content tools.

## 3. Data model additions (one migration `202610310001_redesign_learning_audio`)

- `Organization.monthlyGoalMinor BigInt?`
- `Thread`: `participantName`, `participantAvatarUrl`, `participantFollowerCount Int?`, `participantVerified Boolean?`, `participantFollowsYou Boolean?`, `profileFetchedAt DateTime?`, `source String?`
- `Message`: `origin MessageOrigin?` (native|dealdock|automation; outbound only), `audioAssetId String?` (unique, → AudioAsset, SetNull), `transcript String?`, `transcriptLanguage String?`, `mediaStatus String?` (pending|ready|unavailable|failed), `durationMs Int?`
- `Draft`: `label ClassificationLabel?`, `editRatio Float?`, `instruction String?`, `chips String[]`, `alternatives String[]`, `chosenAlternative Int?`, `generationContext Json?`, `editSignals Json?`, `learnedAt DateTime?`
- `VoiceProfile`: `excludedMessageIds String[]`, `learningPaused Boolean @default(false)`, `lastDistilledAt DateTime?`, `styleOverrides Json?`
- `VoiceRule` (new): orgId, igAccountId, key, text, scope, status (enum VoiceRuleStatus), source (enum VoiceRuleSource), evidence Float, against Float, distinctDrafts Int, distinctThreads Int, creatorEvidence Float, examples Json, lastEvidenceAt, createdAt, updatedAt; `@@unique([igAccountId, key, scope])`; cascade on IgAccount + Organization.
- `DraftFeedback` (new): orgId, draftId (cascade), seatId?, chips String[], note?, createdAt.
- `Offer` (new): orgId, igAccountId?, name, dealType DealType, priceMinMinor/priceMaxMinor BigInt?, currencyCode, link?, details?, availability?, active, sortOrder, timestamps.
- `SpeakingVoice` (new): orgId, igAccountId @unique, provider, externalVoiceId?, status (enum SpeakingVoiceStatus), consentStatement, consentedAt, consentSeatId?, disclosureEnabled default true, sampleSeconds, sampleAssetIds String[], lastError?, revokedAt?, timestamps.
- `AudioAsset` (new): orgId, kind (voice_sample|consent|tts|inbound), mimeType, bytes Bytes, sizeBytes, durationMs?, text?, sha256, createdAt, expiresAt?; cascade on Organization.
- `SendIntent.audioAssetId String?`, `SendIntent.asVoice Boolean @default(false)`
- Every new org-owned table cascades from `Organization` so privacy deletion and the deletion drill stay complete; the drill's residue list gains the new tables.

## 4. Endpoint contract (all behind `requireAuth`; writes add `requireWritable` + the matching permission)

Existing endpoints keep their v1 fields; v2 fields are additive (`api-types.ts`).

| Method & path | Body → Response | Owner |
|---|---|---|
| GET `/inbox?state&label&q&limit&cursor` | → `InboxResponse` | BE-insights |
| GET `/threads/:id` | → `ThreadDetail` (+ lazily refreshes sender profile when stale > 7d on instagram_graph accounts) | BE-insights (detail/profile), BE-audio (audio fields), BE-learning (draft fields) |
| POST `/threads/:id/draft` | `DraftRequest` → `DraftDto` | BE-learning |
| POST `/threads/:id/draft/choose` | `ChooseAlternativeRequest` → `DraftDto` | BE-learning |
| POST `/drafts/:id/feedback` | `DraftFeedbackRequest` → `{ ok: true }` | BE-learning |
| POST `/threads/:id/send` | `SendRequest` → `SendResponse` (adds `learned[]`, `asVoice`, Human Agent window) | BE-audio (gate/audio/window), BE-learning (learned signals + outbox) |
| GET `/voice?igAccountId` | → `VoiceStudio` | BE-learning (speaking field via BE-audio repo fn) |
| PUT `/voice/style` | `{ igAccountId?, overrides: Partial<StyleCard> }` → `VoiceStudio` | BE-learning |
| POST `/voice/rules` | `{ igAccountId?, text, scope?, key?, status?: "active"\|"pinned" }` → `VoiceRuleDto` | BE-learning |
| PATCH `/voice/rules/:id` | `{ text?, status?, scope? }` → `VoiceRuleDto` | BE-learning |
| DELETE `/voice/rules/:id` | → `{ deleted: true }` | BE-learning |
| PUT `/voice/samples/:messageId` | `{ igAccountId?, excluded }` → `{ excluded }` | BE-learning |
| POST `/voice/refresh` | `{ igAccountId? }` → `{ styleCard, sampleCount }` (409 `not_enough_samples`) | BE-learning |
| PUT `/voice/learning` | `{ igAccountId?, paused }` → `{ paused }` | BE-learning |
| POST `/voice/preview` | `VoicePreviewRequest` → `VoicePreviewResponse` | BE-learning |
| POST `/voice/speaking` | `CreateSpeakingVoiceRequest` (route bodyLimit 25 MB) → `SpeakingVoiceDto` | BE-audio |
| DELETE `/voice/speaking?igAccountId` | → `{ revoked: true }` | BE-audio |
| PUT `/voice/speaking/settings` | `{ igAccountId?, disclosureEnabled }` → `SpeakingVoiceDto` | BE-audio |
| POST `/voice/speaking/preview` | `{ igAccountId?, text }` → `AudioPreviewResponse` | BE-audio |
| GET `/media/a/:id?exp&sig` | public, HMAC-signed (`MEDIA_SIGNING_KEY`), 15-min default → audio bytes | BE-audio |
| GET/POST `/offers`, PATCH/DELETE `/offers/:id` | `OfferInput` → `OfferDto` / `{ offers: OfferDto[] }` | BE-insights |
| GET `/insights?months=6` | → `Insights` | BE-insights |
| PUT `/settings/goal` | `{ monthlyGoalMinor: number \| null }` → `{ monthlyGoalMinor }` | BE-insights |
| GET `/audit?limit` | → `{ rows: AuditRow[] }` | BE-insights |
| GET `/settings` | v1 + `monthlyGoalMinor, humanAgentEnabled, speechAvailable, tier` | BE-insights |
| GET/PUT `/notifications/prefs` | v1 + `weeklySummary` restored (producer now exists) | BE-insights |

The web dev bridge allowlist (`apps/web/src/app/api/dev/[...path]/route.ts`) must include every new top-level path (`voice`, `offers`, `insights`, `audit`, `drafts`, `media`, `me`, `seats`, `roster`, `billing`, `metrics`, `organizations`).

## 5. Invariants that must survive (from research 05a/05b)

Never auto-send; worker has no send capability or Meta secrets and must not import messaging/Graph code (boundary lint); Prisma only in `packages/db`; web never imports `@dealdock/ai`/`@dealdock/messaging`/`@dealdock/speech` except the `/demo` and `/fixtures` entries; tenant only from the signed org claim; money in integer minor units rendered only via `MoneyValue` and parsed via `parseMoneyInput`; frozen org currency; account-switch clears in-memory data and aborts requests; no local persistence of data/tokens; writes refused offline; send idempotency key stable per draft; review queue never drafts/sends; demo mode explicit, build-time, labelled, never production; e2e accessible names (listed in 05a) kept or the spec updated in the same change.
