import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Fictional demo data only: no Google, no Instagram, no real inbox is ever touched.
test.describe("email, scam warnings, creator profiles and voice disclosure in the demo", () => {
  test.skip(process.env.E2E_DEMO_PRODUCT !== "true", "Requires an explicitly started local demo app.");
  test.use({ reducedMotion: "reduce" });

  async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  async function noAxeViolations(page: Page) {
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  }

  test("Settings connects a Gmail inbox for a chosen creator and disconnects it", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/settings#email");
    const section = page.locator("#email");
    const diya = section.locator("li").filter({ hasText: "collabs@diyamehra.example" });
    await expect(diya).toContainText("For @diya.moves");
    await expect(diya).toContainText(/Connected · synced/);
    // A Gmail inbox is never listed as an Instagram account.
    await expect(page.locator("#instagram").getByText("collabs@diyamehra.example")).toHaveCount(0);
    await noOverflow(page);
    await noAxeViolations(page);

    // Roster: pick whose inbox it is, then "Google" (the demo returns straight to Settings).
    await section.getByRole("button", { name: "Connect another Gmail inbox" }).click();
    await page.getByRole("menuitem", { name: "@rohan.cooks" }).click();
    await expect(page.getByText("Gmail connected.", { exact: false })).toBeVisible();
    await expect.poll(() => new URL(page.url()).search).toBe("");
    const rohan = section.locator("li").filter({ hasText: "collabs@rohancooks.example" });
    await expect(rohan).toContainText("For @rohan.cooks");

    await rohan.getByRole("button", { name: "More for collabs@rohancooks.example" }).click();
    await page.getByRole("menuitem", { name: "Disconnect" }).click();
    const confirm = page.getByRole("dialog", { name: "Disconnect collabs@rohancooks.example?" });
    await confirm.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(section.getByText("collabs@rohancooks.example")).toHaveCount(0);
    await expect(diya).toBeVisible();
  });

  test("an email thread shows its subject and attachment and replies by email", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/inbox?q=winter");
    const row = page.locator('[data-thread-row="e-lumen"]').first();
    await expect(row).toContainText("Winter glow campaign: brief and ₹1,50,000 budget");
    await expect(row.getByRole("img", { name: "Email" })).toBeVisible();

    await page.goto("/thread/e-lumen");
    // The conversation pane (on desks the inbox list sits beside it).
    const thread = page.locator("#desk-detail");
    await expect(thread.getByRole("heading", { level: 1, name: /Lumen Skincare/ })).toBeVisible();
    await expect(thread.locator("header").getByText("partnerships@lumenskin.example", { exact: true })).toBeVisible();
    await expect(page.getByText("@partnerships@lumenskin.example")).toHaveCount(0);
    await expect(thread.locator("header").getByText("Winter glow campaign: brief and ₹1,50,000 budget", { exact: true })).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /Lumen-winter-brief\.pdf/ }).click();
    expect((await download).suggestedFilename()).toBe("Lumen-winter-brief.pdf");

    // An email reply: no reply window, no voice note, nothing that opens Instagram.
    await expect(page.getByText("Email reply", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Review and edit before sending")).toHaveValue(/^Hi Anika,/);
    await expect(page.getByRole("button", { name: "Approve & send email" })).toBeVisible();
    await expect(page.getByRole("switch", { name: /voice note/i })).toHaveCount(0);
    await page.getByRole("button", { name: "More actions for partnerships@lumenskin.example" }).click();
    await expect(page.getByRole("menuitem", { name: "Sender details" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Open in Instagram" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await noOverflow(page);
    await noAxeViolations(page);
  });

  test("a deal from an email shows the sender's address without an @", async ({ page }) => {
    await page.goto("/thread/e-lumen");
    await page.getByRole("button", { name: "Record a deal", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Record a deal" });
    await expect(sheet).toContainText("What you agreed with partnerships@lumenskin.example");
    await sheet.getByRole("button", { name: "Fill from conversation" }).click();
    await expect(sheet.getByLabel(/^Amount/)).toHaveValue("150000");
    await sheet.getByRole("button", { name: "Save deal" }).click();
    await expect(sheet).toBeHidden();
    await page.goto("/");
    const row = page.locator("#deals").getByRole("link", { name: /partnerships@lumenskin\.example/ });
    await expect(row).toContainText("₹1.5L");
    await expect(page.locator("#deals").getByText("@partnerships@lumenskin.example")).toHaveCount(0);
  });

  test("a message that looks like a scam warns, shows no money and prompts nothing", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/inbox?view=check");
    await expect(page.locator('[data-thread-row="r-scam"]').first().getByText("Possible scam")).toBeVisible();

    await page.goto("/thread/r-scam");
    const warning = page.getByRole("note").filter({ hasText: "Possible scam" });
    await expect(warning).toContainText("They're asking you to pay to take part.");
    await expect(page.getByRole("button", { name: "Record a deal", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Generate draft" })).toHaveCount(0);
    await expect(page.getByText("est.", { exact: true })).toHaveCount(0);
    await noOverflow(page);
    await noAxeViolations(page);

    await page.goto("/review?item=r-scam");
    await expect(page.getByRole("note").filter({ hasText: "Possible scam" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Yes, spam/ })).toBeVisible();
  });

  test("on Roster a creator's own price overrides the workspace's, and empty answers fall back", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/settings#business");
    const section = page.locator("#business");
    const scope = section.getByLabel("Profile for");
    await scope.selectOption({ label: "@rohan.cooks" });
    await expect(section.getByText("Per package · workspace price")).toBeVisible();

    await section.getByRole("button", { name: "Edit what @rohan.cooks sells" }).click();
    const sheet = page.getByRole("dialog", { name: "What @rohan.cooks sells" });
    const coaching = sheet.getByLabel(/^Coaching package/);
    await expect(coaching).toHaveValue("");
    await expect(coaching).toHaveAttribute("placeholder", "24000");
    await coaching.fill("18000");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(section.getByText("₹18,000", { exact: true })).toBeVisible();
    await expect(section.getByText("Per package · workspace price")).toHaveCount(0);
    await expect(section.getByText("Per campaign · workspace price")).toBeVisible();
    await noOverflow(page);
    await noAxeViolations(page);

    await scope.selectOption({ label: "Workspace (all creators)" });
    await expect(section.getByText("₹24,000", { exact: true })).toBeVisible();
  });

  test("an Indian workspace can't switch off the spoken AI disclosure", async ({ page }) => {
    await page.goto("/voice");
    await expect(page.getByRole("heading", { name: "Speaking voice" })).toBeVisible();
    // Demo setup: a ready speaking voice, without recording three takes through the microphone.
    await page.addInitScript(() => {
      const key = "dealdock-demo-v2";
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      const state = JSON.parse(raw);
      if (state.speaking.status === "ready") return;
      const at = new Date().toISOString();
      state.speaking = { ...state.speaking, status: "ready", provider: "demo", consentedAt: at, sampleSeconds: 64, createdAt: at };
      sessionStorage.setItem(key, JSON.stringify(state));
    });
    await page.reload();
    const disclosure = page.locator("#speaking").getByRole("switch", { name: "AI disclosure" });
    await expect(disclosure).toHaveAttribute("aria-checked", "true");
    await expect(disclosure).toBeDisabled();
    await expect(page.getByText("Required in India: each voice note starts by saying it's AI-generated.")).toBeVisible();
    await noOverflow(page);
  });

  test("a recorded deal answers what DealDock guessed about the conversation", async ({ page }) => {
    await page.goto("/thread/t-founders");
    await expect(page.getByRole("article", { name: "Founder fitness session" })).toBeVisible();
    await expect(page.getByText("Looks like another sale")).toHaveCount(0);
    await expect(page.getByText("est.", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Looks like this closed")).toHaveCount(0);
  });
});
