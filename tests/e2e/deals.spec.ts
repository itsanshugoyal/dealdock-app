import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Fictional demo data only: deals are recorded, drafted and paid in the browser, never against the real API.
test.describe("deals in the demo", () => {
  test.skip(process.env.E2E_DEMO_PRODUCT !== "true", "Requires an explicitly started local demo app.");
  test.use({ reducedMotion: "reduce" });

  async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  async function noAxeViolations(page: Page) {
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  }

  test("an unpaid deal is owed on Today and in Revenue until it's marked paid", async ({ page }) => {
    test.setTimeout(120_000); // Several full axe scans can be slow on a development build.
    await page.goto("/thread/t-kesar");
    await page.getByRole("button", { name: "Record a deal", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Record a deal" });
    await sheet.getByRole("button", { name: "Fill from conversation" }).click();
    await expect(sheet.getByText("Filled from the chat. Check before saving.")).toBeVisible();
    await expect(sheet.getByText(/^Not in the chat: the fee/)).toBeVisible();
    await expect(sheet.getByLabel("What", { exact: true })).toHaveValue("2 reels + 3 stories");
    await expect(sheet.getByRole("switch", { name: "Already paid?" })).toHaveAttribute("aria-checked", "false");
    await expect(sheet.getByLabel("Payment due, optional")).toBeVisible();
    await sheet.getByLabel("Amount (₹)").fill("120000");
    await noAxeViolations(page);
    await sheet.getByRole("button", { name: "Save deal" }).click();
    await expect(sheet).toBeHidden();

    const card = page.getByRole("article", { name: "2 reels + 3 stories" });
    await expect(card.getByText("Agreed", { exact: true })).toBeVisible();
    await expect(card.getByText("₹1,20,000")).toBeVisible();
    // One next step on the card; the rest wait in its menu.
    await expect(card.getByRole("button", { name: "Send terms recap" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Mark paid" })).toHaveCount(0);
    // Ticking a deliverable moves the card on to the next one.
    await card.getByRole("button", { name: "Mark 2 reels done" }).click();
    await expect(card.getByRole("button", { name: "Mark 3 stories done" })).toBeVisible();
    await expect(page.getByText("This conversation is closed.")).toBeVisible();
    await noOverflow(page);
    await noAxeViolations(page);

    await page.goto("/");
    const today = page.locator("#deals");
    const row = today.getByRole("link", { name: /@kesarandclay/ });
    await expect(row).toContainText("₹1.2L");
    await expect(row).toContainText("3 stories to deliver");
    await expect(today.getByRole("link", { name: /@tealeaf\.co/ })).toContainText("Overdue 6 days · Remind");
    await noOverflow(page);

    await page.goto("/ledger");
    const owed = page.locator("#owed");
    await expect(owed.getByRole("link", { name: "@kesarandclay", exact: true })).toBeVisible();
    await owed.getByRole("button", { name: "Mark paid: 2 reels + 3 stories" }).click();
    const paid = page.getByRole("dialog", { name: "Mark paid" });
    const received = paid.getByLabel("Received (₹)");
    await expect(received).toHaveValue("120000");
    await paid.getByText("Received less than this?").click();
    await paid.getByLabel(/^Tax withheld \(TDS\)/).fill("12000");
    await expect(received).toHaveValue("108000");
    await expect(paid.getByText("Adds ₹1,20,000 to your revenue.")).toBeVisible();
    await paid.getByRole("button", { name: "Mark paid", exact: true }).click();
    await expect(paid).toBeHidden();
    await expect(owed.getByRole("link", { name: "@kesarandclay", exact: true })).toHaveCount(0);
    const sale = page.locator("#sales li").filter({ has: page.getByRole("link", { name: "@kesarandclay", exact: true }) });
    await expect(sale).toContainText("₹1,20,000");
    await noOverflow(page);
    await noAxeViolations(page);
  });

  test("an overdue deal's Remind puts a payment reminder in the composer", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/ledger");
    const owed = page.locator("#owed");
    await expect(owed.getByText("Overdue 6 days", { exact: true })).toBeVisible();
    await owed.getByRole("link", { name: /^Remind @tealeaf\.co/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: /TeaLeaf/ })).toBeVisible();
    // The reminder is drafted once; the address drops ?remind= so a reload doesn't write another.
    await expect.poll(() => new URL(page.url()).searchParams.has("remind")).toBe(false);
    await expect(page.getByText("Payment reminder", { exact: true })).toBeVisible();
    // Instagram's reply window closed weeks ago: copy it and send it from Instagram, never from here.
    const reminder = page.getByLabel("Edit before copying");
    // It chases what is still due: the open invoice, GST included.
    await expect(reminder).toHaveValue(/₹70,800 for Winter blend reel \+ 2 stories/);
    await expect(page.getByRole("link", { name: "Copy and open Instagram" })).toHaveAttribute("href", "https://ig.me/m/tealeaf.co");
    await expect(page.getByRole("button", { name: "Approve & send" })).toHaveCount(0);
    await noOverflow(page);
    await noAxeViolations(page);
  });

  test("a terms recap lands in the composer for approval", async ({ page }) => {
    await page.goto("/thread/t-founders");
    const card = page.getByRole("article", { name: "Founder fitness session" });
    await expect(card.getByText("45-minute session")).toBeVisible();
    await card.getByRole("button", { name: "Send terms recap" }).click();
    await expect(page.getByText("Terms recap", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Review and edit before sending")).toHaveValue(/Founder fitness session: ₹50,000[\s\S]*50% advance/);
    // Approval stays with the creator: nothing has been sent.
    await expect(page.getByRole("button", { name: "Approve & send" })).toBeVisible();
    await expect(page.getByText("Sent with DealDock")).toHaveCount(1);
    await noOverflow(page);
  });

  test("asking for payment moves the deal on and offers the agreed due date", async ({ page }) => {
    await page.goto("/thread/t-founders");
    const card = page.getByRole("article", { name: "Founder fitness session" });
    await card.getByRole("button", { name: "More for Founder fitness session" }).click();
    for (const item of ["Ask for payment", "Mark paid", "Edit deal", "Cancel deal", "Delete deal"]) await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
    await page.getByRole("menuitem", { name: "Ask for payment" }).click();
    const sheet = page.getByRole("dialog", { name: "Ask for payment" });
    await expect(sheet.getByText("You agreed on payment within 15 days.")).toBeVisible();
    await expect(sheet.getByLabel("Payment due, optional")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await sheet.getByRole("button", { name: "Mark payment requested" }).click();
    await expect(sheet).toBeHidden();
    await expect(card.getByText("Payment requested", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Mark paid" })).toBeVisible();
  });
});
