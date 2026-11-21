# Deploy: Railway (API, worker, Postgres, Redis) + Vercel (web)

Decided 22 November: the web app goes on the **same Vercel account as the marketing site** (free plan for setup; switch to Pro before the first creator pays, since Vercel's free plan bans commercial use). Everything else goes on **Railway Hobby in Singapore** ($5/month including $5 of usage; expect about $10–15). The repo holds `apps/web/vercel.json` and `.node-version` (22). Railway's config-as-code is deprecated (new services can't opt in), so the Railway settings below are entered in each service's Settings screen.

Full lists of production values: section 4 of the go-live checklist in [pending.md](../pending.md).

## Files with values you'll paste (all gitignored, on the founder's machine)

| File | What | Goes to |
|---|---|---|
| `.env.production.secrets.local` | `TOKEN_ENCRYPTION_KEY`, `MEDIA_SIGNING_KEY`, `META_WEBHOOK_VERIFY_TOKEN`, VAPID keys | Doppler prd configs (see the comments in the file), then delete the file |
| `.env.live.local` | Paddle live price ids, webhook secret, client token | Doppler prd configs (plus `PADDLE_API_KEY` = `PADDLE_LIVE_API_KEY` from `.env`) |
| `.env` | Paddle sandbox values | Doppler stg configs, if you keep a staging environment |

**Never rotate `TOKEN_ENCRYPTION_KEY` after creators connect:** every stored Instagram/Gmail token becomes unreadable.

## 1. Railway

1. Sign up at railway.com, choose **Hobby**, and under **Workspace → Usage** set a usage limit (e.g. $25) so a bug can't run up a bill.
2. **New project → Deploy PostgreSQL.** In the database's settings set the region to **Singapore**. Open its **Backups** tab and turn on daily backups if Hobby offers them (if not, the off-site nightly dump in pending.md becomes required).
3. **Add → Redis** in the same project, region Singapore.
4. **Add → GitHub repo** `dealdock-app` (this becomes the API):
   - Settings: root directory **empty**, branch `main`, **Wait for CI** on, **Serverless off**, config file path cleared.
   - **Custom build command:** `npm ci --include=dev && npx turbo run build --filter=@dealdock/api` (`--include=dev` because `NODE_ENV=production` would otherwise skip turbo, TypeScript and the prisma CLI).
   - **Custom start command:** `node apps/api/dist/index.js`
   - **Pre-deploy step:** `npm run db:migrate -w @dealdock/db`
   - **Healthcheck path:** `/ready`. Restart policy: on failure, 10 retries.
   - Settings → **Region**: Singapore. Rename the service `api`.
   - Variables: `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`, `REDIS_URL` = `${{Redis.REDIS_URL}}`, `NODE_ENV=production`, plus everything in the API list in pending.md section 4 (or connect Doppler, section 5).
   - Settings → **Networking → Public Networking → Generate Domain** first (port: the one Railway suggests, usually 8080; the API logs `Server listening at …:<port>` after its first deploy). Then **+ Custom Domain** appears: enter `api.dealdock.io` with the same port. Railway shows a **CNAME and a TXT record**; both go into DNS (step 3). Without the TXT, Railway answers 404. The trial plan allows 1 custom domain, Hobby 2 per service: only the API needs one.
5. **Add → GitHub repo** again (the worker): rename it `worker`, region Singapore, root directory empty, branch `main`, Wait for CI on, Serverless off. **Build command:** `npm ci --include=dev && npx turbo run build --filter=@dealdock/worker`. **Start command:** `node apps/worker/dist/index.js`. No pre-deploy step, no healthcheck, restart on failure (or always). Same `DATABASE_URL`/`REDIS_URL` references, `NODE_ENV=production`, plus the worker list. **No public domain.** Never give it Meta, Google or encryption keys: it refuses to start with them.
6. Each API deploy runs the database migrations first (the pre-deploy step), then waits for `/ready`. Check **Workspace → Plans** shows Hobby: a trial plan caps each service at 1 GB and stops when its credit runs out.

## 2. Vercel (the marketing site's account)

1. In that account: **Add New → Project → Import** the `dealdock-app` repo. If the repo doesn't appear, grant the Vercel GitHub app access to it.
2. **Root Directory: `apps/web`.** Framework Next.js. The install command, build command and the `sin1` region come from `apps/web/vercel.json`.
3. Environment variables (Production): the web list from pending.md, including `NEXT_PUBLIC_API_URL=https://api.dealdock.io` and `NEXT_PUBLIC_DEALDOCK_DEMO_MODE=false`. `NEXT_PUBLIC_*` values are baked in at build time: redeploy after changing one.
4. **Settings → Domains → add `app.dealdock.io`.** Vercel shows the record to add (or adds it itself if dealdock.io's DNS is already managed in this Vercel account).
5. **The old project** (`dealdock-app-web` in the `infinitys-projects` account): disconnect its Git repository or delete the project, so pull requests stop showing its failing check.

## 3. DNS for dealdock.io

Add these wherever dealdock.io's DNS is managed (Vercel's Domains page if the marketing site uses Vercel's nameservers, otherwise the registrar). Copy exact values from each dashboard.

| Host | Type | Value from |
|---|---|---|
| `app` | CNAME | Vercel (step 2.4) |
| `api` | CNAME **and** TXT | Railway (step 1.4) |
| `clerk`, `accounts`, `clkmail`, `clk._domainkey`, `clk2._domainkey` | CNAME | Clerk production instance (step 4) |
| `@` | TXT | Google Search Console (only needed for Gmail later) |
| `_dmarc` | TXT | `v=DMARC1; p=none; rua=mailto:<your inbox>` |

Keep the existing Zoho MX, SPF and DKIM records and exactly one `v=spf1` record. Don't touch the marketing site's root records. On Cloudflare, Clerk's records must be "DNS only". Records can take up to 72 hours.

## 4. Clerk

Create the **production instance**: domain `dealdock.io`, allowed subdomain `app.dealdock.io`, Google sign-in with its own Google OAuth client. Add its DNS records (step 3) and wait for them to verify. Copy the `pk_live_…` key to the web (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`) and the `sk_live_…` key to the web and the API (`CLERK_SECRET_KEY`).

## 5. Doppler (optional but recommended)

Project `dealdock`, configs `prd_web`, `prd_api`, `prd_worker`. Sync `prd_web` to the Vercel project and `prd_api` / `prd_worker` to the Railway services. Keep `DATABASE_URL` and `REDIS_URL` as Railway reference variables (Doppler can't express them). Set `FEATURE_INVOICES_ENABLED=false` on the API until a chartered accountant signs off.

## 6. Meta app

- Instagram → API setup with Instagram login → OAuth redirect `https://api.dealdock.io/ig/callback`.
- Webhooks → callback `https://api.dealdock.io/webhooks/instagram`, verify token = `META_WEBHOOK_VERIFY_TOKEN`, subscribe to `messages`.
- App roles → add each pilot creator as an **Instagram tester**; they accept in Instagram (Settings → Apps and websites → Tester invites).

## 7. Payments

- **Razorpay (test mode first):** plans Solo/Studio/Roster, webhook `https://api.dealdock.io/webhooks/razorpay` with a secret; keys and plan ids into the API and worker.
- **Paddle:** already configured (webhook points at `https://api.dealdock.io/webhooks/paddle`). After Paddle approves `app.dealdock.io`, re-run `scripts/paddle-setup.mjs --env live` to set the payment link.

## 8. First deploy checks

1. `https://api.dealdock.io/ready` answers; the Railway deploy log shows the migrations applied; the worker log shows its consumers started.
2. Sign in, invite, sign out on `https://app.dealdock.io`.
3. Connect your own Instagram (as a tester), DM it from another account: the message arrives, gets sorted, a draft appears, you approve it, it's delivered.
4. Push notification on a real phone after allowing notifications.
5. Railway's usage tab after a day: real cost.

Then the remaining launch-day checks in pending.md, section 5.
