import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";

// These exercise fictional in-browser demo data, never the API-backed gate.
test.describe("demo product UI regressions", () => {
  test.skip(process.env.E2E_DEMO_PRODUCT !== "true", "Requires an explicitly started local demo app.");

  async function noHorizontalOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }

  async function noAxeViolations(page: Page) {
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations).toEqual([]);
  }

  test("onboarding respects declining voice learning through the scan and reveal", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: "Find the money hiding in your DMs." })).toBeVisible();
    await page.getByRole("button", { name: "Get started" }).click();
    await expect(page.getByRole("heading", { name: "Where do you get paid?" })).toBeVisible();
    await expect(page.getByRole("radio", { name: /Indian rupee/ })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Connect your Instagram" })).toBeVisible();
    // DemoStore.connectInstagram returns a relative onboarding URL; no external OAuth occurs.
    await page.getByRole("button", { name: "Continue with Instagram" }).click();
    await expect(page).toHaveURL(/\/onboarding\?step=connect&connected=diya\.moves/);
    await expect(page.getByText("Instagram · sample account")).toBeVisible();
    await page.waitForLoadState("networkidle"); // Full demo callback navigation must hydrate before the next click.
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "What do you sell?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Brand collaborations" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Drafts that sound like you" })).toBeVisible();
    await expect(page.getByText("Drafts stay off until you give permission.", { exact: false })).toBeVisible();
    const decline = page.getByRole("button", { name: "Not now" });
    await expect(decline).toBeEnabled();
    await decline.click();
    await expect(page.getByRole("heading", { name: "Scanning available recent DMs…" })).toBeVisible();
    await expect(page).toHaveURL(/step=reveal/, { timeout: 30_000 });
    await expect(page.getByText("Review each conversation before replying. Nothing sends without you.")).toBeVisible();
    await expect(page.getByText("Upper estimate", { exact: true })).toHaveCount(3);
    await expect(page.getByText(/draft.*ready|ready.*draft/i)).toHaveCount(0);
    await page.screenshot({ path: `.turbo/ui-audit-${testInfo.project.name === "mobile" ? "mobile" : "desktop"}-onboarding.png`, fullPage: true, animations: "disabled" });
    await page.goto("/voice");
    await expect(page.getByRole("heading", { name: "Teach DealDock how @diya.moves writes" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Turn on voice learning" })).toBeVisible();
  });

  test("all creators are identified and a conversation names its creator", async ({ page }) => {
    test.setTimeout(90_000); // Two full axe scans can be slow during local development builds.
    await page.goto("/inbox");
    await expect(page.getByRole("group", { name: "Creator" })).toBeVisible();
    const rows = page.locator('a[href^="/thread/"]');
    await expect(rows.first()).toBeVisible();
    for (const row of await rows.all()) await expect(row).toContainText(/@(diya\.moves|rohan\.cooks|ira\.wanders)/);
    await noHorizontalOverflow(page);
    await noAxeViolations(page);
    await page.goto("/thread/t-saffron");
    await expect(page.getByText("Replying as", { exact: false })).toContainText("@rohan.cooks");
    await noHorizontalOverflow(page);
    await noAxeViolations(page);
  });

  test("invalid view falls back to the inbox", async ({ page }) => {
    await page.goto("/inbox?view=invalid");
    await expect(page.getByRole("tab", { name: /Needs you/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('a[href^="/thread/"]').first()).toBeVisible();
    await expect(page.getByText(/application error/i)).toHaveCount(0);
  });

  test("phone inbox filters provide 44px touch targets without overflow", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "Phone-specific touch targets.");
    await page.goto("/inbox");
    const tabs = page.getByRole("tablist", { name: "Inbox views" }).getByRole("tab");
    await expect(tabs).toHaveCount(5);
    const filters = page.getByRole("group", { name: "Creator" }).getByRole("button");
    await expect(filters).toHaveCount(4);
    for (const control of [...await tabs.all(), ...await filters.all()]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    await noHorizontalOverflow(page);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      for (const [id, text] of [["t-monsoon", /^\d+[hm] left$/], ["t-peakfuel", "Follow-up due"]] as const) {
        const row = page.locator(`[data-thread-row="${id}"]`).first();
        for (const metadata of [row.getByText("@diya.moves", { exact: true }), row.getByText(text, { exact: true })]) {
          await expect(metadata).toBeVisible();
          expect(await metadata.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const rowRect = element.closest("[data-thread-row]")!.getBoundingClientRect();
            if (rect.left < rowRect.left - 1 || rect.right > rowRect.right + 1) return false;
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
              if (!/hidden|clip|auto|scroll/.test(getComputedStyle(parent).overflowX)) continue;
              const bounds = parent.getBoundingClientRect();
              if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) return false;
            }
            return true;
          })).toBe(true);
        }
      }
      await noHorizontalOverflow(page);
    }
  });

  test("account, view and search survive opening a thread and returning", async ({ page }, testInfo) => {
    await page.goto("/inbox?account=ig-demo-diya&view=waiting&q=urban");
    await page.locator('a[href^="/thread/t-urbanloom"]').click();
    await expect(page).toHaveURL(/\/thread\/t-urbanloom\?/);
    const back = page.getByRole("link", { name: "Back to inbox", includeHidden: true });
    const href = await back.getAttribute("href");
    expect(href).not.toBeNull();
    const url = new URL(href!, "http://localhost");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ account: "ig-demo-diya", view: "waiting", q: "urban" });
    if (testInfo.project.name === "mobile") {
      await back.click();
      await expect(page.getByLabel("Search conversations")).toHaveValue("urban");
      await expect(page.getByRole("tab", { name: /Waiting/ })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("button", { name: "@diya.moves" })).toHaveAttribute("aria-pressed", "true");
    }
  });

  test("draft controls are progressive and protect edits on regenerate", async ({ page }) => {
    await page.goto("/thread/t-monsoon");
    const group = page.getByRole("group", { name: "Steer the draft" });
    await expect(group.getByRole("button", { name: "Shorter" })).toBeVisible();
    await expect(group.getByRole("button", { name: "Add my rate" })).toBeVisible();
    await expect(group.getByRole("button", { name: "Warmer" })).toBeHidden();
    await group.getByText("More reply options").click();
    await expect(group.getByRole("button", { name: "Warmer" })).toBeVisible();
    const composer = page.getByLabel("Review and edit before sending");
    await composer.fill("My edited draft stays here.");
    await page.getByRole("button", { name: "Regenerate draft" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "Replace your edits" });
    await expect(alert.getByRole("button", { name: "Replace", exact: true })).toBeVisible();
    await alert.getByRole("button", { name: "Keep mine" }).click();
    await expect(composer).toHaveValue("My edited draft stays here.");
    await noHorizontalOverflow(page);
  });

  test("new offers require an explicit creator or shared scope", async ({ page }) => {
    await page.goto("/offers");
    await page.getByRole("button", { name: "Add offer", exact: true }).first().click();
    const creator = page.getByLabel("Creator", { exact: true });
    await expect(creator).toHaveValue("");
    await expect(creator.locator('option[value="shared"]')).toHaveText("Shared across every creator");
  });

  test("Today prioritizes an actionable closing window", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Across all creators in this workspace")).toBeVisible();
    await expect(page.getByText("Estimated value across all creators’ DMs")).toBeVisible();
    const recommendation = page.getByRole("link", { name: "Reply before it closes" });
    await expect(recommendation).toHaveAttribute("href", "/thread/t-tiffin");
    await expect(page.getByText(/@tiffintheory\.co.*Review this one first/)).toBeVisible();
  });

  test("a disconnected creator's thread asks for reconnection before replying", async ({ page }) => {
    await page.goto("/thread/t-ferns");
    await expect(page.getByText("Reconnect @ira.wanders to reply.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Reconnect Instagram" })).toHaveAttribute("href", "/settings#instagram");
    await expect(page.getByRole("button", { name: "Approve & send" })).toHaveCount(0);
  });

  test("closed reply windows give a truthful follow-up instruction", async ({ page }) => {
    await page.goto("/thread/t-peakfuel");
    await expect(page.getByText("Follow up in Instagram; this reply window has closed.")).toBeVisible();
    await expect(page.getByText("Instagram's reply window has closed.", { exact: false })).toBeVisible();
    await expect(page.getByText(/follow-up.*below|drafted below/i)).toHaveCount(0);
    await expect(page.getByLabel("Review and edit before sending")).toHaveCount(0);
  });

  test("revenue filters persist in the URL and CSV matches the displayed creator and month", async ({ page }) => {
    await page.goto("/roster");
    await page.locator("article").filter({ has: page.getByRole("heading", { name: "@diya.moves" }) }).getByRole("link", { name: "Revenue report" }).click();
    await expect(page).toHaveURL(/account=ig-demo-diya/);
    const creator = page.getByLabel("Revenue for");
    await expect(creator).toHaveValue("ig-demo-diya");
    const tabs = page.getByRole("tablist", { name: "Month" }).getByRole("tab");
    await expect(tabs.first()).toBeVisible();
    await tabs.first().click();
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => new URL(page.url()).searchParams.get("month")).toMatch(/^\d{4}-\d{2}$/);
    const scopedUrl = new URL(page.url());
    expect(scopedUrl.searchParams.get("account")).toBe("ig-demo-diya");
    const month = scopedUrl.searchParams.get("month")!;
    await page.reload();
    await expect(creator).toHaveValue("ig-demo-diya");
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    const sales = page.locator("#sales li a[href^='/thread/']");
    await expect(sales.first()).toBeVisible();
    const displayed = (await sales.allTextContents()).sort();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("dealdock-revenue.csv");
    const csv = await readFile((await download.path())!, "utf8");
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe("date,handle,deal_type,amount_minor,currency,note");
    const rows = lines.slice(1).map((line) => line.split(","));
    // CSV protects spreadsheet users from formula-like values such as @handles.
    expect(rows.map((row) => row[1]).sort()).toEqual(displayed.map((handle) => `'${handle}`).sort());
    for (const row of rows) expect(row[0]).toMatch(new RegExp(`^${month}-`));
    await creator.selectOption("");
    await expect.poll(() => new URL(page.url()).searchParams.get("account")).toBeNull();
    expect(new URL(page.url()).searchParams.get("month")).toBe(month);
  });

  test("capture current product screens", async ({ page }, testInfo) => {
    const device = testInfo.project.name === "mobile" ? "mobile" : "desktop";
    for (const [route, name] of [["/", "home"], ["/roster", "roster"], ["/ledger", "ledger"]]) {
      await page.goto(route);
      await expect(page.getByTestId("demo-mode")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      if (route === "/ledger") {
        await page.getByLabel("Revenue for").selectOption("ig-demo-diya");
        await expect.poll(() => new URL(page.url()).searchParams.get("account")).toBe("ig-demo-diya");
        const firstMonth = page.getByRole("tablist", { name: "Month" }).getByRole("tab").first();
        await firstMonth.click();
        await expect(firstMonth).toHaveAttribute("aria-selected", "true");
        await expect(page.getByLabel("Revenue for")).toHaveValue("ig-demo-diya");
        await expect(page.locator("#sales li").first()).toBeVisible();
      }
      await page.screenshot({ path: `.turbo/ui-audit-${device}-${name}.png`, fullPage: true, animations: "disabled" });
    }
  });

  test("skipping review cards preserves the queue and advances focus", async ({ page }) => {
    await page.goto("/review");
    const status = page.getByRole("status").filter({ hasText: "to check" });
    await expect(status).toHaveText("0 sorted · 5 to check");
    const heading = page.locator("article h2");
    const first = await heading.innerText();
    for (let i = 0; i < 5; i++) {
      await page.getByRole("button", { name: "Not sure, skip" }).click();
      await expect(status).toHaveText("0 sorted · 5 to check");
      if (i < 4) await expect(heading).toBeFocused();
    }
    await expect(page.getByRole("heading", { name: "Left for later." })).toBeVisible();
    await expect(page.getByText("5 skipped messages still need a decision.", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: "All sorted." })).toHaveCount(0);
    await page.getByRole("button", { name: "Review skipped" }).click();
    await expect(heading).toHaveText(first);
    await expect(heading).toBeFocused();
    await expect(status).toHaveText("0 sorted · 5 to check");
  });

  test("undo restores a review decision to the queue", async ({ page }) => {
    await page.goto("/review");
    const status = page.getByRole("status").filter({ hasText: "to check" });
    await expect(status).toHaveText("0 sorted · 5 to check");
    const heading = page.locator("article h2");
    const first = await heading.innerText();
    await page.getByRole("button", { name: /^Yes, / }).click();
    await expect(status).toHaveText("1 sorted · 4 to check");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(status).toHaveText("0 sorted · 5 to check");
    await expect(heading).toHaveText(first);
    await expect(heading).toBeFocused();
  });
});
