# 04: Writing-style learning (drafts that keep learning the creator's voice)

Status: design proposal, 31 October 2026. Nothing in this document is implemented yet. It covers how DealDock's reply drafts should learn a creator's texting style from (a) their historical sent DMs and (b) every edit they make before sending. Audio voice cloning is out of scope here (see the audio research track).

Constraints: Claude via API with prompt context (no per-creator fine-tuning), Postgres as the only store (no vector DB), every send still needs a human, and everything is gated by the existing per-account voice consent (`VoiceProfile`).

---

## 0. TL;DR

1. **A hybrid of three context types, not one style card.** Every draft prompt carries (i) a short set of **verified, visible rules** ("Never open with 'Thanks for reaching out'", "Brand replies ≈ 25 words"), (ii) **3–5 retrieved exemplars**, which are the creator's own past replies to similar inbound DMs, and (iii) **1–2 retrieved edit lessons** ("on a similar brand DM you changed X → Y"). Research supports this mix: few-shot examples alone tend to produce a generic "AI-flavoured" tone for informal writing ([Wang et al., EMNLP 2025 Findings](https://aclanthology.org/2025.findings-emnlp.532/)). Verified preference descriptions beat raw edit inference and stack with in-context examples ([PROSE, ICML 2025](https://arxiv.org/abs/2505.23815): +33% over CIPHER, +9% over ICL alone). Retrieving per-context preferences from past edits lowers user edit cost ([CIPHER/PRELUDE, NeurIPS 2024](https://arxiv.org/abs/2404.15269)).
2. **Provenance first.** Every outbound `Message` gets an `origin` (`native` / `dealdock` / `automation`). Only human-authored text counts as style evidence, and untouched AI drafts never feed style extraction. Otherwise the system trains on its own output and the creator's quirks wash out, the same tail-loss effect as model collapse ([Shumailov et al., Nature 2024](https://www.nature.com/articles/s41586-024-07566-y)).
3. **Deterministic first, Claude second.** Pure-function detectors (greeting swap, signoff change, removed phrase, length delta, emoji delta, Hinglish ratio shift) run on every send for free. A batched Claude pass (every ≥5 edited sends, or weekly) proposes natural-language rules. **Promotion is always deterministic**: decayed evidence ≥ 3 from ≥ 3 drafts in ≥ 2 threads, with < 25% contradiction.
4. **Everything learned is visible and editable** in a Voice Studio, using the same pattern as Fyxer's editable "Writing style" instructions ([Fyxer support](https://support.fyxer.com/article/teach-fyxer-your-style)). The signature moment is: *"DealDock noticed you never say 'Thanks for reaching out' (6 edits). Stopped using it. [Undo]"*
5. **North-star voice metric is unchanged** (PRD §7.4: % of drafts sent with < 20% character edits). It is now stored per draft with its label, so we can show "your drafts are getting better" per deal type and per week. For offline evaluation we use PRELUDE's own metric: edit distance between the regenerated draft and what the creator actually sent, on a time split.

---

## 1. What exists today (and gaps)

| Area | Today | Gap |
|---|---|---|
| Style extraction | `extractStyleCard()` (`packages/ai/src/voice.ts`) takes the 30 most recent outbound messages, returns a 7-field card via tool call; deterministic `heuristicStyleCard()` fallback. Manual refresh only (`POST /settings/voice/resample`). | No sample filtering (empty, attachment, duplicate, template, AI-written). No provenance, so DealDock's own sent drafts count as "the creator's voice". Resample uses `org.igAccounts[0]`, which is wrong for Roster. No per-message-type stats. |
| Draft prompt | `buildDraftSystem()` puts the card JSON into a cache-marked system block. Thread history is the last 12 messages. | No exemplars (ARCHITECTURE §5.4 promised 5–8). No learned rules. No length/language targets. No regenerate instruction. Heuristic brand template literally says "Thanks for reaching out" (a generic AI tell). |
| Edit capture | `persistSendIntent()` stores `finalText` + Levenshtein `editDistance` on `Draft`, plus an audit row. | Nothing reads it back. The draft's label isn't stored (thread `topLabel` can change later), so per-label fidelity is impossible. |
| Metric | `getWeeklyMetrics().voiceFidelity` = share of sends with editDistance/body.length < 0.2 | Org-wide, one number, no trend, no per-label breakdown, not shown to the creator. |
| Corrections | Up to 10 classification overrides feed the **classification** prompt. | No equivalent for drafts. |
| Consent | Revocation clears card + sample IDs and discards ready drafts; `createDraft` locks `VoiceProfile FOR SHARE`. | Any new learned artifact must be wiped by the same revocation path. |

Also found while reading:
- `persistSendIntent()` upserts the outbound `Message` with `update: {}`. If the webhook echo wins the race, the row is created by ingestion as a plain outbound. Once `origin` exists, the upsert must set `origin: "dealdock"` in `update` too, or the creator's AI-assisted sends become "native" evidence.
- `POST /threads/:id/draft` falls back to `thread.topLabel ?? "brand_deal"` and passes no `replyToMessageId`, so on-demand drafts can't be attributed to an inbound message for retrieval or metrics.

---

## 2. Research summary (what we borrow, with sources)

| Source | What it shows | What we take |
|---|---|---|
| **PRELUDE / CIPHER**, Gao et al., NeurIPS 2024 ([arXiv 2404.15269](https://arxiv.org/abs/2404.15269), [NeurIPS PDF](https://proceedings.neurips.cc/paper_files/paper/2024/file/f75744612447126da06767daecce1a84-Paper-Conference.pdf)) | Learns a natural-language description of a user's latent preference from their edits. For a new context it retrieves preferences inferred from the k nearest past contexts, aggregates them, and prompts with that. No fine-tuning; descriptions are interpretable and user-editable. Lowest edit-distance cost vs baselines, small LLM overhead. | Edit-diff → natural-language rule. Per-context retrieval of past edit lessons. Edit distance as the cost metric. Rules shown to and editable by the user. |
| **PROSE**, Aroca-Ouellette et al., ICML 2025 ([arXiv 2505.23815](https://arxiv.org/abs/2505.23815)) | Inferred preference descriptions are often generic. Iterative refinement plus **verifying each preference across multiple user samples** fixes this: +33% vs CIPHER, and PROSE+ICL is +9% over ICL alone. | Rules must be **verified against multiple drafts and against the creator's native corpus** before activation. Use rules *and* exemplars together. |
| **LaMP**, Salemi et al., ACL 2024 ([arXiv 2304.11406](https://arxiv.org/abs/2304.11406), [code](https://github.com/LaMP-Benchmark/LaMP)) | Personalization by retrieving items from a user profile into the prompt beats no-profile baselines. BM25 is competitive with dense retrievers on many tasks. Time-based splits (`-T`) for evaluation. | Lexical retrieval (no vector DB) is a defensible starting point. Evaluate on a **time split**. |
| **Liu et al.**, "What Makes Good In-Context Examples for GPT-3?" ([arXiv 2101.06804](https://arxiv.org/abs/2101.06804)) | Semantically similar (nearest-neighbour) demonstrations consistently beat random ones. | Retrieve exemplars by similarity to the current inbound message, not "most recent 5". |
| **Wang et al.**, "Catch Me If You Can? Not Yet", EMNLP 2025 Findings ([ACL Anthology](https://aclanthology.org/2025.findings-emnlp.532/), [arXiv 2509.14543](https://arxiv.org/abs/2509.14543)) | Across 400+ real authors, few-shot LLMs approximate style in structured formats (news, email) but struggle with informal writing (forums, blogs) and drift to a generic tone. | DMs are informal, so exemplars alone are not enough. Add explicit measured targets (length, emoji, language mix) and an explicit "avoid generic AI phrasing" list. |
| **Anthropic prompting docs** ([best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)) | Examples should be relevant, diverse, and wrapped in `<example>` tags; "Include 3–5 examples". Queries at the end of long-context prompts "can improve response quality by up to 30 percent". Tell Claude what to do instead of what not to do. | 3–5 exemplars with MMR diversity, XML-wrapped. Task last. Phrase avoid-rules with a replacement where known. |
| **Anthropic prompt caching** ([docs](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching)) | Prefix order tools → system → messages. Up to 4 breakpoints. 5-min TTL by default (1h optional). Minimum cacheable length 512 tokens (Sonnet 5.5, Haiku 5.5, Opus 5.5) to 1,024 (Sonnet 4.5/4.6/5) to 4,096 (Haiku 4.5). Reads are 0.05–0.1× base. | Put stable per-creator voice (card + rules) in the cached system block. Put per-draft exemplars/lessons/thread in the uncached user turn. Batch rule changes so the cache isn't invalidated per send. |
| **Anthropic embeddings** ([docs](https://platform.claude.com/docs/en/docs/build-with-claude/embeddings)) | Anthropic has no embedding model and points to Voyage AI (`voyage-4`, `voyage-4-lite`, multilingual). `voyage-4-nano` is open-weight (Apache 2.0). | Upgrade path only, if lexical retrieval measurably misses (romanized vs Devanagari Hindi is the likely failure). |
| **pg_trgm** ([Postgres docs](https://www.postgresql.org/docs/current/pgtrgm.html)) | `similarity()`, `%` operator (threshold 0.3 default), GIN/GiST trigram indexes. Ignores non-alphanumerics. Multibyte/Devanagari behaviour depends on locale (verify with `show_trgm`). | Not needed at pilot scale (≤ a few hundred candidates per account are scored in-process). Use it when a creator's candidate pool exceeds ~5k rows. |
| **Superhuman** ([help: Auto Drafts](https://help.superhuman.com/hc/en-us/articles/46005658551053-Auto-Reminders-Auto-Drafts), [TechCrunch 2026-07-14](https://techcrunch.com/2026/07/14/superhumans-new-auto-draft-feature-almost-makes-me-like-ai-replies/)) | Analyzes a sample of recent sent emails for tone. Per-recipient adaptation from past conversations with that person. Editable Personalization settings (tone, length, formatting). Auto-drafts come with two alternative variations. 40% of auto-drafts sent within a day, 60% of those with zero edits (company figures). | Variants on demand. Per-thread consistency via thread history. Explicit length/tone controls. "Sent unedited" as a headline metric. |
| **Fyxer** ([blog](https://www.fyxer.com/blog/how-fyxer-learns-your-voice), [support](https://support.fyxer.com/article/teach-fyxer-your-style)) | Starts from the last 300 sent emails. Auto-writes **editable "Writing style" instructions**. Learns from accepts, edits and sign-off changes. Advises "light edits, not deletions" and reviewing ≥ 5 drafts in a batch. Different registers by recipient type. Claims 55% of drafts sent unchanged among power users. | Editable instruction list. Batch distillation at ≥ 5 edits. Per-type registers. Coach the user toward light edits. |
| **Gmail Personalized Smart Replies / Suggested Replies** ([Google Workspace blog](https://workspace.google.com/blog/product-announcements/new-ways-to-do-your-best-work), [Gmail help](https://support.google.com/mail/answer/15464729)) | Matches "tone and style of your past written emails" (greetings, formality, length, favourite words). Shows **Sources** used. English-only. | A "Why this draft" panel showing which rules and exemplars were used. Hinglish support is a differentiator Gmail doesn't offer. |
| **Grammarly voice profile** ([support](https://support.grammarly.com/hc/en-us/articles/23153676821773-View-and-customize-your-voice-profile)) | Continuously updated voice profile, viewable and customizable. Recognizes short-message vs long-document styles. | Separate profiles per message scope (brand / coaching / nudge). |
| **Jasper Brand Voice** ([comparison](https://aipromptshub.co/marketing/ai-brand-voice-tool-comparison)) | Named voice profiles trained from uploaded samples, plus a style guide with banned words / preferred terms. | Seed samples at onboarding. User-authored "never say / always say" rules. |
| **Lavender** ([Woodpecker review](https://woodpecker.co/blog/lavender-ai/)) | Coaches *toward a house style* based on the recipient's profile; reviewers note it makes emails converge on a "Lavender style". | Anti-pattern: DealDock must converge on the **creator's** style, not ours. Hence the native-anchor exemplar cap (§4.4). |
| **Code-Mixing Index** (Gambäck & Das 2014/2016; see [CALCS 2021 metrics review](https://aclanthology.org/2021.calcs-1.2.pdf), [Nature HSSC 2024 Hinglish study](https://www.nature.com/articles/s41599-024-03058-6)) | CMI = 1 − max(n_hi, n_en)/n over language-tagged tokens. 0 means monolingual. | Measure the creator's Hinglish ratio per scope and per edit. Use it as a target in prompts and as an edit signal. |
| **Meta echo provenance** ([Messenger message_echoes](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/message-echoes), [Instagram webhook examples](https://developers.facebook.com/docs/instagram-platform/webhooks/examples)) | Instagram echoes carry `is_echo: true`. Messenger echoes also carry `app_id` (sending app). Instagram `app_id` presence is **not confirmed** in the IG docs. | DealDock's own sends are identified locally (SendIntent ↔ `platformMessageId`), so no dependency on `app_id`. If `app_id` is present and ≠ ours, mark `automation`. Otherwise use template heuristics. |
| **Preference drift**, IBA-Bench ([arXiv 2608.02171](https://arxiv.org/abs/2608.02171)) | Real interaction histories carry noise, implicit cues and temporal inconsistency. Static profiles miss evolving preferences. | Evidence decays (half-life). Contradictions demote rules. |

---

## 3. Data model additions (Prisma)

Design rule: the smallest set of fields that makes provenance, per-label metrics, rule learning and user control possible. Measured stats live inside the existing `styleCard` JSON (versioned shape), and weekly trends are computed from `Draft` rows, so no snapshot table.

```prisma
// ── Provenance ─────────────────────────────────────────────────────────────
enum MessageOrigin {
  native      // typed in Instagram by the account (echo with no matching SendIntent, or history import)
  dealdock    // sent through DealDock's send gate (a Draft exists with sentMessageId = this id)
  automation  // third-party sender (echo app_id != ours) or detected template blast
}

model Message {
  // ...existing fields...
  origin MessageOrigin? // outbound only; null for inbound
  @@index([orgId, threadId, sentAt])          // existing
  // new: corpus scan for voice — outbound text per account via thread
  @@index([orgId, direction, origin, sentAt])
}

// ── Draft: label, edit ratio, generation context, learning marker ──────────
model Draft {
  // ...existing fields...
  label             ClassificationLabel? // label drafted for (thread.topLabel drifts later)
  editRatio         Float?    // editDistance / body.length, clamped 0..1, set at send
  instruction       String?   // regenerate-with-instruction text (≤ 200 chars) incl. chip phrases
  alternatives      Json?     // [{tag:"shorter", body:"..."}] — variants live on ONE row (keeps one-live-draft invariant)
  chosenAlternative String?   // tag picked by the creator, if any
  generationContext Json?     // {ruleIds[], exemplarMessageIds[], lessonDraftIds[], promptVersion, budget}
  editSignals       Json?     // deterministic detector output at learn time (for lessons + audit)
  learnedAt         DateTime? // idempotency marker for the learning sweep

  feedback DraftFeedback[]
  @@index([orgId, status, sentAt]) // fidelity trend scan
}

// ── Learned / authored style rules ─────────────────────────────────────────
enum VoiceRuleStatus {
  candidate // evidence accruing, not used in prompts
  active    // used in prompts
  pinned    // user-confirmed; never auto-demoted
  muted     // user said "not me"; never used, never re-proposed (key suppressed)
}

enum VoiceRuleSource {
  extracted      // from initial corpus analysis
  edit_distilled // from edit diffs (deterministic or Claude)
  feedback_chip  // from quick chips / regenerate instructions
  user_authored  // typed by the user in Voice Studio
}

model VoiceRule {
  id             String          @id @default(cuid())
  orgId          String
  igAccountId    String
  key            String          // dedupe key, e.g. "greeting", "avoid:thanks for reaching out", "length", "free:asks-budget-first"
  kind           String          // greeting|signoff|avoid_phrase|prefer_phrase|length|emoji|language_mix|punctuation|casing|freeform
  scope          String          // "all" | ClassificationLabel value | "nudge"
  text           String          // imperative, creator-facing: "Open brand replies with 'Hi team!'"
  params         Json?           // {value, values:{...dist}, targetWords, emojiPerMsg, cmi, replacement}
  status         VoiceRuleStatus @default(candidate)
  source         VoiceRuleSource
  support        Float           @default(0) // decayed supporting evidence
  contradict     Float           @default(0) // decayed contradicting evidence
  evidenceDrafts String[]        // distinct draft ids (cap 20, newest kept) — distinct-draft threshold
  evidenceThreads String[]       // distinct thread ids (cap 20)
  examples       Json?           // ≤3 {draftId, before, after} snippets for the UI ("because you changed…")
  lastEvidenceAt DateTime?
  promotedAt     DateTime?
  updatedBySeatId String?
  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt

  igAccount IgAccount @relation(fields: [igAccountId], references: [id], onDelete: Cascade)

  @@unique([igAccountId, key, scope])
  @@index([orgId, igAccountId, status])
}

// ── Quick feedback chips on a draft ────────────────────────────────────────
model DraftFeedback {
  id        String   @id @default(cuid())
  orgId     String
  draftId   String
  seatId    String
  chips     String[] // validated by zod against FEEDBACK_CHIPS in @dealdock/core (vocabulary will iterate in pilot)
  note      String?  // ≤ 280 chars, optional free text
  createdAt DateTime @default(now())

  draft Draft @relation(fields: [draftId], references: [id], onDelete: Cascade)
  @@index([orgId, draftId])
}

// ── VoiceProfile additions ─────────────────────────────────────────────────
model VoiceProfile {
  // ...existing fields (enabled, consentedAt, revokedAt, styleCard, sampleMessageIds, version, refreshedAt)...
  seedSamples     Json?     // ≤10 onboarding/pasted samples [{scope, inbound?, text, at}] — cold start
  excludedMessageIds String[] // user-excluded corpus messages (Voice Studio "not me")
  learningPaused  Boolean   @default(false) // drafts still use rules; no new learning
  lastDistilledAt DateTime? // last Claude batch distillation
}
```

`FEEDBACK_CHIPS` (in `@dealdock/core`): `too_long`, `too_short`, `too_formal`, `too_casual`, `more_hinglish`, `less_hinglish`, `add_emoji`, `no_emoji`, `too_salesy`, `too_eager`, `not_my_greeting`, `wrong_facts`. Each maps to (a) a regenerate instruction string and (b) an evidence signal (§4.2). `wrong_facts` is never style evidence; it is tracked as a quality metric.

`styleCard` v2 shape (same JSON column, backward compatible: top-level v1 keys stay for `HeuristicPipeline`):

```ts
interface StyleCardV2 {
  v: 2;
  // v1 descriptive keys (Claude-extracted): greeting, tone, sentenceLength, signoff, emojiUsage, codeSwitching, characteristicPhrases
  ...
  measured: {
    sampleCount: number;            // eligible native-weighted samples
    byScope: Record<Scope, {        // Scope = "all" | label | "nudge"; only scopes with n ≥ 5
      n: number;
      medianWords: number; p80Words: number;
      emojiPerMsg: number;          // mean
      exclaimPerMsg: number;
      lowercaseStartRate: number;   // "hey" vs "Hey"
      cmi: number;                  // mean Code-Mixing Index (romanized Hindi vs English)
      devanagariRate: number;       // share of msgs containing Devanagari
      greetings: Array<[string, number]>; // top 3 with share
      signoffs: Array<[string, number]>;
      lineBreakRate: number;
    }>;
    aiTellRate: number;             // share of native msgs with ≥2 AI tells (filter self-disables if > 0.5)
    computedAt: string;
  };
}
```

Migration/backfill: outbound messages with a `Draft.sentMessageId` pointing at them → `dealdock`. All other outbound → `native`. `Draft.label` backfill from `Classification.label` of `replyToMessageId`, falling back to `thread.topLabel`. `Draft.editRatio` backfill = `editRatio(body, finalText)` from `@dealdock/core`.

Consent: `setVoiceConsent(false)` must, in the same transaction, `deleteMany VoiceRule {igAccountId}`, null `seedSamples`, clear `excludedMessageIds`, and `deleteMany DraftFeedback` notes for that account's drafts. The learning job locks `VoiceProfile FOR SHARE` and re-checks consent before writing rules (same pattern as `createDraft`), so revocation always wins.

Roster/assistant seats: edits by `assistant`/`manager` seats count at weight 0.5 and a rule may not be promoted on non-creator evidence alone. A manager's taste is not the creator's voice. Voice Studio exposes "Learn from my team's edits" (default on for Solo, where seat = creator; off for Roster).

---

## 4. Algorithms

All pure functions live in `packages/ai/src/style/` (no DB, no network) so they are unit-testable. DB access stays in repos (`packages/db/src/repos/voice.ts`, `creator-context.ts`). `getCreatorContext` (or a sibling `getDraftVoiceContext`) remains the only place prompt context is gathered (ARCHITECTURE §3.3).

### 4.0 Shared text features (`style/text-features.ts`)

```ts
tokenize(s)          = s.normalize("NFC").toLowerCase().match(/[\p{L}\p{M}\p{N}']+|\p{Extended_Pictographic}/gu) ?? []
words(s)             = tokenize(s).filter(t => !/\p{Extended_Pictographic}/u.test(t))
emojiCount(s)        = count of \p{Extended_Pictographic}
isDevanagari(t)      = /[ऀ-ॿ]/.test(t)
HINGLISH_LEXICON     = ~150 romanized Hindi function/content words: hai, hain, kya, nahi, nhi, toh, bhi, ki, ka, ke, mein, se, ko,
                       aap, aapka, tum, yaar, bhai, accha, acha, theek, thik, ho, kar, karo, karna, raha, rahi, wala, abhi,
                       kal, aaj, bas, matlab, sahi, ekdum, bilkul, haan, ji, bata, batao, dijiye, chahiye, sakte, ...
                       // exclude English-colliding tokens: "to", "me", "he", "main", "is", "the", "do"
cmi(s)               = { hi = words that are Devanagari or in HINGLISH_LEXICON; en = words matching /^[a-z']+$/ not in lexicon;
                         n = hi + en; return n < 3 ? 0 : 1 - max(hi, en) / n }   // Gambäck & Das CMI, universal tokens excluded
greetingOf(s)        = first line's leading span up to first [,!.?\n] if ≤ 4 words, else ""   // "Hey hey!", "Hi team,"
signoffOf(s)         = last line if multi-line and ≤ 4 words (or trailing emoji cluster), else ""
AI_TELLS             = ["thanks for reaching out", "i hope this message finds you well", "i'd be happy to", "feel free to",
                        "looking forward to hearing from you", "don't hesitate to", "absolutely!", "great question", "—" /* em dash */,
                        "i appreciate you", "rest assured", "kindly"]
aiTellScore(s)       = number of AI_TELLS present
isContentSpan(span)  = /\d|₹|\$|rs\.?\b|https?:|www\.|@\w|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\b/i  // prices, dates, links, handles = facts, not style
normalizeForSim(s)   = lowercase, strip emoji/punct, collapse letter runs ≥3 → 2 ("pleaseee" → "pleasee"), collapse spaces
trigrams(s)          = set of char 3-grams over " " + normalizeForSim(s) + " "
trigramJaccard(a,b)  = |A∩B| / |A∪B|   (0 if either empty)
```

### 4.1 (a) Initial style extraction with sample filtering

Runs at consent (once history import lands), on manual "Refresh voice", and automatically when ≥ 10 new eligible messages arrived since `refreshedAt` (the measured part is deterministic and free; the Claude descriptive part runs at most monthly or on manual refresh).

```text
loadCorpus(orgId, igAccountId):
  rows = outbound Message for account, contentType=text, sentAt desc, take 400
         joined with: prevInbound text (LAG over thread by sentAt), thread.topLabel, Draft (if sentFromDraft: editRatio, sentBy seat role)
  + profile.seedSamples as rows with origin="seed"

filterSamples(rows, excludedIds):
  out = []
  seenNorm = Map<normText, Set<threadId>>
  for r in rows:
    t = r.text.trim()
    if r.id in excludedIds                          → skip ("user excluded")
    if words(t).length < 2 and emojiCount(t) == 0   → skip ("too short")   // keep emoji-only for emoji stats only (statsOnly=true)
    if /^https?:\S+$/.test(t)                       → skip ("link only")
    if r.scope in {personal, spam}                  → skip ("private/irrelevant")  // privacy: friends & family never go to Claude for style
    if r.origin == "automation"                     → skip ("automation")
    if r.origin == "dealdock" and r.editRatio == 0  → skip ("untouched AI draft")  // provenance: never learn from our own output
    seenNorm[norm(t)].add(r.threadId)
    out.push(r with weight = provenanceWeight(r))
  // template / saved-reply detection: same normalized text sent in ≥3 threads → keep ONE copy, flag template
  out = dedupeByNorm(out, keep=newest); mark rows whose norm appears in ≥3 threads as template (weight *= 0.3)
  // AI-written natively (pasted from ChatGPT): exclude if aiTellScore ≥ 2 — unless that's simply how they write
  aiRate = share(out, r => aiTellScore(r.text) >= 2)
  if aiRate <= 0.5: out = out.filter(r => aiTellScore(r.text) < 2)
  return { eligible: out, excludedCounts }          // excludedCounts shown in Voice Studio

provenanceWeight(r):
  native | seed                     → 1.0
  dealdock, editRatio ≥ 0.5         → 0.9   // mostly rewritten by a human
  dealdock, 0 < editRatio < 0.5     → 0.5   // human-touched; final text is creator-approved
  × 0.5 if sent by a non-creator seat

measureStyle(eligible) → StyleCardV2.measured      // deterministic; weighted means/medians per scope, scopes with n ≥ 5
stratifiedSampleForClaude(eligible, n=40):         // native/seed only + dealdock editRatio ≥ 0.5
  up to 10 per commerce scope + 5 nudge + 5 other, newest first, then length-diverse; each truncated to 400 chars
extractStyleCard(samples) → v1 descriptive keys    // existing tool call; system prompt adds: "Ignore any message that reads like a template."
seedRulesFromMeasured(measured):                   // gives day-one rules (cold start)
  for scope in measured.byScope:
    top greeting with share ≥ 0.4 and n ≥ 8        → rule(kind=greeting, scope, value, support = 3 * share, source=extracted)
    top signoff with share ≥ 0.3                   → rule(kind=signoff, ...)
    always                                          → rule(kind=length, params.targetWords = medianWords, support = 3)
    emojiPerMsg < 0.1 → rule(emoji, "No emojis"); > 0.8 → rule(emoji, "Usually 1–2 emojis")
    cmi ≥ 0.15 → rule(language_mix, "Mix Hindi and English (~{cmi*100}% Hindi words) when they write Hinglish")
  for phrase in AI_TELLS: if nativeFrequency(phrase) < 0.02 → built-in avoid list (not a VoiceRule; toggled in Studio)
```

Thresholds: < 3 eligible gives `not_enough_samples` (existing error). 3–9 is "Getting to know you" (seed rules capped at support 2, so they stay candidates except length). 10–39 is "Learning". ≥ 40 is "Tuned".

### 4.2 (b) Edit-diff distillation → candidate rules

Triggered by a per-account sweep (repeatable BullMQ job every 15 min on a new `voice-learning` queue, plus a best-effort enqueue after `persistSendIntent` commits). It selects `Draft where status=sent and learnedAt is null and orgId/igAccountId`. A lost enqueue is harmless because the sweep catches it, so no outbox is needed.

**Deterministic detector (always runs):**

```ts
function editSignals(draft: string, final: string, scope: Scope): Signal[] {
  const r = editRatio(draft, final);
  if (r === 0) return [{ key: "accepted", polarity: +1 }];           // feeds metrics + reinforces rules applied in generationContext
  const out: Signal[] = [];
  const A = tokenizeWithSpans(draft), B = tokenizeWithSpans(final);
  const ops = wordLcsDiff(A, B);                                     // O(n·m) LCS on tokens; DMs ≤ ~300 words
  const fullRewrite = r > 0.8;                                       // phrase diffs are noise; keep only global signals

  // 1. greeting swap
  const g0 = greetingOf(draft), g1 = greetingOf(final);
  if (g0 !== g1) out.push(g1 ? sig("greeting", { value: g1, replaced: g0 }) : sig("greeting", { value: "", replaced: g0 }));
  // 2. signoff change
  const s0 = signoffOf(draft), s1 = signoffOf(final);
  if (s0 !== s1) out.push(sig("signoff", { value: s1, replaced: s0 }));
  // 3. removed phrases (style, not facts)
  if (!fullRewrite) for (const del of ops.deletions) {
    const span = del.text; const n = words(span).length;
    if (n < 2 || n > 8 || isContentSpan(span) || isStopwordsOnly(span)) continue;
    if (span === g0 || span === s0) continue;                         // already covered by 1/2
    const replacement = ops.insertionAt(del.index)?.text ?? null;
    out.push(sig(`avoid:${normPhrase(span)}`, { kind: "avoid_phrase", phrase: span, replacement }));
  }
  // 4. added phrases (only promoted if recurring across drafts — §4.3)
  if (!fullRewrite) for (const ins of ops.insertions) {
    const n = words(ins.text).length;
    if (n >= 1 && n <= 6 && !isContentSpan(ins.text) && !isStopwordsOnly(ins.text))
      out.push(sig(`prefer:${normPhrase(ins.text)}`, { kind: "prefer_phrase", phrase: ins.text }));
  }
  // 5. length delta
  const w0 = words(draft).length, w1 = words(final).length, lr = w1 / Math.max(1, w0);
  if (lr < 0.75 || lr > 1.33) out.push(sig("length", { targetWords: w1, direction: lr < 1 ? "shorter" : "longer" }));
  else out.push(sig("length", { targetWords: w1 }, /*polarity*/ +1, /*weight*/ 0.3)); // kept length = mild support for current target
  // 6. emoji add/remove
  const e0 = emojiCount(draft), e1 = emojiCount(final);
  if (e0 !== e1) out.push(sig("emoji", { emojiPerMsg: e1, direction: e1 > e0 ? "more" : "fewer" }));
  // 7. Hinglish / script shift
  const dc = cmi(final) - cmi(draft);
  if (Math.abs(dc) >= 0.15) out.push(sig("language_mix", { cmi: cmi(final), direction: dc > 0 ? "more_hindi" : "more_english" }));
  if (hasDevanagari(final) !== hasDevanagari(draft)) out.push(sig("script", { devanagari: hasDevanagari(final) }));
  // 8. punctuation / casing
  if (startsLower(final) !== startsLower(draft)) out.push(sig("casing", { lowercaseStart: startsLower(final) }));
  const x0 = count(draft, "!"), x1 = count(final, "!");
  if (Math.abs(x1 - x0) >= 2) out.push(sig("punctuation", { exclaim: x1 > x0 ? "more" : "fewer" }));
  // 9. facts-only edit → no style learning
  if (out.length === 0 && ops.changedSpans.every(isContentSpan)) return [{ key: "fact_edit", polarity: 0 }];
  return out.map(s => ({ ...s, scope }));
}
```

`scope` = `"nudge"` if `draft.kind === "nudge"`, else `draft.label ?? "all"`.

**Rule-level evidence against existing rules (contradictions):** for every active/pinned rule that was in this draft's `generationContext.ruleIds`, `checkRule(rule, final)` returns `support | contradict | n/a`. For example: an `avoid` rule whose phrase appears in the final text is a contradiction. A `length` rule is contradicted if `|w1 − target| / target > 0.5` and the creator moved *away* from target. A `greeting` rule is contradicted if the final greeting ≠ value. A rule that was applied and survived untouched gets mild support (+0.3). This is how rules get *confirmed by acceptance*, not only by edits.

**Chip and instruction evidence:** each `DraftFeedback` chip maps to a signal with weight 1.5: `too_long` → `length/shorter`, `more_hinglish` → `language_mix/more_hindi`, `not_my_greeting` → `greeting` contradiction, `too_formal` → `freeform:casual-register`, `too_salesy` → `freeform:low-pressure`, and so on. Free-text regenerate instructions are normalized. The same normalized instruction seen ≥ 3 times surfaces a *suggestion* ("Make 'keep it under 3 lines' a rule?"), never an auto-rule.

**Claude distillation (CIPHER-style, batched):** when ≥ 5 sent drafts with `0.05 ≤ editRatio ≤ 0.8` exist since `lastDistilledAt` (Fyxer's "batch of five" guidance), or weekly, run one call with `DRAFT_MODEL`, `temperature: 0`:

```text
SYSTEM: You study how a creator edits AI-drafted Instagram DM replies to learn their personal texting preferences.
Infer preferences that explain the edits. Each preference must be:
- about style (wording, tone, length, structure, language mix, emoji, greetings/signoffs, negotiation posture), never about facts or prices;
- supported by at least TWO different edit pairs (cite their ids);
- written as one imperative instruction ≤ 90 chars, phrased as what TO do, with a concrete replacement when the edit shows one
  (e.g. "Open with 'Hey hey!' instead of 'Thanks for reaching out'");
- scoped to a message type only if the evidence is limited to that type.
If a preference matches an existing rule, return its id instead of a new one. Return an empty list if nothing is consistent.
Always call propose_voice_rules exactly once.

USER:
<existing_rules>[{id, scope, text}...]</existing_rules>
<edits>
  <edit id="d_123" type="brand_deal"><them>…inbound (≤300 chars)…</them><draft>…</draft><sent>…</sent>
    <signals>greeting: "Thanks for reaching out" → "Hey hey!"; length 62→31 words</signals></edit>
  … up to 10 …
</edits>

TOOL propose_voice_rules: { rules: [{ text, kind: enum, scope: enum, evidence_draft_ids: string[] (min 2),
                                      matches_rule_id?: string, replacement?: string }] }
```

Post-validation (PROSE-style verification, deterministic):
1. Drop proposals with < 2 valid `evidence_draft_ids` (ids must be in the batch).
2. For `avoid_phrase`/`prefer_phrase`, the phrase must literally occur in the cited drafts/finals as claimed. Reject if the creator's **native** corpus uses an avoided phrase in ≥ 5% of messages (it was content-specific removal, not a preference).
3. Map to `key` (`free:<slug(text)>` for freeform; Claude's `matches_rule_id` reuses an existing key).
4. Upsert as evidence with weight 1.0 per cited draft. Claude **never** sets status; promotion is §4.3.

**Heuristic fallback** (no API key / heuristic mode): the deterministic detector alone. Claude distillation is skipped, and rules from deterministic keys still promote normally. Rows stay honest because `source=edit_distilled` and `params.via="heuristic"`.

### 4.3 (c) Rule promotion and decay

```ts
const HALF_LIFE_DAYS = 45;          // style drifts slowly; ~3 months to fade fully without reinforcement
const decay = (x: number, lastAt: Date | null, now: Date) =>
  lastAt ? x * Math.pow(0.5, (now.getTime() - lastAt.getTime()) / 864e5 / HALF_LIFE_DAYS) : x;

function applyEvidence(rule, ev: { polarity: 1 | -1, weight: number, draftId, threadId, seatRole, example? }, now) {
  if (rule.status === "muted") return rule;                                   // suppressed: no resurrection
  const w = ev.weight * (ev.seatRole === "creator" ? 1 : 0.5);
  rule.support    = decay(rule.support, rule.lastEvidenceAt, now)    + (ev.polarity > 0 ? w : 0);
  rule.contradict = decay(rule.contradict, rule.lastEvidenceAt, now) + (ev.polarity < 0 ? w : 0);
  rule.lastEvidenceAt = now;
  pushCapped(rule.evidenceDrafts, ev.draftId, 20); pushCapped(rule.evidenceThreads, ev.threadId, 20);
  if (ev.example) pushCapped(rule.examples, ev.example, 3);
  // value-distribution kinds (greeting/signoff): params.values[value] += w, text re-rendered from argmax
  return nextStatus(rule, now);
}

function nextStatus(rule, now) {
  const s = decay(rule.support, rule.lastEvidenceAt, now), c = decay(rule.contradict, rule.lastEvidenceAt, now);
  const cRatio = c / Math.max(1e-9, s + c);
  const minDrafts = rule.source === "feedback_chip" ? 2 : 3;
  if (rule.status === "pinned" || rule.source === "user_authored") return rule;           // never auto-changed
  if (rule.status === "candidate" && s >= 3 && distinct(rule.evidenceDrafts) >= minDrafts
      && distinct(rule.evidenceThreads) >= 2 && cRatio <= 0.25 && hasCreatorEvidence(rule)) {
    return { ...rule, status: "active", promotedAt: now };                                // → "DealDock noticed…" toast
  }
  if (rule.status === "active" && (s < 1.5 || (c >= 2 && cRatio > 0.4))) return { ...rule, status: "candidate" }; // "fading"
  return rule;
}
```

Housekeeping (in the sweep):
- Delete `candidate` rules with decayed support < 0.5 and `createdAt` > 60 days. Keep `muted` forever as suppression.
- **Generalization across scopes:** if the same `key` is active in ≥ 2 scopes, upsert a `scope="all"` row with summed support (status active). Prompt assembly dedupes by `key`, preferring the most specific scope.
- **Conflicts:** within the same `kind`+`scope`, only one `greeting`/`signoff`/`length`/`emoji`/`language_mix` rule can be active (highest support wins). `avoid:X` and `prefer:X` for the same phrase cancel, and the newer evidence wins.
- **Pinned contradiction:** when a pinned or user-authored rule gets contradicted ≥ 3 times in 30 days, surface a non-blocking prompt: "You've been sending 'Thanks so much!' despite your rule 'No exclamation marks'. Keep the rule?" Never change it silently.
- Caps: ≤ 200 rule rows per account (prune lowest-support candidates). ≤ 12 rules per prompt.
- All status changes made by a person (pin, mute, edit, delete, author) write an `AuditLog` row: `voice.rule_pinned`, `voice.rule_muted`, and so on.

### 4.4 (d) Exemplar retrieval per draft

Pool: the last 300 eligible corpus rows for the account from `filterSamples` (§4.1), each with its `prevInbound` text, scope, language, origin, editRatio and age, plus `seedSamples`. Scored in-process. At pilot scale (≤ a few thousand outbound per account) this is a single indexed query plus O(300) trigram comparisons, a few ms.

```ts
function selectExemplars(q: { inbound: string; scope: Scope; language: Lang; now: Date },
                         pool: Candidate[], k = 4): Candidate[] {
  const qTri = trigrams(q.inbound);
  const scored = pool
    .filter(c => c.eligible && !c.statsOnly && c.text.length <= 600)
    .map(c => {
      const ctxSim  = c.prevInbound ? jaccard(qTri, trigrams(c.prevInbound)) : 0;   // CIPHER/Liu: similar context
      const label   = c.scope === q.scope ? 1 : (isCommerce(c.scope) && isCommerce(q.scope) ? 0.5 : 0.2);
      const lang    = c.language === q.language ? 1 : 0.6;                          // Hinglish in → Hinglish exemplars
      const prov    = c.origin === "native" || c.origin === "seed" ? 1.0
                    : c.editRatio! >= 0.5 ? 0.95                                    // human-rewritten send
                    : c.editRatio! > 0     ? 0.85                                   // low-edit approved send
                    :                        0.6;                                   // untouched approved send (exemplar only, never extraction)
      const recency = Math.pow(0.5, ageDays(c, q.now) / 120);
      return { c, score: (0.45 * label + 0.35 * ctxSim + 0.2 * lang) * prov * (0.6 + 0.4 * recency) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);

  // MMR for diversity (Anthropic: "diverse"; avoids 4 near-identical "Hey! DM me rates" exemplars)
  const picked: typeof scored = [];
  const λ = 0.7;
  while (picked.length < k && scored.length) {
    let best = -1, bestVal = -Infinity;
    scored.forEach((s, i) => {
      const red = picked.length ? Math.max(...picked.map(p => jaccard(trigrams(s.c.text), trigrams(p.c.text)))) : 0;
      const val = λ * s.score - (1 - λ) * red;
      if (val > bestVal) { bestVal = val; best = i; }
    });
    picked.push(scored.splice(best, 1)[0]);
  }
  // Anti-convergence caps: keep the creator's real voice as the anchor (Lavender anti-pattern; model-collapse risk)
  enforce(picked, { maxUntouchedDealdock: Math.floor(k / 2), minNativeIfAvailable: 1 }, scored);
  return picked.reverse().map(p => p.c);   // most relevant last, closest to the task
}
```

If fewer than 2 candidates score above 0.2, use `k = 3` with the best available, or seed samples. Exemplar texts are truncated to 400 chars, and their `prevInbound` to 200 chars.

**Edit lessons (CIPHER retrieval):** pool = sent drafts with `0.05 ≤ editRatio ≤ 0.8` and non-empty `editSignals` from the last 120 days. Score with `ctxSim(inbound, draft.replyTo.text)` × same-scope boost. Take the top 2 with score ≥ 0.15 and render each as one line: `On a similar {scope} message you changed "…before…" → "…after…"` (spans ≤ 80 chars, taken from the largest non-content diff op).

`shortcut:` in-process trigram scoring over the newest 300 rows. Upgrade to `pg_trgm` GIN (`similarity(prev_inbound, $1)`) when an account exceeds ~5k outbound rows, and to Voyage `voyage-4-lite` embeddings only if the offline eval (§7.1) shows lexical recall failing on romanized-vs-Devanagari pairs.

### 4.5 (e) Draft prompt assembly order and token budget

`PROMPT_VERSION` → `2.0.0-voice`. Order follows the cache prefix order (tools → system → messages) and Anthropic's "queries at the end" guidance.

```text
SYSTEM block 1 — static (identical for all creators; cached with block 2)
  Role, never-auto-send framing, REPLY STRUCTURE BY TYPE (existing), hard rules:
  "Never invent prices, dates, availability"; "Output ONLY the reply text";
  "Write the way this creator texts: their rules and examples outrank general politeness."

SYSTEM block 2 — per-creator voice (cache_control: ephemeral)  ← changes only when the learning sweep changes rules
  <creator> business summary, currency, typical ranges </creator>
  <voice_profile>
    descriptive card (tone, phrases) — 3–6 lines
    measured targets for each scope with n≥5: "brand_deal: ~24 words (p80 38), 0–1 emoji, CMI 0.30, often opens 'Hi team!'"
  </voice_profile>
  <voice_rules>            // ≤12, ordered: pinned/user_authored → active by support; deduped by key, specific scope wins
    ALWAYS: - Open brand replies with "Hi team!" [brand_deal]
            - Keep it under 3 short lines [all]
    INSTEAD OF: - "Thanks for reaching out" → open with "Hey hey!" [all]
  </voice_rules>
  <avoid_generic> built-in AI_TELLS the creator does not natively use, phrased positively:
    "Sound like a person texting: skip stock phrases such as … ; use their own openers instead." </avoid_generic>

USER turn (uncached, per draft)
  <examples>                // 3–5 from §4.4, least→most relevant
    <example type="brand_deal"><them>…</them><creator>…</creator></example> …
  </examples>
  <edit_lessons> 0–2 lines from §4.4 </edit_lessons>
  <thread> last 12 messages, THEM/CREATOR, each ≤ 500 chars, total ≤ 1,200 tokens (drop oldest first) </thread>
  <task>
    Draft the creator's reply to the latest message (type: brand_deal).
    Target: ~24 words; match their language — the inbound is Hinglish (CMI 0.4), their brand replies average CMI 0.3.
    {regenerate instruction / chip instructions, if any — e.g. "Make it noticeably shorter (~60%)."}
    {variants: "Return 3 versions via the tool: closest-to-voice, shorter, warmer"}   // only when requested
  </task>
```

| Segment | Budget (tokens, approx.) | Notes |
|---|---|---|
| System static | ~550 | Constant |
| System voice (card + measured + ≤12 rules + avoid list) | ~600–900 | Cached. Block 1+2 ≈ 1.2–1.5k is above the 512 (Sonnet 5.5) / 1,024 (Sonnet 4.5–5) minimum. **Not cacheable on Haiku 4.5** (4,096 min), so drafts should stay on the Sonnet-class `DRAFT_MODEL`. |
| Exemplars | ≤ 500 | 3–5 × (≤ 200-char inbound + ≤ 400-char reply) |
| Edit lessons | ≤ 120 | 0–2 lines |
| Thread | ≤ 1,200 | Drop oldest first |
| Task + targets + instruction | ≤ 150 | |
| **Input total** | **≈ 3–3.5k** | Output `max_tokens` 300 (single) / 700 (3 variants) |

Applying rule changes in the batch sweep (not per send) keeps block 2 stable for long stretches, so most draft calls hit the cache (reads at 0.05–0.1× base input per the caching docs).

**Post-generation lint** (`style/rule-lint.ts`, deterministic): check the output against active `avoid` rules, AI_TELLS not natively used, the greeting rule, and `length > 1.6 × target`. On violation, do **one** retry appending `"Fix: {violations}"`. If it still fails, ship the draft and record `generationContext.lintViolations` (a metric, not a blocker). This is what makes "DealDock never says X anymore" a guarantee rather than a hope.

**Persisted per draft:** `generationContext = { ruleIds, exemplarMessageIds, lessonDraftIds, lintViolations, promptVersion }`. This powers "Why this draft", contradiction accounting (§4.2) and attribution.

**Heuristic pipeline:** reads greeting/signoff from active rules (falling back to the card), truncates to the target length, and its brand template drops "Thanks for reaching out".

### 4.6 (f) Regenerate-with-instruction and variants

API (`apps/api/src/routes/threads.ts`):

```text
POST /threads/:id/draft
  body: { replyToMessageId?: string, chips?: FeedbackChip[] (≤4), instruction?: string (≤200), variants?: 1 | 3 }
  → if a live draft exists and chips/instruction present: insert DraftFeedback(previousDraft, chips, note=instruction)
  → instruction text = chips.map(CHIP_INSTRUCTION).concat(instruction).join(" ")  (stored on the NEW draft's `instruction`)
  → label = classification label of replyToMessageId (fallback thread.topLabel; if none → 409 "classify_first", no silent brand_deal default)
  → variants=3: one call with tool draft_variants {variants:[{tag: "closest"|"shorter"|"warmer"|"more_hinglish"|"more_direct", text}]}
       axes chosen = the 2 axes with the LEAST confident rules for this scope (e.g. no active length rule → offer "shorter")
       stored on ONE Draft row: body = variants[0], alternatives = rest   (preserves the one-live-draft-per-thread invariant in createDraft)
POST /drafts/:id/choose { tag }       → body := alternative.body, chosenAlternative = tag, status "edited"
                                        → evidence: +0.5 on the chosen axis's rule key (pairwise preference), e.g. tag "shorter" → length/shorter
POST /drafts/:id/feedback { chips, note? } → DraftFeedback without regenerating (thumbs-down style)
```

Rules for this flow:
- Edit distance at send is always against the body the creator last saw (after `choose`). The existing `editDistance(draft.body, finalText)` in `persistSendIntent` already does this, because `choose` rewrites `body`.
- `wrong_facts` chip regenerates with "Do not state any price, date or availability that isn't in the thread or creator context". It is counted in a `factErrorRate` metric and never style evidence.
- The auto pre-generated draft in `apps/worker/src/consumers/drafting.ts` stays single-variant (cost). Variants are on demand ("Show 2 other takes").

---

## 5. Metrics

Stored per sent draft: `editRatio`, `label`, `kind`, `promptVersion`, `modelVersion`, `sentBySeat.role`, `generationContext.lintViolations`.

| Metric | Definition | Shown where |
|---|---|---|
| **Voice match** (PRD north-star for voice) | share of sent drafts with `editRatio < 0.2` (`MINOR_EDIT_THRESHOLD`) | Voice Studio hero, weekly digest |
| Sent as-is | share with `editRatio === 0` | Studio (Superhuman-style headline) |
| Avg edit | mean `editRatio` of sent drafts | Studio trend line ("31% → 9%") |
| Per-label voice match | above, grouped by `label` (+ `nudge`) | Studio per-type chips |
| Draft usage | sent drafts / drafts created for threads the creator then replied to (any origin) within 48h. A native reply after a ready draft = draft ignored | Internal, Studio "you used 8 of 10 drafts" |
| Rules learned | count of rules promoted, plus edits that taught them | Studio |
| Lint violation rate | drafts with ≥ 1 violation after retry | Internal quality gate |
| Fact error rate | drafts with `wrong_facts` chip / drafts shown | Internal quality gate |

**Trend computation** (on read, no snapshot table): `SELECT date_trunc('week', "sentAt") wk, label, count(*), avg(editRatio), sum((editRatio < 0.2)::int) FROM "Draft" WHERE orgId=$1 AND status='sent' AND thread.igAccountId=$2 AND sentAt > now() - 12 weeks GROUP BY 1, 2`. A week bucket is shown only when n ≥ 5. Below that, the UI says "5 more sends to unlock your trend". Per-label shows raw counts ("7 of 9") when n < 10. No percentages on tiny samples.

**"Your drafts are getting better" UI:**
- Hero: big "Voice match 82%" with an 8-week sparkline and a delta chip ("▲ 23 pts since week 1").
- Narrative line generated from data, not marketing copy: "In week 1 you edited 31% of each draft on average. This week: 9%. DealDock learned 6 things from 23 of your edits."
- Milestones (once each): first week ≥ 70% voice match (PRD target), first 10 sends as-is, first rule learned.
- Per-type rows: Brand 88% · Coaching 74% · Nudges 91%, each with "what changed" (the rules promoted for that scope).
- Honesty guard: if voice match rises while draft usage falls, show nothing celebratory. Low edits on fewer drafts is not improvement.

**Internal eval** (CI, `packages/ai/evals`): see §7.1.

---

## 6. UX: Voice Studio

A dedicated screen (per creator in Roster), reachable from nav, from the composer's "Why this draft", and from "DealDock noticed…" toasts. The tone is a personal studio, not a settings form: show the creator their own texting fingerprint.

### 6.1 Sections

1. **Header: Voice match.** Score, sparkline, status pill: Getting to know you (< 10 samples) / Learning / Tuned (≥ 40 samples and ≥ 70% match for 2 weeks). Primary action **Try it**. Secondary actions: Refresh voice, Pause learning.
2. **Your texting fingerprint** (read-only measured stats per scope, with tabs All / Brand / Coaching / Course / Nudges):
   - typical length (words) as a little bar
   - emoji habit (top 3 emojis actually used)
   - Hinglish mix as a slider-like gauge ("~30% Hindi words")
   - go-to openers and signoffs with share
   - capitalization and punctuation habits ("starts lowercase 70% of the time").
   Each item has "Make this a rule" or "Not me", which creates a user-authored rule or a muted key.
3. **What DealDock learned** (the rule list), grouped: Openers & signoffs · Length & structure · Language mix · Emoji & punctuation · Phrases you avoid · Phrases you love · How you negotiate (freeform). Each rule row has:
   - the creator-facing text; scope badge (All / Brand / Coaching / Nudge); source icon (learned from edits / from your messages / from feedback / written by you)
   - evidence: "Seen in 6 of your edits · last 3 days ago". Expand for ≤ 3 before → after snippets.
   - actions: **Pin** (never fades), **Edit text**, **Change scope**, **Mute** ("Not me": suppressed forever), **Delete** (allows relearning). Fading rules show a muted "fading, not seen in a while" state.
4. **Noticed, not sure yet** (top 5 candidates by support): one-tap **Yes, that's me** (→ pinned) / **Not me** (→ muted). This makes candidates collaborative and speeds cold start.
5. **Add your own rule.** Free text ≤ 120 chars plus a scope picker, with suggestions from repeated regenerate instructions ("You asked for 'shorter' 4 times. Make it a rule?").
6. **Generic AI phrases we avoid for you.** The built-in AI_TELLS list with per-item toggles. Items the creator natively uses are shown as "You use this, so we keep it".
7. **What we learn from (sources and privacy).** Counts: "142 of your messages · 23 edited drafts · 3 samples you added". Excluded: "38 personal chats, 12 templates, 4 AI-sounding". "Review samples" opens a list with per-message include/exclude (writes `excludedMessageIds`). "Learn from my team's edits" toggle (Roster). Consent toggle with plain-language explanation; revoke wipes rules and samples.
8. **Try it (playground).** Paste or pick an inbound DM, choose a type, and see **"Generic AI" vs "You"** side by side, with the applied rules highlighted in the "You" draft. This is the onboarding aha moment and a sales-demo asset. Costs one extra call on demand.

### 6.2 Moments outside the Studio

- **Composer chips** under every draft: Too long · Too formal · More Hinglish · Add emoji · Less salesy · Wrong facts. A tap regenerates in < 5s. Long-press records feedback without regenerating.
- **"Show 2 other takes"** link gives variants (§4.6).
- **"Why this draft"** popover: "Used 4 of your rules and 3 of your past replies" with links. Draws on Gmail's "Sources" pattern.
- **"DealDock noticed…" toast** after a rule is promoted (shown on next app open, max 1/day): *"DealDock noticed you never say 'Thanks for reaching out' (6 edits). We've stopped using it."* [Undo] [See all]. Undo mutes the rule.
- **Weekly digest card** on Home: "This week DealDock learned: you sign off brand replies with 'Cheers ✨'. Voice match 84% (▲6)."
- **Coaching copy** in the first week (from Fyxer's guidance): "Tip: tweak drafts rather than deleting them. Every edit teaches DealDock your style."

### 6.3 Cold start (onboarding)

- Run §4.1 as soon as consent is granted and the 30-day history scan lands. Show the fingerprint immediately: "Here's how you text" is the first premium moment.
- **Voice quiz** (60 seconds, optional, skippable): 3 realistic inbound DMs (brand brief, coaching lead, ghosting follow-up). The creator types how they'd reply. Saved to `seedSamples`, weight 1.0, used as exemplars and for measured stats.
- **"Which sounds like you?"**: 3 rendered replies to one brand DM (short and breezy / warm and detailed / Hinglish-friendly). The pick creates `feedback_chip` evidence (weight 1.5) for length/language rules. It doesn't activate rules alone, but tips them over with the first real edit.
- Copy sets expectations (PRD risk §10.1.3): "Your first week is voice-tuning. Drafts get noticeably closer with every edit."

---

## 7. Test plan (pure functions, vitest, in `packages/ai/test/style/*.test.ts`)

**text-features**
- `tokenize` keeps Devanagari words with matras intact (`"नमस्ते जी"` → 2 tokens) and splits emoji as their own tokens.
- `cmi`: pure English → 0. Pure romanized Hindi → 0. `"haan bhai rates bhej do, will check"` → in (0.3, 0.6). Fewer than 3 classified words → 0. "to"/"me" are not counted as Hindi.
- `greetingOf`/`signoffOf`: `"Hey hey! Loved this"` → `"Hey hey!"`. 6-word first clause → `""`. Single-line message → no signoff.
- `isContentSpan`: `"₹25,000"`, `"12 Nov"`, `"https://…"`, `"@brand"` → true. `"thanks so much"` → false.
- `trigramJaccard` symmetric, 1 for identical, 0 for empty. Letter-run collapse makes `"pleaseee"` ≈ `"pleasee"`.

**sample-filter**
- Excludes: user-excluded ids, link-only, `personal`/`spam` scopes, `automation`, `dealdock` with `editRatio === 0`.
- Template: the same text in 3 threads → one kept, flagged with weight × 0.3.
- AI-tell filter excludes ≥ 2-tell messages, and **self-disables** when > 50% of the corpus is flagged.
- `provenanceWeight` table, including the non-creator seat halving.

**measureStyle / seedRulesFromMeasured**
- Scopes with n < 5 are omitted. Greeting rule only when share ≥ 0.4 and n ≥ 8. Avoid-list excludes AI tells the creator natively uses ≥ 2%.

**editSignals** (table-driven fixtures: draft, final → expected keys)
- Greeting swap `"Thanks for reaching out!"` → `"Hey hey!"` gives `greeting{value:"Hey hey!"}`, and **no** duplicate `avoid:` for the same span.
- Signoff added/removed/changed.
- Removed 2–8-word non-content phrase gives `avoid:<norm>` with `replacement` when an insertion sits at the same index.
- Price-only edit (`₹20k` → `₹25k`) gives `fact_edit` and nothing else.
- Length 60 → 30 words gives `length{direction:"shorter"}`. 60 → 58 gives weak support only.
- Emoji 0 → 2 gives `emoji{direction:"more"}`. CMI shift +0.2 gives `language_mix{more_hindi}`. Devanagari introduced gives `script`.
- Full rewrite (`editRatio > 0.8`) gives only global signals (no phrase signals).
- Identical text gives `accepted`.

**rule evidence / promotion**
- `decay` halves at exactly 45 days. Monotonic.
- Promotion requires all of: support ≥ 3, distinct drafts ≥ 3 (2 for chips), threads ≥ 2, contradiction ≤ 25%, creator evidence. Each condition is tested failing alone.
- Non-creator evidence counts half and cannot promote alone.
- Active → candidate when decayed support < 1.5 (simulate 90 days idle) or contradiction > 40% with c ≥ 2.
- `pinned`/`user_authored` never change status. `muted` ignores evidence.
- Greeting value distribution: argmax switches after enough new evidence. Only one active greeting per scope.
- `avoid:X` + `prefer:X` cancel, and the newer wins.
- Cross-scope generalization creates an `all` row when the same key is active in 2 scopes.

**Claude distillation validation** (no network: feed fixture tool outputs)
- Drops proposals with < 2 valid evidence ids, ids not in the batch, or phrases absent from the cited texts.
- Rejects an `avoid` phrase used natively in ≥ 5% of messages.
- `matches_rule_id` reuses the key, and Claude output never sets status.

**selectExemplars**
- Same-label and same-language candidates outrank others at equal similarity.
- MMR: given 3 near-duplicate high scorers and one diverse lower scorer, the diverse one is picked for k = 3.
- Caps: ≤ ⌊k/2⌋ untouched-DealDock exemplars. ≥ 1 native when any native exists.
- Ordering: most relevant last. Empty pool → [] (no throw).

**prompt assembly / budget** (`buildDraftPrompt`)
- Snapshot test of block order (static → voice → examples → lessons → thread → task).
- Rules deduped by key with the specific scope winning, capped at 12 with pinned first.
- Thread truncation drops oldest first to fit 1,200 tokens (use a char/4 estimator).
- Avoid list excludes natively used phrases. Instructions from chips render in `<task>`.
- `PROMPT_VERSION` bumped. The voice block is byte-identical across two drafts for the same creator (cache stability), so exemplars and the thread never leak into system.

**rule-lint**
- Detects avoid phrases case-insensitively, greeting mismatch and over-length. Produces a single retry instruction string.

**Repository and integration tests** (`packages/db/test`, existing harness):
- Revocation deletes `VoiceRule`s, `seedSamples` and `DraftFeedback` notes for that account only (a Roster sibling account is untouched).
- A learning write racing revocation is refused (`voice_consent_required`).
- `persistSendIntent` sets `origin=dealdock` even when the echo row already exists.
- `learnedAt` makes the sweep idempotent (double-run gives the same support).

### 7.1 Offline eval (time split, PRELUDE metric)

`packages/ai/evals/voice-replay.ts`: for each pilot account with ≥ 20 edited sends, learn rules and exemplars only from data before day T. For each later sent draft, regenerate with v1 (card only) and v2 (this design). Compare `editDistance(regenerated, finalText) / len(finalText)`. Report the median and the share under 0.2, per label. Also run an LLM-judge pairwise check ("which reply reads more like the creator's past messages?") to catch the failure mode where shorter, blander drafts win on edit distance alone. Ship v2 only if it beats v1 on both, and fact-error rate does not rise. Heuristic-mode rows (`heuristic-fallback-1`) are excluded, consistent with existing eval hygiene.

---

## 8. Implementation map (files)

| File | Change |
|---|---|
| `packages/db/prisma/schema.prisma` + migration | §3 additions and backfill SQL |
| `packages/core/src/index.ts` | `FEEDBACK_CHIPS`, `CHIP_INSTRUCTION`, `QUEUES.voiceLearning`, `VoiceLearningJob` schema. `editRatio` already exists |
| `packages/ai/src/style/{text-features,sample-filter,measure,edit-signals,rule-evidence,exemplars,draft-prompt,rule-lint}.ts` | New pure modules (§4) |
| `packages/ai/src/voice.ts` | Extraction takes filtered/stratified samples. Add `distillEditRules()` (Claude) + validation |
| `packages/ai/src/prompts.ts` | `buildDraftSystem` → static + voice blocks. `buildDraftUser` (examples/lessons/thread/task). `PROMPT_VERSION = "2.0.0-voice"` |
| `packages/ai/src/claude-pipeline.ts` | Two system blocks (cache on block 2), user turn from `buildDraftUser`, variants tool, one lint retry. Return `generationContext` |
| `packages/ai/src/heuristic-pipeline.ts` | Use rules for greeting/signoff/length. Drop "Thanks for reaching out" |
| `packages/ai/src/types.ts` | `CreatorContext.voice {rules, measured, avoidList}`. `DraftInput {exemplars, lessons, instruction, variants, inboundLanguage}`. `DraftResult {alternatives?, generationContext}` |
| `packages/db/src/repos/voice.ts` | `getSentSamples` → `loadVoiceCorpus` (provenance join, filters). Rule CRUD (scoped by `orgId` + `igAccountId`). `applyRuleEvidence` (FOR SHARE consent check). Revocation wipes |
| `packages/db/src/repos/creator-context.ts` | Add active rules + measured. New `getDraftVoiceContext(orgId, igAccountId, {threadId, replyToMessageId})` → exemplars + lessons |
| `packages/db/src/repos/drafts.ts` | `createDraft` stores `label`, `instruction`, `alternatives`, `generationContext`. `persistSendIntent`/`recordSend` set `editRatio`, `origin=dealdock` (in upsert `update` too) |
| `packages/db/src/repos/ingestion.ts` | Outbound echo → `origin` (`automation` if `app_id` present and ≠ ours, else `native`) |
| `packages/db/src/repos/metrics.ts` | Voice trend/per-label query using stored `editRatio` |
| `apps/worker/src/consumers/voice-learning.ts` | Sweep: edit signals → evidence → status. Batch distillation. Measured refresh. Housekeeping |
| `apps/worker/src/consumers/drafting.ts` | Fetch voice context + exemplars, persist `generationContext` |
| `apps/api/src/routes/threads.ts` | Draft body (`replyToMessageId`, chips, instruction, variants), `/drafts/:id/choose`, `/drafts/:id/feedback`. Remove the silent `brand_deal` default |
| `apps/api/src/routes/settings.ts` (or new `voice.ts`) | `GET /voice/:igAccountId` (fingerprint, rules, candidates, metrics, sources). `PATCH /voice/rules/:id` (pin/mute/edit/scope). `POST /voice/rules`. `DELETE /voice/rules/:id`. `PUT /voice/samples` (exclude/include, seed samples). `PUT /voice/learning` (pause). Resample takes `igAccountId` |
| `apps/web` | Voice Studio screen, composer chips, variants, "Why this draft", noticed toast, digest card |

**Phasing:** P0 (pilot): provenance, filtering, measured stats, deterministic signals, VoiceRule plus promotion, exemplars, prompt v2 plus lint, chips/regenerate, metrics, Voice Studio list/pin/mute. P1: Claude batch distillation, edit lessons, variants, playground, voice quiz. P2: pg_trgm/Voyage retrieval only if the eval demands it.

---

## 9. Risks and open questions

- **Instagram echo `app_id`** is documented for Messenger, not confirmed for Instagram. Automation detection falls back to template heuristics until verified against real webhook payloads.
- **Goodhart risk:** edit-distance optimisation rewards bland, short drafts and rubber-stamping. Mitigated by the LLM-judge in eval, the draft-usage metric and the honesty guard in UI.
- **Hinglish lexicon** is small and hand-built. Expect misses on spelling variants. Measure CMI agreement against the classifier's `language` label on pilot data before trusting targets.
- **Personal threads** are excluded from the voice corpus by default (privacy and register mismatch). Some creators sell to friends-of-friends, which could cost signal. Revisit with pilot data.
- **Cache minimums** differ by model. If `DRAFT_MODEL` is ever set to Haiku 4.5, the voice block (~1.5k) is below 4,096 and won't cache.
