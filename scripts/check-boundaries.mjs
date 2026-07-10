#!/usr/bin/env node
/**
 * Architecture boundary checks (CI + `npm run lint`):
 *
 * 1. `@prisma/client` may only be imported inside packages/db — the org-scoped
 *    repository layer is the single tenancy chokepoint (ADR-7).
 * 2. The worker must have NO send capability: `sendMessage` from
 *    @dealdock/messaging may only be referenced by apps/api (the send gate —
 *    ARCHITECTURE.md §6.2).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC_DIRS = [
  "apps/web/src",
  "apps/api/src",
  "apps/worker/src",
  "packages/core/src",
  "packages/messaging/src",
  "packages/ai/src",
  "packages/db/src",
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry)) yield full;
  }
}

const violations = [];

for (const srcDir of SRC_DIRS) {
  const abs = join(ROOT, srcDir);
  let files;
  try {
    files = [...walk(abs)];
  } catch {
    continue; // dir may not exist yet
  }

  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join("/");
    const content = readFileSync(file, "utf8");

    // Rule 1: @prisma/client only inside packages/db
    if (!rel.startsWith("packages/db/") && /from\s+["']@prisma\/client["']/.test(content)) {
      violations.push(`${rel}: imports @prisma/client outside packages/db (ADR-7)`);
    }

    // Rule 2: worker never touches sendMessage
    if (rel.startsWith("apps/worker/") && /\bsendMessage\b/.test(content)) {
      violations.push(`${rel}: worker references sendMessage — the send gate lives in apps/api only`);
    }
  }
}

if (violations.length > 0) {
  console.error("Boundary violations:\n" + violations.map((v) => `  ✗ ${v}`).join("\n"));
  process.exit(1);
}
console.log("Boundary checks passed: prisma confined to packages/db; worker has no send path.");
