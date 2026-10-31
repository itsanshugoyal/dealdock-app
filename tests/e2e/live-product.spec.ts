import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { formatMoneyExact } from "@dealdock/core";

const enabled = process.env.E2E_REAL_PRODUCT === "true";

test.describe("live product critical path", () => {
  test.skip(!enabled, "Requires the disposable API/DB/Redis fixture and the server-only local dev proxy.");

  test("inbox and thread detail are real, accessible API-backed screens", async ({ page }, testInfo) => {
    await page.goto("/inbox");
    await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
    const detail = page.locator('a[href^="/thread/"]').filter({ hasText: `@e2e.${testInfo.project.name}` });
    await expect(detail).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    await detail.click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("@");
    await expect(page.getByRole("list", { name: "Conversation history" })).toBeVisible();
    // The contextual offer is delayed by 1.2s; check after that window.
    await page.waitForTimeout(1500);
    await expect(page.getByRole("button", { name: "Notify me" })).toHaveCount(0);
  });

  test("human draft approval sends once and records a sale", async ({ page }, testInfo) => {
    await page.goto("/inbox");
    await page.locator('a[href^="/thread/"]').filter({ hasText: `@e2e.${testInfo.project.name}` }).click();
    const generate = page.getByRole("button", { name: /Generate draft|Regenerate draft/ });
    await generate.click();
    const reply = page.getByLabel("Review and edit before sending");
    await expect(reply).toBeEnabled();
    await reply.fill("Thanks for reaching out. Please send your campaign brief, budget, and timeline.");
    // Desktop shows a button; touch screens a slide-to-send knob. Enter confirms both (the knob's keyboard path).
    await page.getByRole("button", { name: "Approve & send" }).press("Enter");
    // The send waits out the undo window before going to Instagram.
    await expect(page.getByText(/Reply sent|Approval recorded/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Approve & send" })).toHaveCount(0);
    const approvedText = "Thanks for reaching out. Please send your campaign brief, budget, and timeline.";
    await expect(page.getByText(approvedText, { exact: true })).toHaveCount(1);
    await page.reload();
    await expect(page.getByText(approvedText, { exact: true })).toHaveCount(1);
    const beforeResponse = await page.request.get("/api/dev/dashboard");
    expect(beforeResponse.ok()).toBeTruthy();
    const before = await beforeResponse.json() as { mtdRecoveredMinor: number; mtdDealCount: number };
    await page.getByRole("button", { name: "Record a sale" }).click();
    await expect(page.getByRole("dialog", { name: "Record a sale" })).toBeVisible();
    await page.getByLabel(/Amount/).fill("1200.50");
    await page.getByLabel("Offer type").selectOption("brand");
    await page.getByRole("button", { name: "Confirm sale" }).click();
    await expect(page.getByText("Sale recorded:")).toBeVisible();
    const dashboardResponse = await page.request.get("/api/dev/dashboard");
    expect(dashboardResponse.ok()).toBeTruthy();
    const dashboard = await dashboardResponse.json() as { mtdRecoveredMinor: number; mtdDealCount: number };
    expect(dashboard.mtdRecoveredMinor).toBe(before.mtdRecoveredMinor + 120050);
    expect(dashboard.mtdDealCount).toBe(before.mtdDealCount + 1);
    await page.goto("/");
    // The fixture org is INR / en-IN; the page formats with the same core formatter.
    await expect(page.getByTestId("mtd-recovered")).toHaveText(formatMoneyExact(dashboard.mtdRecoveredMinor, { currency: "INR", locale: "en-IN" }));
    await page.goto("/ledger");
    await expect(page.getByRole("heading", { name: "Revenue", exact: true })).toBeVisible();
    await expect(page.getByText(`@e2e.${testInfo.project.name}`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: `Edit sale for e2e.${testInfo.project.name}` }).click();
    const editor = page.getByRole("dialog", { name: "Edit sale" });
    await expect(editor.getByLabel("Amount")).toHaveValue("1200.50");
    const note = `Browser note ${testInfo.project.name}`;
    await editor.getByLabel("Note").fill(note);
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toBeHidden();
    const response = await page.request.get("/api/dev/ledger");
    expect(response.ok()).toBeTruthy();
    const ledger = await response.json() as { entries: Array<{handle: string; amountMinor: number; note: string}> };
    expect(ledger.entries.filter(entry => entry.handle === `e2e.${testInfo.project.name}`)).toEqual([
      expect.objectContaining({ amountMinor: 120050, note }),
    ]);
  });

  test("mobile settings exposes real data controls without accessibility violations", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your data" })).toBeVisible();
    await expect(page.getByText("Push notifications are not configured or supported on this device.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Enable notifications on this device|Enable or reconnect this device/ })).toHaveCount(0);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  });

  test("the local bridge rejects out-of-scope and cross-site requests", async ({ page }) => {
    const outOfScope = await page.request.get("/api/dev/health");
    expect(outOfScope.status()).toBe(404);
    const crossSite = await page.request.get("/api/dev/inbox", { headers: { Origin: "http://untrusted.invalid" } });
    expect(crossSite.status()).toBe(403);
  });
});
