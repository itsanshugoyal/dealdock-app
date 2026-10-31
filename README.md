# DealDock

Revenue recovery system for Instagram-first commerce creators. Connects a creator's Instagram inbox, classifies DMs by estimated ₹ value, drafts replies in the creator's voice, and tracks recovered revenue in a Revenue Ledger.

**North star: rupees recovered — not time saved.**

Current status and remaining owner actions: [private pilot readiness](docs/private-pilot-readiness.md), [voice/audio audit](docs/voice-and-audio-audit.md) and [deployment preflight](docs/deployment-preflight.md). M0–M5 code exists; live provider, quality and account-dependent exit gates remain separate. The current [Studio HTML](design/studio/dealdock-studio.html) is a new interactive design proposal with fictional data, replacing the rejected Reply desk proposal.

## The three documents

| Doc | What it holds |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Services, data model, AI pipeline, Meta integration, security, ADRs |
| [DESIGN.md](./DESIGN.md) | Design system, screen specs, component inventory, UX principles |
| [PLAN.md](./PLAN.md) | Milestones M0–M6, exit criteria, risk register, metrics plan |

Requirements source of truth: `DealDock_Product_PRD.md` (PRD v1.0, pilot scope).

## Workspace layout

```
apps/
  web/        Next.js 16 — authenticated creator-facing UI
  api/        Fastify — REST API, webhooks, the send gate
  worker/     BullMQ — ingestion, AI pipeline, scheduled jobs
packages/
  core/       Domain types, zod schemas, shared constants
  db/         Prisma schema + org-scoped repository layer (M0)
  messaging/  MessagingProvider interface + mock & Instagram adapters
  ai/         Claude pipeline: prompts, classifier, drafter, evals (M1)
```

## Getting started

```bash
npm install
npm run build            # turbo pipeline: packages → apps
npm run typecheck
npm run test             # unit tests (money formatting, fixture corpus)
npm run lint             # boundary checks: prisma confined to packages/db, worker has no send path
npm run test:boundaries  # regression tests for the architecture guard
npm run test:safety      # production auth fails closed; worker refuses API-only secrets
```

### Full local loop (requires Docker Desktop)

```bash
cp .env.example .env               # reference only: export variables into each process before starting it
docker compose up -d               # Postgres 16 + Redis 7
npm run db:migrate -w @dealdock/db # apply migrations
npm run db:seed -w @dealdock/db    # demo org (INR, mock provider)
# Worker: DATABASE_URL, REDIS_URL, NODE_ENV=development, DEALDOCK_AI_MODE=heuristic
# Never copy Meta/Clerk/encryption credentials into the worker environment.
npm run start -w @dealdock/worker  # terminal 1: ingestion consumer
node scripts/demo-ingest.mjs      # terminal 2: 200+ fixture DMs → queue → Postgres
```

The CI integration job configures PostgreSQL/Redis service containers and mandates database, ingestion/load, privacy and browser gates. A configured workflow is not proof of a hosted CI pass. For local runs, point `TEST_DATABASE_URL` and `REDIS_URL` at disposable loopback services and run `npm run test:integration`, then `npm run test:browser`. Use a separate disposable `SHADOW_DATABASE_URL` for migration drift checks. The database must be UTF8.

### Auth

Authentication is on by default and fails closed. Keyless local integration requires explicit `DEALDOCK_DISABLE_AUTH=true`, a single server-configured `DEALDOCK_DEV_ORG_ID`, and `DEALDOCK_API_URL` pointing to a loopback API. This mode is unavailable in production, even if the flag is set. The browser never chooses the test tenant. For real auth, configure Clerk, `NEXT_PUBLIC_API_URL`, and the API's allowed web origin. Set environment variables on each process; the Node entry points do not automatically load the root `.env` file.

## Non-negotiables

- **Never auto-send.** Drafts require human approval; the worker has no send capability by construction.
- **Official Meta Graph API only.** No scraping, no browser automation, ever.
- **Per-creator data isolation.** Org-scoped repository layer; no cross-creator prompt context.
- The PRD's out-of-scope list (§12) is enforced in code review.
