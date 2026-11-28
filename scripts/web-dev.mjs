#!/usr/bin/env node
/**
 * `next dev` on https://localhost:3000 (loopback only) with the self-signed cert
 * from scripts/dev-services.mjs. --experimental-https-ca makes Next set
 * NODE_EXTRA_CA_CERTS on its server process, so only that process trusts this one
 * cert (Next proxies some requests, e.g. Clerk's, back to itself). Nothing is added
 * to the OS trust store.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const web = join(import.meta.dirname, "..", "apps", "web");
const key = join(web, ".certs", "localhost-key.pem");
const cert = join(web, ".certs", "localhost.pem");
if (!existsSync(key) || !existsSync(cert)) {
  console.error("web-dev: no local certificate yet; run `npm run services:start` first");
  process.exit(1);
}
const next = createRequire(join(web, "package.json")).resolve("next/dist/bin/next");
const child = spawn(
  process.execPath,
  [next, "dev", "-H", "localhost", "--experimental-https", "--experimental-https-key", key, "--experimental-https-cert", cert, "--experimental-https-ca", cert, ...process.argv.slice(2)],
  { cwd: web, stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
