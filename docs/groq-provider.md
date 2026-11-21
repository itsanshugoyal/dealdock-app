# Groq provider setup and evaluation

Groq is the current local default when a Groq key is configured. The starting model is `openai/gpt-oss-120b` for classification, drafting, style extraction, and edit distillation. It is a production-listed model with strict JSON-schema output, but its DealDock accuracy and voice fidelity are not established until the existing real-model and blind-review gates pass. Groq responses use a `groq:` model prefix and a provider-specific prompt version. The heuristic remains separately stamped and development-only.

The free-plan [model limits](https://console.groq.com/docs/rate-limits) are finite and vary by account. Groq lists `qwen/qwen3.8-27b` as a [preview model for evaluation only](https://console.groq.com/docs/models), so it is not a production replacement even when its diagnostic accuracy looks promising. Review provider data terms and consent before processing real messages with any model.

Set `AI_PROVIDER=groq`, `GROQ_API_KEY`, `GROQ_CLASSIFY_MODEL`, and `GROQ_DRAFT_MODEL` in the API and worker's own secret environments. Model variables default to `openai/gpt-oss-120b` when unset. The key is server-only; never put it in web/public configuration. For a local invocation from the repository root, Node 22 can load the gitignored `.env` explicitly, for example `node --env-file=.env apps/api/dist/index.js` or `node --env-file=.env apps/worker/dist/index.js` after building. An already-running process must be restarted with that environment to pick up changes. A fictional web demo may not use the API at all.

To use Anthropic instead, set `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `CLASSIFY_MODEL`, and `DRAFT_MODEL`. Selection is explicit and fail-closed: a missing selected credential or provider failure never silently sends creator data to the other provider, and never enables the heuristic in production. If no provider is explicitly selected, a configured Groq key takes precedence over Anthropic.

CI retains the manually dispatched `run_claude_quality` gate and adds `run_groq_quality`, using repository secret `GROQ_API_KEY` and optional variables `GROQ_CLASSIFY_MODEL` and `GROQ_DRAFT_MODEL`. Both run the same real-model thresholds. The evaluation retries an individual Groq case up to three times when the provider supplies a retry time of at most 60 seconds; other provider errors or exhausted limits fail the gate rather than producing a fallback score. No hosted gate has been run merely by adding the workflow.

For a free-plan local diagnostic that may need to continue after a quota reset, set `DEALDOCK_EVAL_CHECKPOINT` to a path in an existing, gitignored directory and run `node --env-file=.env --import tsx packages/ai/evals/run-eval.ts` from the repository root. The checkpoint contains only synthetic fixture results and is tied to the model, dataset, prompt and relevant source files; mismatches fail rather than mixing results. Checkpointed runs cannot run in CI and do not replace a fresh hosted quality gate. Remove the variable to run the normal, non-resumable gate. The Groq client also retries at most twice for the specific `json_validate_failed` provider error using the same strict schema; other HTTP 400 errors are not retried.

To generate a separate 50-draft review file without overwriting the existing sample, set `DEALDOCK_DRAFT_SAMPLE_OUT` to a new path and run `node --env-file=.env --import tsx packages/ai/evals/draft-sample.ts`. For a local Groq run that may span quota resets, also set `DEALDOCK_DRAFT_CHECKPOINT` to a path in an existing, gitignored directory; the synthetic checkpoint is bound to the model, prompts, source, profiles and cases. The output is model-blind and uses three fictional creator voices; its separate `.metadata.json` records the exact model, prompt, and original sample hash. The generator rejects existing output unless `DEALDOCK_DRAFT_SAMPLE_ALLOW_OVERWRITE=1` is explicitly set. Have independent reviewers score the sample A/B/C without opening the metadata first; generating it alone does not pass the ≥70% A+B gate.

From PowerShell at the repository root, after the free-tier quota allows more requests:

```powershell
New-Item -ItemType Directory -Force -Path .turbo/dealdock-evals | Out-Null
$env:AI_PROVIDER = 'groq'
$env:GROQ_CLASSIFY_MODEL = 'openai/gpt-oss-120b'
$env:GROQ_DRAFT_MODEL = 'openai/gpt-oss-120b'
$env:DEALDOCK_EVAL_CHECKPOINT = '.turbo/dealdock-evals/groq-120b-v2.0.4.json'
node --env-file=.env --import tsx packages/ai/evals/run-eval.ts
$env:DEALDOCK_DRAFT_SAMPLE_OUT = 'docs/draft-review-sample-groq-2026-11-04.md'
$env:DEALDOCK_DRAFT_CHECKPOINT = '.turbo/dealdock-evals/drafts-120b-v2.0.4.json'
node --env-file=.env --import tsx packages/ai/evals/draft-sample.ts
```

If a command stops on HTTP 429, rerun that same command after the indicated delay. Checkpoints from `2.0.3-voice` must not be reused for `2.0.4-voice`. The 20B diagnostic was incomplete and its old checkpoint cannot be resumed with the revised prompt; its completed slices already fail the acceptance thresholds.

Before sending real creator messages to Groq, the business owner must review Groq's [data controls and retention](https://console.groq.com/docs/your-data), data location, applicable terms, privacy notices and creator consent. Groq says inference data is not retained by default except for reliability or abuse investigations, where inputs and outputs can be retained for up to 30 days; it says retained customer data is stored in US GCP buckets. Groq documents a Zero Data Retention option for all customers under [Organization → Data Controls](https://console.groq.com/settings/data-controls); an organization admin must decide whether to enable it and review the affected features. These settings have not been inspected or changed for this account. A local fictional smoke check does not validate those obligations or live Instagram delivery. Store keys in a secret manager, not source control, logs, tickets or chat.

## Local evidence, 3 November 2026

The 16-case diagnostic uses one synthetic English and one Hinglish example per category, plus synthetic creator-voice, saved-price, unknown-fact and inbound-instruction probes. With the earlier `2.0.1-voice` prompt, `openai/gpt-oss-120b` classified 11/16 correctly and `openai/gpt-oss-20b` 10/16; both mislabeled the two sampled spam examples. `qwen/qwen3.8-27b` classified 13/14 completed cases correctly but returned two HTTP 400 errors even after bounded JSON-generation retries; it produced two distinct priced replies and a style card, but no validated rule from the sample edits. These small, partly incomplete comparisons are diagnostics, not quality-gate or parity results.

The local 258-case `openai/gpt-oss-120b` diagnostic with `2.0.3-voice` failed: 86.0% exact-label accuracy, 70.0% spam accuracy, 78.6% uncertain-case review coverage, and an approximately zero English/Hinglish accuracy gap. Spam must reach 85% and uncertain-case review coverage 95%; the diagnostic is not a hosted CI gate. Half of `other_commerce` cases were also misclassified as brand deals. The 20B comparison stopped at 223/258 cases after a free-tier HTTP 429. Its completed course and fan slices scored 21/28 (75.0%) and 24/30 (80.0%), both below the 85% gate; its 19/27 spam results also make reaching 85% impossible even if all remaining spam cases are correct. A 50-draft sample hit the free quota after two cases; one draft rounded ₹5,999 to ₹6,000 and invented course access and scholarship details. The evaluation cases are synthetic, and some are slot-expanded variations rather than independent real-world examples.

The `2.0.4-voice` prompt sends exact offer amounts, instructs the model not to round, and treats unspecified conditions as unknown. In one live fictional probe, 120B and 20B both quoted ₹5,999 correctly but invented course-access terms and failed to flag unanswered scholarship information. Qwen quoted the price and listed both missing facts in that probe, but another Qwen draft returned HTTP 400 and Qwen remains preview-only. These isolated results are not pass rates. Human review and the independent draft-quality gate remain mandatory. Since the prompt changed, the complete classification and blind-draft gates must be repeated for this version. The `packages/ai/evals/compare-groq-models.ts` diagnostic can be repeated with `GROQ_COMPARE_MODELS` set to a comma-separated list of model IDs.

## Local evidence, 4 November 2026

The free Groq key is a stand-in for testing. A paid model will replace it, chosen with the same harnesses: the 258-case classification gate and the blind 50-draft review. The results below show which models on this key are useful for testing now. They do not choose the production model, and nothing in the product was tuned to free-plan limits.

- **Classification**, 16 synthetic cases with `2.0.4-voice`:
  - `openai/gpt-oss-120b`: 13/16. It missed the Hinglish course inquiry, the Hinglish other-commerce case and the Hinglish uncertain case.
  - `openai/gpt-oss-20b`: 14/16, but it labelled the English spam example a brand deal.
  - `qwen/qwen3.8-27b`: 13/14 of the cases that completed; two returned HTTP 429.
- **Drafts**: the free plan allows 8,000 tokens per minute for these models. Each draft reserves 3,072 output tokens, and a lint-fix retry can double that, so most 120B and 20B draft probes returned HTTP 429.
  - 120B completed two probes across two runs. Both quoted the exact saved price in the right creator's voice.
  - Qwen completed all five probes:
    - it quoted exact prices in both voices;
    - with no saved price, it asked for the budget and listed the missing facts instead of inventing a price;
    - it ignored an instruction planted in the inbound message;
    - it flagged the unknown scholarship terms.
  - Qwen's edit-learning probe returned no rule.
- **Scam screening**: `openai/gpt-oss-safeguard-20b` was given a written scam policy and judged 34 of 35 synthetic cases correctly. Some cases are slot-expanded variants of the same message.
  - It caught 17 of 18 spam messages and cleared all 17 brand deals, including every hard case.
  - Its one miss was a shoutout-exchange barter.
  - For comparison, the main classifier's spam accuracy in the 258-case run was 70%.
  - This policy-plus-small-model pattern is worth repeating with the paid provider as a scam check before drafting. The experiment script is `.turbo/safeguard-experiment.ts`, which is gitignored and uses synthetic golden-set text only.

The key also lists `whisper-large-v3` and `whisper-large-v3-turbo` (transcription), `meta-llama/llama-prompt-guard-2-22m` and `-86m` (prompt-injection screening), `openai/gpt-oss-safeguard-20b` (policy classification), Orpheus text-to-speech voices and `allam-2-7b`. None of these is a better general drafting model than the three above. Whisper and Prompt Guard could cover voice-note transcription and injection screening in tests, but neither is wired in.

## OpenAI in production, 7 November 2026

Production uses OpenAI. Groq stays the development provider and the production fallback. The settings are:

- `AI_PROVIDER=openai`, `OPENAI_API_KEY`;
- `OPENAI_CLASSIFY_MODEL` and `OPENAI_DRAFT_MODEL` (default `gpt-6-luna`);
- `OPENAI_REASONING_EFFORT` (default `high`);
- `AI_FALLBACK_PROVIDER=groq` with `GROQ_API_KEY`.

The fallback answers only when an OpenAI call fails: an outage, a rate limit or unusable output. Every result keeps its own model stamp (`openai:…` or `groq:…`), so it stays visible which provider answered. Set the same variables on the API and the worker. Groq's free plan is rate-limited, so a paid Groq plan is needed before the fallback can absorb real traffic.

GPT-6 Luna is OpenAI's efficient model ($0.10 input, $0.50 output per million tokens, structured outputs). OpenAI calls send `reasoning_effort` instead of a temperature, and reserve extra completion tokens for reasoning.

**Live check on fictional messages:**

- A brand deal was classified correctly, and a "registration fee" message was classified as spam.
- A coaching reply quoted the saved ₹18,000 price exactly, in the creator's style, with no lint issues.
- Warm timings at `high`: about 2.2 s per classification and 5.5 s per draft. At `low`, drafts take about 3–4.7 s.

**258-case classification gate.** Both runs used `high` effort. The first run (`2.2.0-email` prompt) failed on course enquiries. The `2.4.0-course` prompt then made two changes. Course enquiries now cover practical pre-purchase questions about a batch, recordings, refunds, EMI, discounts or eligibility, while coaching means personal help. Spam now needs a scam or bait signal. The rerun passes the gate. Logs: `.turbo/openai-luna-eval-20261107.log` and `.turbo/openai-luna-eval-20261107-course.log`.

| Measure | `2.2.0-email` | `2.4.0-course` |
|---|---|---|
| Exact-label accuracy | 93.0% | **97.7%** |
| Spam | 100% | 100% |
| Uncertain cases sent to review | 100% | 100% |
| Inbox precision | 97.0% | 98.3% |
| Brand deal | 92.1% | 98.7% |
| Coaching lead | 96.7% | 90.0% |
| Course enquiry | 71.4% (fails) | **96.4%** |
| Fan | 100% | 100% |
| English / Hinglish | 92.7% / 92.6% | 96.9% / 98.0% |
| Hard cases | 82.5% | 97.5% |

Coaching dropped by two cases: two "how does working with you start" questions went to review, which is safe, and one "new batch" question was labelled a course. One brand deal ("reply with your manager's contact") is still labelled spam, down from four.

The blind 50-draft review is still pending. Run the evals with `tsx` from `packages/ai`, for example `AI_PROVIDER=openai AI_FALLBACK_PROVIDER= npx tsx --env-file=../../.env evals/run-eval.ts`. The eval retries a dropped connection up to three times per case.
