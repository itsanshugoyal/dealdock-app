# Local sandbox

Run the API, worker and web on your machine against local Postgres and Redis, with Razorpay **test** mode and Paddle **sandbox**. Production runs live keys only; test and sandbox keys never go there.

## One-time setup (Windows, no Docker, no admin)

1. **Doppler CLI:** `winget install --id Doppler.doppler -e`, then `doppler login` in PowerShell or cmd. In Git Bash use `doppler login --scope C:/`, because Git Bash rewrites `/` into its own install folder.
2. **Postgres and Redis binaries** into `%LOCALAPPDATA%\dealdock-dev` (or set `DEALDOCK_DEV_SERVICES_DIR`):
   - `pgsql\`: unzip `postgresql-16.x-windows-x64-binaries.zip` from get.enterprisedb.com. Only `bin`, `lib` and `share` are needed.
   - `redis\`: unzip `Redis-<version>-Windows-x64-msys2.zip` from github.com/redis-windows/redis-windows/releases, and check its SHA-256 against the release page.
3. `npm run services:start` creates the database cluster, the `dealdock`, `dealdock_test` and `dealdock_shadow` databases, and random passwords in `%LOCALAPPDATA%\dealdock-dev\secrets.json`. `node scripts/dev-services.mjs urls` prints the matching `DATABASE_URL`, `TEST_DATABASE_URL`, `SHADOW_DATABASE_URL` and `REDIS_URL`.
4. `npm run env:pull` writes `.env` and `apps/web/.env.development.local` from Doppler (`dev_api`, `dev_web`, `dev_worker`). Run `npm run env:push` after you change `.env` locally.
5. Migrations: `node --env-file=.env -e "require('child_process').execSync('npm run db:migrate -w @dealdock/db',{stdio:'inherit'})"`.

## Every day

```bash
npm run build          # once after pulling
npm run dev            # starts Postgres + Redis + tunnel first, then the watchers and the web on https://localhost:3000
npm run dev:api        # second terminal: API on 127.0.0.1:4000 (env from Doppler dev_api)
npm run dev:worker     # third terminal: worker (env from Doppler dev_worker)
npm run services:stop  # when you're done
```

## Safety on a shared or work machine

- Postgres and Redis listen on 127.0.0.1 only and require passwords. Redis uses port **6380** so it never touches another project's Redis on 6379 (Optmyzr runs Redis 2.8 there).
- The API listens on 127.0.0.1 when `HOST=127.0.0.1` (set in `dev_api`), and `next dev` binds to `localhost` (loopback). Nothing is reachable from the office network.
- The web runs on **https://localhost:3000** with a self-signed certificate made once by `services:start` (`apps/web/.certs`, gitignored, valid for localhost and 127.0.0.1 only). It's handed straight to Next (`scripts/web-dev.mjs`), so nothing goes into the Windows trust store. Next's own `--experimental-https` without a cert would install a root CA; don't use it. The browser shows "Your connection is not private" once: choose Advanced, then Proceed to localhost.
- No Windows services, scheduled tasks or firewall rules are created. Everything lives in `%LOCALAPPDATA%\dealdock-dev` and stops with `npm run services:stop`.
- `.env`, `.env.*.local` and `apps/web/.env.development.local` are gitignored. `npm run env:push` refuses to push live keys (`rzp_live_`, `pdl_live_`, `sk_live_`) into dev configs.
- The web env goes in `.env.development.local` because `next build` and `next start` also read `.env.local`, which would bake dev keys into a build.

## Webhooks to your machine

The Razorpay **test** webhook and the Paddle **sandbox** notification point at `https://api-dev.dealdock.io/webhooks/{razorpay,paddle}`. A Cloudflare named tunnel, `dealdock-dev`, carries those two paths to `127.0.0.1:4000`. Every other path returns 404 at Cloudflare, so nothing else on the laptop is reachable. `npm run services:start` (and so `npm run dev`, `dev:api` and `dev:worker`) runs the tunnel when `~/.cloudflared/dealdock-dev.yml` exists, and `services:stop` stops it. Live webhooks stay on `api.dealdock.io`.

The Paddle **sandbox** default payment link is `https://localhost:3000/pay`. Paddle refuses plain http, which is why the local web runs on https. Sandbox checkouts open on your machine, and you pay with Paddle's test cards. The live link is still `https://app.dealdock.io/pay`.

To set up the tunnel on another machine: `cloudflared tunnel login` (pick dealdock.io), `cloudflared tunnel create dealdock-dev`, `cloudflared tunnel route dns dealdock-dev api-dev.dealdock.io`, then this config:

```yaml
tunnel: <tunnel id>
credentials-file: C:\Users\<you>\.cloudflared\<tunnel id>.json
ingress:
  - hostname: api-dev.dealdock.io
    path: ^/webhooks/(razorpay|paddle)$
    service: http://127.0.0.1:4000
  - service: http_status:404
```

Check your employer's policy before running a tunnel on a work machine. Without it, you can still check sandbox payments by reading the subscription in the Razorpay or Paddle dashboard.

Check it works: an unsigned `POST https://api-dev.dealdock.io/webhooks/razorpay` answers 401 from your local API, and `https://api-dev.dealdock.io/ready` answers 404. In Paddle sandbox, Developer tools > Simulations can send a test event to the notification.
