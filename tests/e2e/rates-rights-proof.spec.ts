import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Fictional demo data only: offers, links, deals and results live in the browser, never against the real API.
test.describe("rates, rights and proof in the demo", () => {
  test.skip(process.env.E2E_DEMO_PRODUCT !== "true", "Requires an explicitly started local demo app.");
  test.use({ reducedMotion: "reduce" });

  const ZONE = "Asia/Kolkata";
  const DAY = 86_400_000;
  /** A date input's value, `days` from today on the org's calendar. */
  const dayInput = (days: number) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now() + days * DAY);
  /** How the app writes that day: "9 Nov". */
  const dayText = (days: number) => new Intl.DateTimeFormat("en-IN", { timeZone: ZONE, day: "numeric", month: "short" }).format(Date.now() + days * DAY);

  async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  async function noAxeViolations(page: Page) {
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  }
  /** TeaLeaf's conversation: an invoiced deal for 1 reel + 2 stories, both delivered. */
  async function openTeaLeaf(page: Page) {
    await page.goto("/ledger");
    // Straight to its address: a first visit to a route can still be compiling on a development server.
    const href = await page.locator("#owed").getByRole("link", { name: "@tealeaf.co", exact: true }).getAttribute("href");
    await page.goto(href!);
    await expect(page.getByRole("heading", { level: 1, name: /TeaLeaf/ })).toBeVisible({ timeout: 30_000 });
    return page.getByRole("article", { name: "Winter blend reel + 2 stories" });
  }
  /** Edit the TeaLeaf deal's terms under "More terms". */
  async function editTerms(page: Page, fill: (sheet: ReturnType<Page["getByRole"]>) => Promise<void>) {
    const card = await openTeaLeaf(page);
    await card.getByRole("button", { name: "More for Winter blend reel + 2 stories" }).click();
    await page.getByRole("menuitem", { name: "Edit deal" }).click();
    const sheet = page.getByRole("dialog", { name: "Edit deal" });
    await sheet.getByText("More terms", { exact: true }).click();
    await fill(sheet);
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(sheet).toBeHidden();
  }

  test("add-on prices and the private rate-card link, from the Offers page to the public page and back", async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto("/offers");
    await page.getByRole("button", { name: "Edit Reel + 2 stories" }).click();
    const sheet = page.getByRole("dialog", { name: "Edit offer" });
    await sheet.getByText("Add-on prices (optional)", { exact: true }).click();
    // Typical ranges, worked out on the offer's starting price.
    await expect(sheet.getByText(/Typical: 15–35% of your fee per 30 days.*On ₹60K, that's about ₹9K–₹21K\./)).toBeVisible();
    await sheet.getByLabel("Usage rights per month (₹), optional").fill("15000");
    await sheet.getByLabel("Rush delivery (₹), optional").fill("10000");
    await noAxeViolations(page);
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(sheet).toBeHidden();

    const link = page.getByRole("region", { name: "Rate card link" });
    // Roster: one link per creator.
    await expect(link.getByLabel("Creator")).toHaveValue("ig-demo-diya");
    await link.getByRole("button", { name: "Create link" }).click();
    const open = link.getByRole("link", { name: "Open" });
    const href = await open.getAttribute("href");
    expect(href).toMatch(/\/rates\/[A-Za-z0-9_-]{32}$/);
    await noOverflow(page);

    // "Send your rates": one tap puts the link into a brand's draft, without writing a new one.
    await page.goto("/thread/t-kesar");
    const draft = page.getByLabel("Review and edit before sending");
    await expect(draft).toHaveValue(/Heyy/, { timeout: 30_000 });
    await page.getByRole("button", { name: "Add rate card link" }).click();
    await expect(draft).toHaveValue(new RegExp(`\\n${href!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    await expect(page.getByRole("button", { name: "Add rate card link" })).toBeDisabled();

    // The public page: the creator, their offers and the add-ons set, no workspace around it.
    await page.goto(href!);
    await expect(page.getByRole("heading", { level: 1, name: "@diya.moves" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    const reel = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Reel + 2 stories" }) });
    await expect(reel).toContainText("₹60,000–₹90,000");
    await expect(reel.getByText("Usage rights", { exact: true })).toBeVisible();
    await expect(reel.getByText("₹15,000")).toBeVisible();
    await expect(reel.getByText("Rush delivery", { exact: true })).toBeVisible();
    await expect(page.getByText("Corporate wellness workshop")).toHaveCount(0); // paused
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
    await noOverflow(page);
    await noAxeViolations(page);

    // Turning it off ends the link at once.
    await page.goto("/offers");
    await page.getByRole("region", { name: "Rate card link" }).getByRole("button", { name: "Turn off" }).click();
    await page.getByRole("dialog", { name: "Turn off this link?" }).getByRole("button", { name: "Turn off link" }).click();
    await expect(page.getByRole("region", { name: "Rate card link" }).getByRole("button", { name: "Create link" })).toBeVisible();
    await page.goto(href!);
    await expect(page.getByRole("heading", { level: 1, name: "This rate card isn't available." })).toBeVisible();
  });

  test("a usage end date brings a Today reminder that drafts the renewal, and Done clears it", async ({ page }) => {
    test.setTimeout(240_000);
    await editTerms(page, async (sheet) => {
      await sheet.getByLabel("Usage, optional").fill("Paid ads, 3 months");
      await sheet.getByLabel("Usage ends").fill(dayInput(5));
    });

    await page.goto("/");
    const rights = page.locator("#rights");
    const reminder = `@tealeaf.co's usage rights on 1 reel and 2 stories end ${dayText(5)}`;
    await expect(rights.getByText(reminder)).toBeVisible();
    await noOverflow(page);
    await noAxeViolations(page);
    await rights.getByRole("link", { name: `Draft renewal: ${reminder}` }).click();
    // A first visit to the conversation route can still be compiling on a development server.
    await page.waitForURL(/\/thread\//, { timeout: 60_000 });

    // The window to TeaLeaf closed long ago: the note is drafted to copy into Instagram.
    await expect(page.getByText("Usage rights", { exact: true })).toBeVisible({ timeout: 30_000 });
    const note = page.getByLabel("Edit before copying");
    await expect(note).toHaveValue(new RegExp(`usage rights for 1 reel and 2 stories end on ${dayText(5)}\\.`));
    // No usage price is set yet, so it asks how long instead of naming one.
    await expect(note).toHaveValue(/how long would you like to extend for\? I'll confirm the price\./);
    await expect(note).not.toHaveValue(/₹/);
    await expect(page).not.toHaveURL(/usage=/);

    await page.goto("/");
    await page.locator("#rights").getByRole("button", { name: `Done: ${reminder}` }).click();
    await expect(page.locator("#rights")).toHaveCount(0);
  });

  test("an exclusivity shows on another brand's conversation for the same creator, and only there", async ({ page }) => {
    test.setTimeout(240_000);
    await editTerms(page, async (sheet) => {
      await sheet.getByLabel("Exclusivity, optional").fill("No other tea brands");
      await sheet.getByLabel("Exclusivity ends").fill(dayInput(20));
    });

    await page.goto("/thread/t-kesar");
    await expect(page.getByRole("heading", { level: 1, name: /Kesar/ })).toBeVisible({ timeout: 30_000 });
    const warning = page.getByRole("note").filter({ hasText: "You agreed to exclusivity" });
    await expect(warning).toHaveText(`You agreed to exclusivity with @tealeaf.co until ${dayText(20)}: ‘No other tea brands’. Check this brand doesn't compete.`);
    await noOverflow(page);
    await noAxeViolations(page);

    // Another creator's brand conversation never sees it.
    await page.goto("/thread/t-saffron");
    await expect(page.getByRole("heading", { level: 1, name: /Saffron Pantry/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("You agreed to exclusivity")).toHaveCount(0);
  });

  test("a posted deliverable asks for results on Today, and the invoice shows the proof", async ({ page }) => {
    test.setTimeout(240_000);
    const card = await openTeaLeaf(page);
    await card.getByRole("button", { name: /Posts and results/ }).click();
    const proof = page.getByRole("dialog", { name: "Posts and results" });
    const reel = proof.getByRole("listitem").filter({ hasText: "1 reel" });
    await reel.getByRole("button", { name: "Mark posted" }).click();
    await reel.getByLabel("Post link").fill("https://www.instagram.com/reel/Cx1AbC9/");
    await reel.getByLabel("Posted on").fill(dayInput(-8));
    await reel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(reel.getByText(`Posted ${dayText(-8)}`)).toBeVisible();
    // Results can be fetched from Instagram for a reel; stories are typed in.
    await expect(reel.getByRole("button", { name: "Fetch from Instagram" })).toBeVisible();
    await proof.getByText("Disclosure checklist", { exact: true }).click();
    await proof.getByLabel("“Paid partnership” label turned on").check();
    await expect(proof.getByText("Disclosure checklist · 1 of 4")).toBeVisible();
    await noAxeViolations(page);
    await proof.getByRole("button", { name: "Close" }).first().click();
    await expect(proof).toBeHidden();

    // A week after posting, Today asks for the numbers and opens the deal's posts.
    await page.goto("/");
    const due = page.locator("#rights").getByRole("button", { name: /Add results for 1 reel for @tealeaf\.co/ });
    await expect(due).toBeVisible();
    await due.click();
    const sheet = page.getByRole("dialog", { name: "Posts and results" });
    const row = sheet.getByRole("listitem").filter({ hasText: "1 reel" });
    await row.getByRole("button", { name: "Add results" }).click();
    await row.getByLabel("Views").fill("12400");
    await row.getByLabel("Reach").fill("9,800");
    await row.getByLabel("Likes").fill("1130");
    await row.getByRole("button", { name: "Save results" }).click();
    await expect(row.getByText("12,400 views · 9,800 reach · 1,130 likes")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Copy results" })).toBeVisible();
    await noOverflow(page);
    await sheet.getByRole("button", { name: "Close" }).first().click();
    await expect(page.locator("#rights")).toHaveCount(0);

    // The invoice the brand pays from carries the proof.
    const invoiceCard = await openTeaLeaf(page);
    await invoiceCard.getByRole("button", { name: /^Preview invoice / }).click();
    const preview = page.getByRole("dialog", { name: /^Invoice DM-/ });
    const section = preview.getByRole("article").locator("section").filter({ hasText: "Proof of delivery" });
    await expect(section.getByText(/1 reel, posted/)).toBeVisible();
    await expect(section.getByText("https://www.instagram.com/reel/Cx1AbC9/")).toBeVisible();
    await expect(section.getByText(/Results as of .*: 12,400 views · 9,800 reach · 1,130 likes/)).toBeVisible();
    await expect(section.getByText("Disclosure: “Paid partnership” label turned on")).toBeVisible();
    await noAxeViolations(page);
  });
});
