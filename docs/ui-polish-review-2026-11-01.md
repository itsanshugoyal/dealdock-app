# Local visual polish review — 1–2 November 2026

The earlier audit fixes and `pending.md` were published as `8e26be0` in [PR #2](https://github.com/itsanshugoyal/dealdock-app/pull/2), targeting `main`. Both hosted GitHub CI jobs passed. The automatic Vercel preview failed; the connected CLI account cannot access its project logs, so the cause remains unverified.

This subsequent polish is local on `codex/ui-polish-local`. It has not been committed or pushed. The public website, backend milestones and remaining agency/audio engineering gates are outside this visual pass.

> **Superseded in part on 4 November.** A screen-by-screen review found that this pass had moved the app away from [DESIGN.md](../DESIGN.md). The palette, the hero cards, card and button shapes, emerald navigation and the draft bubble were restored. The inbox scroll arrows and the header "Check" link were replaced by fitting underline tabs, a peeking chip rail and a Check-view sorting banner. Its functional fixes below remain. The "4 November restoration" note in DESIGN.md lists the changes; [the verification section](#verification-4-november) records the checks.

## Screens reviewed and changes

| Screen | Visual or interaction finding | Local result |
|---|---|---|
| Offers | The explanation panel squeezed cards into narrow columns. Title lengths displaced prices; repetitive switch labels and oversized mobile rows obscured the offer itself. | Full-width catalog, consistent title/price placement, explicit Edit affordance, compact scoped draft switches, clear paused cards and concise expandable guidance. Pending switch writes disable repeated input. Mobile rows size to their contents. |
| Today | Long phone titles and weekly statistic labels truncated. | Titles and statistic labels wrap; existing urgent recommendation, creator scope and confirmed-versus-estimated amounts remain intact. |
| Inbox | Hidden horizontal scrollbars gave no clue that additional creators and views existed. | Overflow-aware previous/next controls, outside the semantic groups, with native scrolling, keyboard access and reduced-motion support. Existing filters and URL state are preserved. |
| Conversation | A large centered sender introduction consumed the space needed to read the buyer's message above the composer. Declining style consent still led to a Generate action that would fail later. | Compact sender context retains identity, estimate, classification and provenance. Explicit consent-off guidance links to the correct creator's writing permissions; no draft/send action is offered in that editing state. Pending and completed send outcomes retain their existing treatment. |
| Review | Narrow choices could truncate category text; the focused sender heading crowded its metadata. | Choice labels wrap with adequate target height; sender metadata has more separation. Focus, remaining counts, Skip and Undo retain their behavior. |
| Revenue | Creator/month controls formed a tall stack on desktop, and the hero stretched to match the chart's height. | Responsive grouped controls, top-aligned cards, tighter padding and aligned statistics; creator/month filtering and export context remain unchanged. |
| Roster | Repeated card spacing pushed the shared queue down; explanatory content competed with the review action. | Denser identity/metrics/actions, review action before optional desk guidance, and a collapsed explanation. Creator-specific links and reconnect status remain visible. |
| Voice | The large trend hero pushed learning evidence down. Copy implied every edit necessarily improved the profile. | Shorter trend area, better creator target, quieter expanded manual controls, and factual copy describing examples, rules and previews. Consent-off state remains explicit. |
| Settings | Navigation lacked selected-section feedback, and jumping before data loaded could miss the destination. Some profile/row layouts did not wrap well. A weekly-summary toggle advertised a scheduler that does not exist. | Selected section and keyboard feedback; deferred anchor scrolling after sections render; disabled jump while loading; better row wrapping. The unsupported weekly-summary control is hidden. |
| Activity | Phone filter categories were hidden offscreen. | Filters wrap rather than hiding categories. Existing attribution, comparisons and conversation links remain. |
| Onboarding | Connection assurances and price fields needed grouping. Voice comparison content made consent unnecessarily long and placed choices far apart. Some copy overpromised coverage, pricing fidelity or recovered value. | Grouped assurances, responsive fields and targets, a short clearly illustrative draft, adjacent opt-in/decline actions, optional price guidance, bounded-history wording, estimated-value reveal and a Review next step. Consent persistence/error behavior is preserved. |

The main session used the actual local app for desktop screens and phone flows, including all seven onboarding stages, offer editing, consent-off voice/conversation, filter scrolling and appearance settings. Agents supplied independent source/screenshot review and scoped implementation. They did not claim unavailable live-browser coverage. Browser timeouts during local compilation were recorded as tooling limits, not proof of a product failure.

## Verification

The dedicated browser suite covers offer pause/resume/edit scope, actual rail scrolling and full last-tab visibility, Settings deep links and navigation, both themes, real application screenshots, horizontal bounds and all WCAG 2 A/AA axe findings on seven supporting screens. The earlier inbox/thread, consent, navigation, review and revenue-export regressions remain included.

These fictional-demo checks do not validate real Meta, Clerk, billing or speech-provider screens; those account-dependent gates remain in [pending work](../pending.md).

## Completion pass on 2 November

The main session reviewed the actual running application again at desktop and phone widths, including Offers and its editor, expanded Voice controls, Revenue and its sale editor, Review advancement, Activity filters/comparisons, Settings anchors/theme controls, the creator roster, and the inbox/conversation composer. Three Terra agents independently reviewed dashboard, interaction and screenshot evidence; their source-only or saved-image observations are distinguished from the main session's live use.

Additional changes from that review:

- The offer editor groups its price fields, aligns name/type on desktop and clearly states who may quote the offer. Keyboard focus receives the same card emphasis as hover. Low-contrast category text now uses a readable neutral; category color remains on the icon.
- The draft explanation is a compact dialog sized to its contents instead of a full-height side panel. It shows supplied sources without claiming the model cannot make mistakes. Its Voice link retains the conversation's creator.
- Voice example and measurement chips wrap, including the previously clipped Courses option. Long titles wrap naturally rather than balancing into awkward short lines.
- Revenue sale details wrap and edit/delete controls have 44px targets. The roster exposes the complete queue when its preview is truncated.
- Review moves focus after a decision or skip, including its completion state, without taking focus on the initial page load. Activity has a nearby Clear filters recovery action and accessible expandable comparisons.
- The inbox's Check shortcut keeps the selected creator. The empty reading pane no longer shows an unrelated all-creator count.
- Today, Inbox, Roster and onboarding consistently distinguish lower estimates from confirmed revenue. Equal reply times are described as unchanged. Sign-in's unavailable state gives users an understandable message instead of environment-variable setup instructions; authentication behavior is unchanged.

The microinteractions provide feedback on actual actions: visible scroll boundaries, pending offer updates, focus return from explanations, next-card focus after review, expandable controls and press feedback. They honor the existing reduced-motion treatment; no ambient animation or artificial activity was added.

## Research used

Secondary guidance and advanced style controls stay behind explicit disclosures, following [NN/g's progressive-disclosure guidance](https://www.nngroup.com/articles/progressive-disclosure/). Motion is feedback rather than a prerequisite for understanding, with reduced-motion preferences respected, consistent with [W3C's explanation of animation from interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions). These principles informed the choices; the decisions were checked against DealDock's own creator and agency workflows.

## Executed checks

- Full demo UI gate: **51 passed, 1 intentionally skipped** in 7.8 minutes. The skip is the desktop instance of a phone-only touch-target check. Includes both themes and desktop/Pixel 7 checks on nine screens, expanded Voice, offer editor accessibility, consent decline, creator scope, review undo and revenue CSV.
- After the final Activity/Roster refinements: **6/6 targeted browser checks passed**, including both themes and expanded comparisons.
- After inbox scope and empty-pane corrections: **10/10 targeted browser checks passed**, including scoped review navigation, filter scrolling and conversation return-state preservation.
- The earlier interrupted run exposed offer-label contrast failures. Those labels were corrected; no accessibility rules or thresholds were disabled. Its final totals were unavailable and are not counted as a completed gate.
- Final explanation checks and production build results are recorded below once complete.

Local logs and actual app captures are in `.turbo/ui-polish-*-20261102.log` and `.turbo/polish-*.png`. The isolated preview runs on `http://127.0.0.1:3100`, with fictional demo data and no real provider configuration. An in-app browser connection reset was recovered during the pass; brief development compile timeouts were not treated as product failures.

## Verification, 4 November

These checks cover the design-system restoration and the functional review that followed it ([workflow review](workflow-and-functionality-review-2026-11-04.md)). All of them ran against the fictional demo on `127.0.0.1:3100`.

- **Final full demo UI gate: 59 passed, 1 skipped**, in 5.2 minutes, after every change. The skip is the desktop run of a phone-only touch-target check.
  - The 60 tests include both themes and WCAG 2 A/AA scans of nine screens on desktop and Pixel 7.
  - They also cover the new What you sell editor and the Check view's scoped sorting.
- **The run before it: 58 passed, 1 skipped, 1 failed.**
  - The failure was `net::ERR_ABORTED` when opening `/voice` on the phone project. The development server had reloaded mid-run for an edit.
  - The same test passed in a targeted rerun, as did 11 other affected tests on both projects.
- **Restoration-only gate earlier the same day:** 57 passed, 1 skipped, in 9.8 minutes.
- **Builds and test suites:**
  - Production build: 9/9 tasks.
  - Typecheck: 15/15 tasks.
  - Architecture boundaries: pass. Boundary-rule tests: 16/16. Runtime safety: 6/6.
  - Web unit tests: 84/84.
    - One run failed a single test just after a typecheck finished; that run's output didn't capture which test.
    - Six further runs passed, including one alongside a forced typecheck.
- **Screenshots:** the restoration was judged from real screenshots at 1440px, 1100px and 390px, in light and dark. After the functional changes, the inbox tabs and Settings › What you sell were captured again.

These demo checks do not validate real Meta, Clerk, billing, push or speech-provider screens. Logs are in `.turbo/ui-gate-final-20261104.log`, `.turbo/ui-gate-functional-20261104.log`, `.turbo/ui-redesign-final-20261104.log`, `.turbo/final-checks-20261104.log` and `.turbo/final-build-20261104.log`.
