import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Fictional demo data only; these checks never seed or mock the real API.
test.describe("demo visual polish regressions", () => {
  test.skip(process.env.E2E_DEMO_PRODUCT !== "true", "Requires an explicitly started local demo app.");
  test.use({ reducedMotion: "reduce" });

  async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }

  test("offer controls retain scope and editing while guidance starts collapsed", async ({ page }) => {
    await page.goto("/offers");
    const article = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Reel + 2 stories" }) });
    const toggle = article.getByRole("switch", { name: "Use in drafts for Reel + 2 stories" });
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const guide = page.locator("details").filter({ hasText: "How offers shape a draft" });
    await expect(guide).not.toHaveAttribute("open", "");
    await expect(page.getByText("4 active", { exact: true })).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(article.getByText("Paused", { exact: true })).toBeVisible();
    await expect(page.getByText("3 active", { exact: true })).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(article.getByText("Paused", { exact: true })).toHaveCount(0);
    await expect(page.getByText("4 active", { exact: true })).toBeVisible();
    await article.getByRole("button", { name: "Edit Reel + 2 stories" }).click();
    await expect(page.getByRole("dialog").getByLabel("Creator", { exact: true })).toHaveValue("shared");
    await expect(page.getByLabel("Price from")).toHaveValue("60000");
    await expect(page.getByLabel("Up to", { exact: false })).toHaveValue("90000");
    await noOverflow(page);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    await page.getByLabel("Name", { exact: true }).fill("My unsaved offer name");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByText("Discard changes?", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("My unsaved offer name");
  });

  test("inbox filters fit the pane and every view is reachable by keyboard", async ({ page }, testInfo) => {
    await page.setViewportSize(testInfo.project.name === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.goto("/inbox");
    const creators = page.getByRole("group", { name: "Creator" });
    const rail = page.getByRole("tablist", { name: "Inbox views" });
    await expect(creators.getByRole("button")).toHaveCount(4);
    // Six views: the demo has comment leads, so Comments shows.
    await expect(rail.getByRole("tab")).toHaveCount(6);
    // The old arrow buttons are gone: chips and tabs scroll natively, with the edge item peeking.
    await expect(page.getByRole("button", { name: /^Scroll / })).toHaveCount(0);
    const needs = rail.getByRole("tab", { name: /Needs you/ });
    await needs.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    const closed = rail.getByRole("tab", { name: "Closed" });
    await expect(closed).toHaveAttribute("aria-selected", "true");
    await expect(closed).toBeFocused();
    expect(await closed.evaluate((element) => {
      const item = element.getBoundingClientRect();
      const parent = element.parentElement!.getBoundingClientRect();
      return item.left >= parent.left - 1 && item.right <= parent.right + 1;
    })).toBe(true);
    await page.keyboard.press("Home");
    await expect(needs).toHaveAttribute("aria-selected", "true");
    // With Comments shown the six views scroll sideways on the desk too, and the selected one is kept in view (checked above).
    await noOverflow(page);
  });

  test("settings navigation updates the anchor and reaches its section", async ({ page }, testInfo) => {
    await page.goto("/settings#appearance");
    await expect(page.getByRole("heading", { name: "Appearance & sending" })).toBeInViewport();
    await page.goto("/settings");
    const heading = page.getByRole("heading", { name: "Appearance & sending" });
    await expect(heading).toBeVisible();
    if (testInfo.project.name === "mobile") {
      await page.getByLabel("Jump to a setting").selectOption("appearance");
    } else {
      const link = page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Appearance", exact: true });
      await link.click();
      await expect(link).toHaveAttribute("aria-current", "location");
    }
    await expect(page).toHaveURL(/#appearance$/);
    await expect(heading).toBeInViewport();
    await expect(page.getByRole("switch", { name: "Weekly summary", exact: true })).toHaveCount(0);
  });

  test("activity filters recover from no matches and comparisons expand in place", async ({ page }, testInfo) => {
    await page.goto("/activity");
    await page.getByRole("group", { name: "Show", exact: true }).getByRole("button", { name: "Replies", exact: true }).click();
    await page.getByLabel("Person", { exact: true }).selectOption({ label: "Kabir Rao" });
    await expect(page.getByRole("heading", { name: "Nothing matches" })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(page.getByLabel("Person", { exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Everything", exact: true })).toHaveAttribute("aria-pressed", "true");
    const comparison = page.getByRole("button", { name: "See what changed", exact: true }).first();
    await comparison.click();
    const row = page.locator("li").filter({ has: page.getByRole("button", { name: "Hide changes", exact: true }) });
    await expect(row.getByText("Draft", { exact: true })).toBeVisible();
    await expect(row.getByText("Sent", { exact: true })).toBeVisible();
    const hide = row.getByRole("button", { name: "Hide changes", exact: true });
    await expect(hide).toHaveAttribute("aria-expanded", "true");
    if (testInfo.project.name === "mobile") expect((await hide.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await noOverflow(page);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    await hide.click();
    await expect(page.getByText("Draft", { exact: true })).toHaveCount(0);
  });

  test("what you sell and its usual prices can be edited after onboarding", async ({ page }) => {
    await page.goto("/settings#business");
    const section = page.locator("#business");
    await expect(section.getByText("₹24,000", { exact: true })).toBeVisible();
    await section.getByRole("button", { name: "Edit", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "What you sell" });
    await sheet.getByLabel(/Coaching package/).fill("30000");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(section.getByText("₹30,000", { exact: true })).toBeVisible();
    await noOverflow(page);
  });

  test("the check view starts sorting in the selected creator's scope", async ({ page }) => {
    await page.goto("/inbox?account=ig-demo-diya");
    await page.getByRole("tab", { name: "Check 5" }).click();
    const review = page.getByRole("link", { name: /Sort them one at a time/ });
    await expect(review).toHaveAttribute("href", "/review?account=ig-demo-diya");
    await review.click();
    await expect(page).toHaveURL(/\/review\?account=ig-demo-diya$/);
    await expect(page.getByRole("button", { name: "Not sure, skip" })).toBeVisible();
  });

  test("draft explanation preserves creator context and returns focus", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    for (const theme of ["Light", "Dark"] as const) {
      await page.goto("/settings");
      await page.getByRole("radio", { name: theme, exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme.toLowerCase());
      await page.goto("/thread/t-monsoon");
      const explanation = page.getByRole("button", { name: "Why this draft", exact: true });
      await explanation.click();
      const sheet = page.getByRole("dialog", { name: "Why this draft", exact: true });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole("link", { name: "Review this creator's voice" })).toHaveAttribute("href", "/voice?account=ig-demo-diya");
      await expect(sheet.getByText(/Check prices, dates and availability before approving/)).toBeVisible();
      await noOverflow(page);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
      await page.screenshot({ path: `.turbo/polish-${testInfo.project.name}-${theme.toLowerCase()}-draft-explanation.png`, animations: "disabled" });
      await sheet.getByRole("button", { name: "Close", exact: true }).click();
      await expect(sheet).not.toBeVisible();
      await expect(explanation).toBeFocused();
      await expect(page.getByLabel("Review and edit before sending")).not.toBeEmpty();
    }
  });

  const screens = [
    { name: "today", path: "/" },
    { name: "offers", path: "/offers" },
    { name: "roster", path: "/roster" },
    { name: "ledger", path: "/ledger" },
    { name: "voice", path: "/voice" },
    { name: "review", path: "/review" },
    { name: "activity", path: "/activity" },
    { name: "settings", path: "/settings" },
    { name: "sign-in", path: "/sign-in" },
  ] as const;

  for (const screen of screens) {
    test(`${screen.name} renders without overflow or WCAG 2 A/AA violations in both themes`, async ({ page }, testInfo) => {
      test.setTimeout(120_000);
      if (testInfo.project.name !== "mobile") await page.setViewportSize({ width: 1240, height: 800 });
      for (const theme of ["light", "dark"] as const) {
        await page.goto("/settings");
        const radio = page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: theme === "light" ? "Light" : "Dark" });
        await radio.click();
        await expect(radio).toHaveAttribute("aria-checked", "true");
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        if (screen.path !== "/settings") await page.goto(screen.path);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        if (screen.name === "today") await expect(page.getByRole("link", { name: "Reply before it closes" })).toBeVisible();
        if (screen.name === "offers") await expect(page.getByRole("button", { name: "Edit Reel + 2 stories" })).toBeVisible();
        if (screen.name === "roster") await expect(page.getByRole("heading", { name: "@diya.moves" })).toBeVisible();
        if (screen.name === "ledger") await expect(page.getByText(/sales? you confirmed/)).toBeVisible();
        if (screen.name === "voice") {
          await expect(page.getByText("Sent with DealDock", { exact: true })).toBeVisible();
          await page.getByText("Fine-tune writing style", { exact: true }).click();
          const scopes = page.getByRole("group", { name: "Measured for" });
          await expect(scopes).toBeVisible();
          for (const chip of await scopes.getByRole("button").all()) {
            expect(await chip.evaluate((element) => {
              const box = element.getBoundingClientRect();
              const group = element.parentElement!.getBoundingClientRect();
              return box.left >= group.left - 1 && box.right <= group.right + 1;
            })).toBe(true);
          }
        }
        if (screen.name === "review") await expect(page.getByRole("button", { name: "Not sure, skip" })).toBeVisible();
        if (screen.name === "activity") await expect(page.locator("main ol li").first().or(page.getByText("No activity yet"))).toBeVisible();
        if (screen.name === "settings") await expect(page.getByRole("heading", { name: "Appearance & sending" })).toBeVisible();
        if (screen.name === "sign-in") await expect(page.getByRole("heading", { name: "Sign-in is unavailable" })).toBeVisible();
        await noOverflow(page);
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        expect(results.violations).toEqual([]);
        await page.screenshot({ path: `.turbo/polish-${testInfo.project.name}-${theme}-${screen.name}.png`, fullPage: true, animations: "disabled" });
      }
    });
  }
});
