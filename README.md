# DealDock

Revenue recovery system for Instagram-first commerce creators. Connects a creator's Instagram inbox, classifies DMs by estimated ₹ value, drafts replies in the creator's voice, and tracks recovered revenue in a Revenue Ledger.

**North star: rupees recovered — not time saved.**

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
  web/        Next.js 15 — creator-facing UI
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
```

### Full local loop (requires Docker Desktop)

```bash
cp .env.example .env               # fill in what you have; mock provider needs no keys
docker compose up -d               # Postgres 16 + Redis 7
npm run db:migrate -w @dealdock/db # apply migrations
npm run db:seed -w @dealdock/db    # demo org (INR, mock provider)
npm run start -w @dealdock/worker  # terminal 1: ingestion consumer
npm run demo -w @dealdock/worker   # terminal 2: 200+ fixture DMs → queue → Postgres
```

The same flow runs in CI (`.github/workflows/ci.yml` integration job) with service containers — that's the M0 exit proof.

### Auth

Keyless local dev runs without Clerk (dev-only `x-demo-org` header selects the seeded org). To turn real auth on: create a Clerk app, set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` in `.env`, rebuild.

## Non-negotiables

- **Never auto-send.** Drafts require human approval; the worker has no send capability by construction.
- **Official Meta Graph API only.** No scraping, no browser automation, ever.
- **Per-creator data isolation.** Org-scoped repository layer; no cross-creator prompt context.
- The PRD's out-of-scope list (§12) is enforced in code review.
