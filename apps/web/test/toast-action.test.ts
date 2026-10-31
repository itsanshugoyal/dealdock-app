import { describe, expect, it } from "vitest";
import { toastAction } from "../src/components/ui/toast";
import { errorMessage } from "../src/lib/snapshot";

describe("error messages", () => {
  it("shows the error's own message and falls back when it has none", () => {
    expect(errorMessage(new Error("Instagram's reply window has closed."), "Couldn't send.")).toBe("Instagram's reply window has closed.");
    expect(errorMessage(new Error(""), "Couldn't send.")).toBe("Couldn't send.");
    expect(errorMessage(new Error("   "), "Couldn't send.")).toBe("Couldn't send.");
    expect(errorMessage("boom", "Couldn't send.")).toBe("Couldn't send.");
    expect(errorMessage(null)).toBe("DealDock could not load this account.");
  });
});

describe("toastAction", () => {
  it("resolves true when the action succeeds and false when it fails, never throwing", async () => {
    let ran = 0;
    await expect(toastAction(async () => { ran += 1; }, { success: "Saved.", fallback: "Couldn't save." })).resolves.toBe(true);
    await expect(toastAction(async () => { ran += 1; }, { fallback: "Couldn't save." })).resolves.toBe(true);
    await expect(toastAction(async () => { throw new Error("Nope."); }, { success: "Saved.", fallback: "Couldn't save." })).resolves.toBe(false);
    await expect(toastAction(() => Promise.reject(new Error("")), { fallback: "Couldn't save." })).resolves.toBe(false);
    expect(ran).toBe(2);
  });
});
