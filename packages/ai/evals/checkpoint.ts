import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ClassificationResult as ClassificationResultSchema, type ClassificationResult } from "@dealdock/core";

/** Local, synthetic evaluation progress only. Never accepted by the hosted CI gate. */
export function checkpointFingerprint(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export class EvalCheckpoint {
  private readonly results = new Map<number, ClassificationResult>();

  constructor(
    private readonly path: string,
    private readonly fingerprint: string,
    private readonly total: number,
    private readonly modelVersion: string,
    private readonly promptVersion: string,
  ) {
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; fingerprint?: unknown; results?: unknown };
    if (data.version !== 1 || data.fingerprint !== fingerprint || !data.results || typeof data.results !== "object" || Array.isArray(data.results)) {
      throw new Error("Evaluation checkpoint does not match the current model, prompts, code, or dataset.");
    }
    for (const [key, raw] of Object.entries(data.results)) {
      const index = Number(key);
      if (!/^\d+$/.test(key) || !Number.isSafeInteger(index) || index < 0 || index >= total) throw new Error("Invalid evaluation checkpoint case index.");
      const result = this.validate(raw);
      this.results.set(index, result);
    }
  }

  get(index: number): ClassificationResult | undefined { return this.results.get(index); }

  save(index: number, raw: ClassificationResult): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.total) throw new Error("Invalid evaluation checkpoint case index.");
    this.results.set(index, this.validate(raw));
    const temporary = join(dirname(this.path), `.dealdock-eval-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, fingerprint: this.fingerprint, results: Object.fromEntries(this.results) }), { encoding: "utf8", flag: "wx" });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private validate(raw: unknown): ClassificationResult {
    const result = ClassificationResultSchema.parse(raw);
    if (result.modelVersion !== this.modelVersion || result.promptVersion !== this.promptVersion) {
      throw new Error("Evaluation checkpoint contains a different model or prompt version.");
    }
    return result;
  }
}
