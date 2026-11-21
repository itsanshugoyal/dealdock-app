import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const DraftRecord = z.object({ body: z.string().trim().min(1), modelVersion: z.string(), promptVersion: z.string() });
export type DraftRecord = z.infer<typeof DraftRecord>;

/** Synthetic draft sample progress, separate from the independent human review. */
export class DraftCheckpoint {
  private readonly results = new Map<number, DraftRecord>();

  constructor(private readonly path: string, private readonly fingerprint: string, private readonly total: number, private readonly modelVersion: string, private readonly promptVersion: string) {
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; fingerprint?: unknown; results?: unknown };
    if (data.version !== 1 || data.fingerprint !== fingerprint || !data.results || typeof data.results !== "object" || Array.isArray(data.results)) {
      throw new Error("Draft checkpoint does not match the current model, prompts, profiles or dataset.");
    }
    for (const [key, raw] of Object.entries(data.results)) {
      const index = Number(key);
      if (!/^\d+$/.test(key) || !Number.isSafeInteger(index) || index < 0 || index >= total) throw new Error("Invalid draft checkpoint case index.");
      this.results.set(index, this.validate(raw));
    }
  }

  get(index: number): DraftRecord | undefined { return this.results.get(index); }

  save(index: number, raw: DraftRecord): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.total) throw new Error("Invalid draft checkpoint case index.");
    this.results.set(index, this.validate(raw));
    const temporary = join(dirname(this.path), `.dealdock-drafts-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, fingerprint: this.fingerprint, results: Object.fromEntries(this.results) }), { encoding: "utf8", flag: "wx" });
      renameSync(temporary, this.path);
    } finally { rmSync(temporary, { force: true }); }
  }

  private validate(raw: unknown): DraftRecord {
    const result = DraftRecord.parse(raw);
    if (result.modelVersion !== this.modelVersion || result.promptVersion !== this.promptVersion) throw new Error("Draft checkpoint contains a different model or prompt version.");
    return result;
  }
}
