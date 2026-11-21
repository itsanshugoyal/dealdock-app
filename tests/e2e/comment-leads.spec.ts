import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Fictional demo comments only: nothing reaches Instagram, and every reply waits for a person.
test.describe("comment leads in the demo", () => {
  test.skip(process.env.E2E_DEMO_PRODUCT !== "true", "Requires an explicitly started local demo app.");
  test.use({ reducedMotion: "reduce" });

  async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  async function noAxeViolations(page: Page) {
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  }

  test("a creator sets a keyword in Settings, per creator on Roster", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/settings#comment-leads");
    const section = page.locator("#comment-leads");
    await expect(section).toContainText("When someone comments one of these words on your post, DealDock drafts a private reply for you to approve.");
    const diya = section.getByRole("list", { name: "Keywords for @diya.moves" });
    await expect(diya).toContainText("PRICE");
    await expect(diya).toContainText("LINK");

    const field = section.getByRole("textbox", { name: "Keyword" });
    await field.fill("x".repeat(31));
    await section.getByRole("button", { name: "Add" }).click();
    await expect(section.getByText("Keep each keyword to 30 characters.")).toBeVisible();
    await field.fill("  price ");
    await section.getByRole("button", { name: "Add" }).click();
    await expect(section.getByText("price is already a keyword.")).toBeVisible();
    await field.fill("  how   much ");
    await section.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText("Comments with how much now get a private reply drafted.")).toBeVisible();
    await expect(diya.getByText("how much", { exact: true })).toBeVisible();
    await expect(field).toHaveValue("");

    // Another creator's keywords are their own.
    await section.getByRole("combobox", { name: "Keywords for" }).selectOption({ label: "@rohan.cooks" });
    const rohan = section.getByRole("list", { name: "Keywords for @rohan.cooks" });
    await expect(rohan).toContainText("RECIPE");
    await expect(rohan).not.toContainText("PRICE");
    await rohan.getByRole("button", { name: "Remove the keyword RECIPE" }).click();
    await expect(section.getByText("No keywords yet.")).toBeVisible();
    await noOverflow(page);
    await noAxeViolations(page);
  });

  test("leads are listed from Today; one is edited and sent privately, one skipped, and the expired one cleared", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    const line = page.getByRole("link", { name: /4 people commented PRICE/ });
    await expect(line).toContainText("Nothing sends until you approve it.");
    await line.click();
    await expect(page).toHaveURL(/\/inbox\?view=comments/);

    const tab = page.getByRole("tab", { name: "Comments 4" });
    await expect(tab).toHaveAttribute("aria-selected", "true");
    // Every creator's keywords on Roster's "All creators"; each lead names whose post it was.
    await expect(page.getByText("Private replies to people who commented PRICE, LINK or RECIPE. Nothing sends until you approve it.")).toBeVisible();

    // The comment closest to its 7 days is open first, in red, with its post and its draft.
    const sana = page.locator('[data-comment-lead="cl-sana"]');
    await expect(sana).toHaveAttribute("aria-expanded", "true");
    await expect(sana).toContainText("@sana.runs");
    await expect(sana).toContainText("price for the cohort??");
    await expect(sana.getByText(/hours? left/)).toHaveClass(/text-danger/);
    await expect(page.getByRole("link", { name: /View the post/ })).toHaveAttribute("href", /^https:\/\/www\.instagram\.com\//);
    const reply = page.getByRole("textbox", { name: "Private reply to @sana.runs" });
    await expect(reply).toHaveValue(/Strength Basics cohort is ₹7,999/);
    await noOverflow(page);
    await noAxeViolations(page);

    // Edit, then send privately: the undo window first, then Sent.
    await reply.fill("Heyy Sana! The cohort is ₹7,999 and starts 1 Dec: https://example.com/diya/strength-basics Want a spot? – D");
    await page.getByRole("button", { name: "Send privately" }).press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Sending to @sana.runs" })).toBeVisible();
    await expect(page.getByText("Private reply sent to @sana.runs.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("tab", { name: "Comments 3" })).toBeVisible();
    await page.locator("summary", { hasText: /^Sent\s*2$/ }).click();
    await expect(page.getByText("Heyy Sana! The cohort is ₹7,999 and starts 1 Dec", { exact: false })).toBeVisible();

    // The next comment opens by itself. Skip it, undo, then skip it for real.
    const arjun = page.locator('[data-comment-lead="cl-arjun"]');
    await expect(arjun).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await expect(arjun).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(arjun).toBeVisible();
    await arjun.click();
    await expect(arjun).toHaveAttribute("aria-expanded", "false");
    await arjun.click();
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await expect(arjun).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Comments 2" })).toBeVisible({ timeout: 15_000 });

    // Past its 7 days: greyed, no reply possible, and cleared on request.
    const late = page.getByRole("region", { name: "Too late to reply privately" });
    await expect(late).toContainText("@neel.moves");
    await expect(late.getByRole("textbox")).toHaveCount(0);
    await late.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByText("Cleared 1 comment too late to answer.")).toBeVisible();
    await expect(late).toHaveCount(0);

    // Who sent what is on record.
    await page.goto("/activity");
    await expect(page.getByText("sent a private reply to @sana.runs", { exact: false })).toBeVisible();
  });
});
