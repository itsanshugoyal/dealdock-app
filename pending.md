# Pending engineering and launch gates

Recorded 1 November 2026 from the [product audit](docs/ux-and-product-audit-2026-11-01.md). Local tests and demo walkthroughs do not establish live-provider readiness. The remaining work below is not implemented by the audit-hardening PR.

## Engineering — before enabling the affected feature

- [ ] **Creator-specific business facts:** store and retrieve business summaries and price context per Instagram account. Test two creators with different offers so agency prompts cannot mix their facts.
- [ ] **Consent ownership:** map the person authorized to grant writing/speaking consent to the particular creator account. An organization role alone is insufficient.
- [ ] **Speaking-voice deletion:** retain vendor voice identifiers until deletion succeeds; use durable retryable deletion work when replacing or withdrawing a voice.
- [ ] **Audio approval:** bind approval to the exact previewed clip, text and voice revision, and prevent duplicate synthesis. Keep customer audio sending disabled until these controls and provider validation pass.
- [ ] **Previously learned influence:** offer an explicit provenance-aware reset/rebuild after sample exclusion. Forward filtering and stale-result rejection are implemented; exclusion does not retrospectively erase existing rules or style-card influence.

## Owner/account-dependent gates

| Action | Owner | Acceptance evidence |
|---|---|---|
| Configure Anthropic key and real classification/drafting models; run M2 evaluation | Anshu | At least 85% top-level classification accuracy; Hinglish parity gap no greater than 3 percentage points. Heuristic output does not qualify. |
| Regenerate 50 real-model drafts and blind-score them independently | Both founders | At least 70% A/B ratings, with recorded scores. |
| Complete Meta Business verification and app review | Anshu/account owner | Approved permissions, confirmed callback/origins, real incoming message, approved reply and delivery receipt, disconnect/reconnect. Verify available history and Requests coverage. |
| Verify Clerk organizations, invitations and roles | Anshu | Real account flows and correct deployed callback/origin configuration; deployed auth bypass remains unset. |
| Configure Razorpay test plans and Paddle sandbox prices | Anshu | Charge, failure, cancellation and reconciliation checks; agreed pilot billing terms before charging. |
| Configure VAPID and verify installed-device notifications | Anshu | Delivery evidence on intended iOS/Android devices and understood quiet-hour behavior. |
| Validate optional speech provider and rights | Anshu/creator owner | Account-specific consent/rights, processor terms, deletion proof, language listening tests and actual Meta audio/disclosure delivery. No purchase is required by this task. |
| Approve deployment separately | Anshu | Secrets separation, migrations, backup/restore, readiness and monitoring checks for Vercel/Railway/Neon/Redis. No deployment has been performed here. |

## Private-pilot improvements

- [ ] Measure first useful draft and first confirmed sale with creators on actual phones/networks.
- [ ] Measure large-inbox latency/memory; move from complete cursor scans to server-filtered incremental lists with exact scoped aggregates when warranted.
- [ ] Validate quiet-hour expectations. Notifications are currently suppressed rather than deferred; no weekly digest scheduler exists.
- [ ] Evaluate learning quality and historical authorship ambiguity. Native outbound direction does not identify the individual author.
- [ ] Improve and validate audio-only review navigation, transcript fallback, and inaccessible/expired-media recovery before promising complete incoming-audio support.

## After validation

Additional channels, semantic search, deeper agency analytics and database RLS remain demand-led work. Keep the first pilot text-first and personally onboarded; enable agency/audio promises only after their specific gates pass. Nothing auto-sends, and the worker must retain zero message-send capability.
