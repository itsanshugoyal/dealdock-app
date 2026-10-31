# Pilot deployment handoff — requires approval

This prepares the already documented hosting direction. No services have been provisioned and no deployment has been performed by this work. Confirm the actual app and API domains; the public marketing site at dealdock.io does not establish either authenticated-product origin.

| Service | Project root / build | Runtime |
|---|---|---|
| Vercel web | Root `apps/web`; install `cd ../.. && npm install`; build `cd ../.. && npx turbo run build --filter=@dealdock/web` | Next.js managed runtime |
| Railway Singapore API | Repository root; `npm ci --include=dev && npx turbo run build --filter=@dealdock/api` | `node apps/api/dist/index.js`; Railway supplies PORT; readiness `/ready` |
| Railway Singapore worker | Repository root; `npm ci --include=dev && npx turbo run build --filter=@dealdock/worker` | `node apps/worker/dist/index.js`; background process, no public HTTP domain |
| Neon Singapore | UTF8 PostgreSQL, separate backup/restore plan | Apply `npm run db:migrate -w @dealdock/db` once through the approved release process; never use `db push` or the demo seed on production |
| Redis alongside Railway | Shared authenticated Redis URL, private networking where supported | API and worker use the same queue database; TLS/ACL/database selection are preserved |

Pin Node 22 in both build and runtime settings for the first pilot. The current local build used Node 22; CI also selects Node 22. Hosted platform versions still require their first verified run.

## Environment ownership

| Environment | Values |
|---|---|
| Web build | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY` when push is configured. Public values are compiled into the browser, so changing them requires rebuilding. Turbo's Next.js inference was checked locally to include public configuration in its build environment/hash. |
| Web server | `CLERK_SECRET_KEY`, production Clerk URL/organization settings. No database, Graph, encryption or billing credentials. |
| API | `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, `CLERK_SECRET_KEY`, exact `WEB_APP_URL`, Meta app ID/secret/webhook verification token, explicit HTTPS `IG_OAUTH_REDIRECT_URI` ending `/ig/callback`, `TOKEN_ENCRYPTION_KEY` (32 random bytes encoded as hex/base64), Claude key and explicit model IDs, billing API/webhook credentials and plan/price IDs. |
| Worker | `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, Claude key and explicit model IDs, billing API credentials/plan IDs, VAPID key pair when enabled. **No Clerk, Meta, Graph or token-encryption secrets.** Its startup guard rejects API-only Instagram credentials. |

Leave `DEALDOCK_DISABLE_AUTH`, `DEALDOCK_DEV_ORG_ID`, `DEALDOCK_API_URL`, `DEALDOCK_AI_MODE`, `MOCK_WEBHOOK_SECRET` and demo mode unset in deployed environments. Do not copy the root example environment wholesale to either service. Keep Paddle in sandbox and Razorpay in test mode until their lifecycles have been verified and paid launch is approved.

## Evidence required before a design partner

1. Run hosted CI with PostgreSQL 16/Redis 7 and retain its build, safety, integration and browser results. Local equivalents pass; no hosted run is claimed.
2. Configure Clerk for the selected origins. Test a verified founder administrator, an invited assistant, denied foreign-tenant access and sign-out/account switching.
3. Configure Meta webhook `<API origin>/webhooks/instagram` and OAuth `<API origin>/ig/callback` exactly. Prove one incoming founder DM, review, edited human approval, one delivered reply/receipt, expired-window denial, disconnect/reconnect and history recovery. Keep ambiguous sends locked until their outcome is checked.
4. Complete the Claude classification and blind draft-quality gates in the [readiness record](private-pilot-readiness.md). Never substitute development heuristic scores.
5. Verify test/sandbox billing webhooks at `/webhooks/razorpay` and `/webhooks/paddle`, cancellation, failures and reconciliation. No payment should be accepted from a partner before the relevant rail is proven.
6. Exercise real iOS/Android push after opt-in; verify quiet-hour suppression. Confirm that no API response or send is cached for offline replay.
7. Check `/ready`, ingestion lag, queue/outbox growth, provider spend and failure alerts. Prove a backup restore on an isolated branch and an account export/deletion drill before handling partner data. Database residue checks do not prove backup expiry or provider-side erasure; define and communicate those retention windows.

Start with a founder-controlled INR Solo workspace, then a small personally onboarded cohort. Broader self-service, Roster and tier changes remain outside the verified pilot scope. This document specifies release work for approval; it does not authorize creating accounts, buying services, pushing or deploying.
