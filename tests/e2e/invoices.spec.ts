import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Fictional demo data only: billing details, invoices and payments live in the browser, never against the real API.
test.describe("invoices in the demo", () => {
  test.skip(process.env.E2E_DEMO_PRODUCT !== "true", "Requires an explicitly started local demo app.");
  test.use({ reducedMotion: "reduce" });

  const NUMBER = /DM-\d{4}-\d{2}-\d{3}/;

  async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  async function noAxeViolations(page: Page) {
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  }
  /** The approve control is a button on desks and a slide knob on phones; both take Enter. */
  async function approve(page: Page) {
    const send = page.getByRole("button", { name: "Approve & send" });
    await send.focus();
    await page.keyboard.press("Enter");
  }

  test("billing details: a GSTIN fills its state and PAN, a wrong one is caught, and a creator gets their own", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/settings#billing");
    const section = page.locator("#billing");
    await expect(section.getByText("GST · 27ABJPM4821K1ZE")).toBeVisible();
    await section.getByRole("button", { name: "Edit billing details" }).click();
    const sheet = page.getByRole("dialog", { name: "Billing details" });
    const gstin = sheet.getByLabel("GSTIN", { exact: true });
    await gstin.fill("27ABJPM4821K1ZX");
    await gstin.blur();
    await expect(sheet.getByText("This GSTIN doesn't look right. Check the 15 characters.")).toBeVisible();
    await gstin.fill("29AAKCT5310R1ZN");
    await expect(sheet.getByLabel("State", { exact: true })).toHaveValue("29");
    await expect(sheet.getByLabel("PAN", { exact: true })).toHaveValue("AAKCT5310R");
    await gstin.fill("27ABJPM4821K1ZE");
    await expect(sheet.getByLabel("State", { exact: true })).toHaveValue("27");
    await sheet.getByText("Exports and MSME", { exact: true }).click();
    await expect(sheet.getByText(/For export invoices to brands outside India/)).toBeVisible();
    // Registration decides what shows: no GSTIN or LUT without GST.
    await sheet.getByRole("radio", { name: "Not registered" }).click();
    await expect(sheet.getByLabel("GSTIN", { exact: true })).toHaveCount(0);
    await sheet.getByRole("radio", { name: "GST registered" }).click();
    await sheet.getByLabel("Prefix", { exact: true }).fill("DMX");
    await expect(sheet.getByText(/Your next invoice: DMX-\d{4}-\d{2}-\d{3}/)).toBeVisible();
    await sheet.getByLabel(/^UPI ID/).fill("diya@okicici");
    await noAxeViolations(page);
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(section.getByText(/UPI diya@okicici/)).toBeVisible();
    await expect(section.getByText(/^DMX-\d{4}-\d{2}-\d{3}$/)).toBeVisible();

    // Roster: a creator uses the workspace's details until they have their own.
    await section.getByLabel("Details for").selectOption({ label: "@rohan.cooks" });
    await expect(section.getByText("Uses workspace details.")).toBeVisible();
    await section.getByRole("button", { name: "Add their own" }).click();
    const own = page.getByRole("dialog", { name: "Billing details for @rohan.cooks" });
    await expect(own.getByLabel("Prefix", { exact: true })).toHaveValue("ROH");
    await expect(own.getByLabel("Legal name", { exact: true })).toHaveValue("");
    await own.getByLabel("Legal name", { exact: true }).fill("Rohan Kapoor");
    await own.getByRole("button", { name: "Save", exact: true }).click();
    await expect(own).toBeHidden();
    await expect(section.getByText("Uses workspace details.")).toHaveCount(0);
    await expect(section.getByText("Rohan Kapoor", { exact: true })).toBeVisible();
    await expect(section.getByText(/^ROH-\d{4}-\d{2}-001$/)).toBeVisible();
    await noOverflow(page);
  });

  test("an advance invoice shows its GST, goes out with a note and its PDF, is paid into Revenue, then the balance follows", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/thread/t-founders");
    const card = page.getByRole("article", { name: "Founder fitness session" });
    await card.getByRole("button", { name: "More for Founder fitness session" }).click();
    await page.getByRole("menuitem", { name: "Create invoice" }).click();
    const sheet = page.getByRole("dialog", { name: "Create invoice" });
    await expect(sheet.getByRole("radio", { name: "Advance 50%" })).toHaveAttribute("aria-checked", "true");
    await sheet.getByLabel("Brand's legal name").fill("Founders Circle Community LLP");
    const total = sheet.getByRole("region", { name: "Invoice total" });
    // Same state as the creator: CGST and SGST on the ₹25,000 advance.
    await expect(total).toContainText("CGST 9%");
    await expect(total).toContainText("SGST 9%");
    await expect(total).toContainText("₹29,500");
    await expect(total).toContainText("Rupees Twenty Nine Thousand Five Hundred Only");
    await sheet.getByLabel("State", { exact: true }).selectOption({ label: "Karnataka" });
    await expect(total).toContainText("IGST 18%");
    await sheet.getByLabel("State", { exact: true }).selectOption({ label: "Maharashtra" });
    await expect(total).toContainText("CGST 9%");
    await noOverflow(page);
    await noAxeViolations(page);
    await sheet.getByRole("button", { name: "Create invoice" }).click();
    await expect(sheet).toBeHidden();

    const advance = card.getByRole("button", { name: /^Preview invoice DM-/ });
    await expect(advance).toContainText("₹29,500");
    await expect(advance).toContainText("Issued");
    const number = NUMBER.exec((await advance.textContent()) ?? "")![0];
    // One next step: send it with a note. The note lands in the composer with its PDF attached; nothing sends yet.
    await expect(card.getByRole("button", { name: "Mark invoice paid" })).toHaveCount(0);
    await card.getByRole("button", { name: "Send with a note" }).click();
    await expect(page.getByText("Invoice note", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Review and edit before sending")).toHaveValue(new RegExp(`${number} for ₹29,500`));
    await expect(page.getByRole("button", { name: new RegExp(`^${number}\\.pdf`) })).toBeVisible();
    await noOverflow(page);
    await noAxeViolations(page);
    await approve(page);
    await expect(page.getByText("Reply sent to @thefounderscircle.in")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`${number}.pdf went with it.`)).toBeVisible();

    // Sent: the next step is the payment.
    await card.getByRole("button", { name: "Mark invoice paid" }).click();
    const paid = page.getByRole("dialog", { name: "Mark invoice paid" });
    const received = paid.getByLabel("Received (₹)");
    await expect(received).toHaveValue("29500");
    await paid.getByText("Received less than this?").click();
    await paid.getByLabel(/^Tax withheld \(TDS\)/).fill("2500");
    await expect(received).toHaveValue("27000");
    // GST collected for the government isn't revenue: ₹27,000 + ₹2,500 TDS − ₹4,500 GST.
    await expect(paid.getByText(/Adds ₹25,000 to your revenue\./)).toBeVisible();
    await paid.getByRole("button", { name: "Mark invoice paid" }).click();
    await expect(paid).toBeHidden();
    await expect(advance).toContainText("Paid");

    // The advance is paid: the card moves on to the balance, billed to the same brand.
    await card.getByRole("button", { name: "Invoice the balance" }).click();
    const balance = page.getByRole("dialog", { name: "Invoice the balance" });
    await expect(balance.getByLabel("Brand's legal name")).toHaveValue("Founders Circle Community LLP");
    await expect(balance.getByRole("region", { name: "Invoice total" })).toContainText("₹29,500");
    await balance.getByRole("button", { name: "Create invoice" }).click();
    await expect(balance).toBeHidden();
    await expect(card.getByRole("button", { name: /^Preview invoice DM-/ })).toHaveCount(2);
    await expect(card.getByRole("button", { name: "Send with a note" })).toBeVisible();

    await page.goto("/ledger");
    const sale = page.locator("#sales li").filter({ hasText: number });
    await expect(sale).toContainText("₹25,000");
    await expect(sale.getByRole("link", { name: "@thefounderscircle.in" })).toBeVisible();
    const owed = page.locator("#owed li").filter({ hasText: "Founder fitness session" });
    await expect(owed).toContainText("₹25,000 paid");
    await expect(owed.getByRole("button", { name: "Mark invoice paid: Founder fitness session" })).toBeVisible();
    await noOverflow(page);
    await noAxeViolations(page);
  });

  test("a deal agreed outside DealDock is added from Revenue and invoiced without a conversation", async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto("/ledger");
    await page.getByRole("button", { name: "Add a deal" }).click();
    const sheet = page.getByRole("dialog", { name: "Add a deal" });
    await sheet.getByLabel("Who it's with").fill("Zenith Sports");
    await sheet.getByLabel("Creator", { exact: true }).selectOption({ label: "@diya.moves" });
    await sheet.getByLabel("What", { exact: true }).fill("Launch reel");
    await sheet.getByLabel("Amount (₹)").fill("40000");
    await noAxeViolations(page);
    await sheet.getByRole("button", { name: "Save deal" }).click();
    await expect(sheet).toBeHidden();

    const row = page.locator("#owed li").filter({ hasText: "Zenith Sports" });
    await expect(row).toContainText("₹40,000");
    // No conversation to link to: the name opens the deal instead.
    await expect(row.getByRole("link")).toHaveCount(0);
    await row.getByRole("button", { name: /^Zenith Sports/ }).click();
    const detail = page.getByRole("dialog", { name: "Zenith Sports" });
    const card = detail.getByRole("article", { name: "Launch reel" });
    await expect(card.getByRole("button", { name: "Create invoice" })).toBeVisible();
    await card.getByRole("button", { name: "More for Launch reel" }).click();
    await expect(page.getByRole("menuitem", { name: "Send terms recap" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Mark paid" })).toBeVisible();
    await page.keyboard.press("Escape");
    await card.getByRole("button", { name: "Create invoice" }).click();
    const create = page.getByRole("dialog", { name: "Create invoice" });
    await create.getByLabel("Brand's legal name").fill("Zenith Sports Pvt Ltd");
    await create.getByRole("button", { name: "Create invoice" }).click();
    await expect(create).toBeHidden();
    await expect(detail).toBeVisible();
    // Instead of a note in a conversation, its PDF is the creator's to share.
    await expect(card.getByRole("button", { name: "Send with a note" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Mark invoice paid" })).toBeVisible();
    const download = page.waitForEvent("download");
    await card.getByRole("button", { name: "Download PDF" }).click();
    expect((await download).suggestedFilename()).toMatch(/^DM-\d{4}-\d{2}-\d{3}\.pdf$/);
    await noOverflow(page);
    await noAxeViolations(page);
    await detail.getByRole("button", { name: "Close", exact: true }).click();
    await expect(detail).toBeHidden();

    // Today lists it with the other deals in progress and opens the same sheet.
    await page.goto("/");
    await page.locator("#deals").getByRole("button", { name: /Zenith Sports/ }).click();
    await expect(page.getByRole("dialog", { name: "Zenith Sports" }).getByRole("article", { name: "Launch reel" })).toBeVisible();
    await noOverflow(page);
  });

  test("seeded invoices preview like their PDF, and voiding asks first", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/ledger");
    const owed = page.locator("#owed");
    await expect(owed.locator("li").filter({ hasText: "Winter blend reel + 2 stories" })).toContainText("Overdue 6 days");
    await owed.getByRole("button", { name: /^Pune Run Expo/ }).click();
    const detail = page.getByRole("dialog", { name: "Pune Run Expo" });
    const card = detail.getByRole("article", { name: "Expo stage session + 2 reels" });
    const invoices = card.getByRole("list", { name: "Invoices" }).getByRole("button");
    await expect(invoices).toHaveCount(2);
    await expect(invoices.first()).toContainText("Paid");
    await expect(invoices.nth(1)).toContainText("Issued");
    await invoices.nth(1).click();
    const preview = page.getByRole("dialog", { name: /^Invoice DM-/ });
    const document = preview.getByRole("article");
    for (const text of ["Tax invoice", "Diya Mehra", "GSTIN: 27ABJPM4821K1ZE", "Pune Run Expo Pvt Ltd", "Balance: Expo stage session + 2 reels", "CGST 9%", "SGST 9%", "₹66,080.00", "Rupees Sixty Six Thousand Eighty Only", "UPI: diyamehra@okhdfcbank", "Computer-generated invoice; no signature required."]) {
      await expect(document).toContainText(text);
    }
    await noOverflow(page);
    await noAxeViolations(page);
    await preview.getByRole("button", { name: "Void invoice" }).click();
    const confirm = page.getByRole("dialog", { name: "Void this invoice?" });
    await expect(confirm.getByRole("button", { name: "Keep it" })).toBeFocused();
    await confirm.getByRole("button", { name: "Keep it" }).click();
    await expect(confirm).toBeHidden();
    await expect(invoices.nth(1)).toContainText("Issued");
  });

  test("without billing details, the invoice step leads to Settings and comes back ready", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/thread/t-founders");
    await expect(page.getByRole("article", { name: "Founder fitness session" })).toBeVisible();
    await page.evaluate(() => {
      const key = "dealdock-demo-v2";
      const state = JSON.parse(sessionStorage.getItem(key)!);
      state.billingProfiles = [];
      sessionStorage.setItem(key, JSON.stringify(state));
    });
    await page.reload();
    const card = page.getByRole("article", { name: "Founder fitness session" });
    await card.getByRole("button", { name: "More for Founder fitness session" }).click();
    await page.getByRole("menuitem", { name: "Add billing details" }).click();
    await expect(page).toHaveURL(/\/settings#billing$/);
    const section = page.locator("#billing");
    await expect(section.getByText("Add your billing details to make invoices.")).toBeVisible();
    await section.getByRole("button", { name: "Add billing details" }).click();
    const sheet = page.getByRole("dialog", { name: "Billing details" });
    await sheet.getByLabel("Legal name", { exact: true }).fill("Diya Mehra");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(section.getByText("Not registered")).toBeVisible();
    await page.goto("/thread/t-founders");
    await card.getByRole("button", { name: "More for Founder fitness session" }).click();
    await page.getByRole("menuitem", { name: "Create invoice" }).click();
    // Not registered for GST: the invoice bills the advance with no tax lines.
    const total = page.getByRole("dialog", { name: "Create invoice" }).getByRole("region", { name: "Invoice total" });
    await expect(total).toContainText("₹25,000");
    await expect(total).not.toContainText("GST 9%");
  });
});
