import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Fictional demo data only: renewals, stages and reported payments run in the browser, never against the real API.
// The development server compiles a route on its first visit, so the first look after a navigation waits longer.
const afterNavigation = expect.configure({ timeout: 30_000 });

test.describe("renewals and the coach pipeline in the demo", () => {
  test.skip(process.env.E2E_DEMO_PRODUCT !== "true", "Requires an explicitly started local demo app.");
  test.use({ reducedMotion: "reduce" });

  async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  /** Scans only what this feature added, so another screen's work in progress can't fail it. */
  async function noAxeViolations(page: Page, selector: string) {
    expect((await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  }

  test("a renewal on Today drafts a pitch, and Not now puts it away", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/");
    const renewals = page.locator("#renewals");
    await afterNavigation(renewals.getByText("Pitch @urbanroots.in again")).toBeVisible();
    await expect(renewals.getByText(/Paid ₹60,000 on \d{1,2} [A-Z][a-z]{2}/)).toBeVisible();
    await noAxeViolations(page, "#renewals");
    await noOverflow(page);

    await renewals.getByRole("link", { name: "Draft a pitch to @urbanroots.in" }).click();
    await afterNavigation(page.getByRole("heading", { level: 1, name: /Urban Roots/ })).toBeVisible();
    // The pitch is drafted once, as a draft to check; the reply window closed long ago, so it goes out from Instagram.
    await expect(page.getByText("Pitch again", { exact: true })).toBeVisible();
    const pitch = page.getByLabel("Edit before copying");
    await expect(pitch).toHaveValue(/^Heyy! Loved working with you on .+ I'd love to team up again\./);
    await expect(pitch).toHaveValue(/My rate for a reel \+ 2 stories is ₹60,000–₹90,000 now\./);
    await expect(page.getByRole("link", { name: "Copy and open Instagram" })).toBeVisible();
    await expect(page).not.toHaveURL(/pitch=/);
    await noOverflow(page);

    await page.goto("/");
    await renewals.getByRole("button", { name: "Not now: @urbanroots.in" }).click();
    await expect(page.getByText("Okay. @urbanroots.in comes back here only after another paid deal.")).toBeVisible();
    await expect(page.locator("#renewals")).toHaveCount(0);
  });

  test("a stage change in a coaching conversation shows in the inbox and the Today summary", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/");
    const pipeline = page.getByRole("region", { name: "Coaching and courses" });
    await expect(pipeline.getByRole("link", { name: "Qualified: 1 conversation" })).toBeVisible();
    await noAxeViolations(page, "section[aria-labelledby='pipeline-title']");

    await page.goto("/thread/t-arjun");
    const stage = page.getByRole("radiogroup", { name: "Stage" });
    await afterNavigation(stage.getByRole("radio", { name: "Lead" })).toHaveAttribute("aria-checked", "true");
    await stage.getByRole("radio", { name: "Qualified" }).click();
    await expect(stage.getByRole("radio", { name: "Qualified" })).toHaveAttribute("aria-checked", "true");
    await noAxeViolations(page, "section[aria-label='Sender']");

    await page.goto("/inbox");
    await afterNavigation(page.locator('[data-thread-row="t-arjun"]')).toContainText("Qualified");
    await expect(page.locator('[data-thread-row="t-karan"]')).toContainText("Booked");

    await page.goto("/");
    await pipeline.getByRole("link", { name: "Qualified: 2 conversations" }).click();
    await afterNavigation(page).toHaveURL(/\/inbox\?stage=qualified$/);
    const list = page.getByRole("region", { name: "Qualified" });
    await expect(page.getByRole("group", { name: "Stage" }).getByRole("button", { name: /^Qualified/ })).toHaveAttribute("aria-pressed", "true");
    await expect(list.locator('[data-thread-row="t-arjun"]')).toBeVisible();
    await expect(list.locator('[data-thread-row="e-neha"]')).toBeVisible();
    await expect(page.locator('[data-thread-row="t-sana"]')).toHaveCount(0);
    await page.getByRole("button", { name: "All conversations" }).click();
    await expect(page.getByRole("tablist", { name: "Inbox views" })).toBeVisible();
    await noOverflow(page);
  });

  test("a payment a tool reported suggests recording the sale, and records it", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/thread/t-sana");
    await afterNavigation(page.getByText("Paid ₹24,000 through Razorpay")).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Stage" }).getByRole("radio", { name: "Paid" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Record the sale" }).click();
    const sheet = page.getByRole("dialog", { name: "Record a deal" });
    await expect(sheet.getByText("Paid ₹24,000 through Razorpay by Sana Qureshi. Check it, then save to add it to your revenue.")).toBeVisible();
    await expect(sheet.getByLabel("Amount (₹)")).toHaveValue("24000");
    await expect(sheet.getByRole("switch", { name: "Already paid?" })).toHaveAttribute("aria-checked", "true");
    await expect(sheet.getByLabel("What", { exact: true })).toHaveValue("Coaching");
    await noAxeViolations(page, "dialog[open]");
    await sheet.getByRole("button", { name: "Save deal" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByText("Deal recorded. ₹24,000 is in your revenue now.")).toBeVisible();
    await expect(page.getByText("Paid ₹24,000 through Razorpay")).toHaveCount(0);
    await expect(page.getByText("This conversation is closed.")).toBeVisible();
  });

  test("connecting a tool in Settings shows its address once", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/settings#tools");
    const tools = page.locator("#tools");
    await afterNavigation(tools.getByText("1 payment we couldn't match")).toBeVisible();
    await expect(tools.getByText("Razorpay", { exact: true })).toBeVisible();
    await expect(tools.getByText("Calendly", { exact: true })).toBeVisible();
    await noAxeViolations(page, "#tools");

    await tools.getByRole("button", { name: "Connect a booking or payment tool" }).click();
    const sheet = page.getByRole("dialog", { name: "Connect a tool" });
    await sheet.getByRole("button", { name: /Something else/ }).click();
    const other = page.getByRole("dialog", { name: "Connect another tool" });
    await other.getByRole("button", { name: "Get the address" }).click();
    const address = other.getByLabel("Address to paste into the tool");
    await expect(address).toHaveValue(/^https:\/\/[^/]+\/webhooks\/leads\/[A-Za-z0-9_-]{43}$/);
    await expect(other.getByText("DealDock shows it only this once.", { exact: false })).toBeVisible();
    await expect(other.getByText('"event": "booked" or "paid"', { exact: false })).toBeVisible();
    await noAxeViolations(page, "dialog[open]");
    await other.getByRole("button", { name: "Done" }).click();
    await expect(other).toBeHidden();
    await expect(tools.getByText("Zapier, Make or your own tools · no activity yet")).toBeVisible();

    // The payment nobody could match goes to a coaching conversation picked from the recent ones.
    await tools.getByRole("button", { name: "Match to a conversation" }).click();
    const match = page.getByRole("dialog", { name: "Match to a conversation" });
    await match.getByRole("button", { name: /Meera Iyer/ }).click();
    await expect(match).toBeHidden();
    await expect(tools.getByText("we couldn't match", { exact: false })).toHaveCount(0);
    await noOverflow(page);
  });
});
