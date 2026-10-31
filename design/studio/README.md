# DealDock Studio — working inbox concept

A new direction, independent of the rejected Reply desk design. Open `dealdock-studio.html` directly, or serve the design directory with `node design/serve.mjs` and open `/studio/dealdock-studio.html`.

One fictional workspace demonstrates the conversation-to-reply-to-confirmed-sale loop, a source-visible writing-style studio, and separate creator profiles. Switching creators changes the queue, style samples, writing preferences and revenue record. A compact work list opens into a focused conversation and decision workspace. Style changes affect a deterministic local preview; no AI model is called or trained.

Try Isha's payment question; check the availability fact; edit, review and approve the local reply; record an exact confirmed amount; inspect Revenue. In Writing style, exclude sample replies, change the greeting/language/length, and switch creators. Revoking preview consent clears only that creator's fictional samples and unsent drafts. Audio is explicitly unavailable rather than simulated as working.

This is a design proposal. No account, payment, API or real message is connected. All state resets on refresh. Creator-aware style editing and multi-creator UX are proposed, not production acceptance evidence. Actual voice limitations are recorded in `docs/voice-and-audio-audit.md`.

The portable file embeds Geist and Geist Mono with the included OFL license. Rebuild it with `npm run design:package`; check its actual money/parser functions, portability and no-API boundary with `npm run design:check`. CI runs these artifact checks. No images, external fonts, network dependencies or browser storage are used.

Browser verification covered desktop and a 390px phone viewport, creator profile separation, greeting/language/length controls, sample exclusion, word flags, consent withdrawal, exact confirmed-sale amounts, the closed-conversation profile edge case, availability round-tripping, empty-reply blocking and explicit local approval. These are prototype checks, not production-provider or model-quality evidence.
