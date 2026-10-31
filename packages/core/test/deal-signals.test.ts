import { describe, expect, it } from "vitest";
import { detectDealSignal, extractAmountMinor, findDealSignal, inferDealType } from "../src/deal-signals";

describe("detectDealSignal", () => {
  it.each([
    ["Payment done", "payment done"],
    ["payment done ✅ please check", "payment done"],
    ["Hi! Payment has been made, sharing the screenshot", "payment has been made"],
    ["I have paid", "paid"],
    ["Paid in full 🙏", "paid"],
    ["Already paid the invoice", "paid"],
    ["Just sent the money", "sent the money"],
    ["I've sent you the advance", "sent you the advance"],
    ["sent you ₹25,000", "sent you"],
    ["Transferred 50k just now", "transferred"],
    ["Transferred ✅", "transferred"],
    ["I have transferred the amount", "transferred the amount"],
    ["Amount transferred to your account", "amount transferred"],
    ["transferred to your account, pls check", "transferred to your account"],
    ["UPI done", "upi done"],
    ["Done via GPay", "done via gpay"],
    ["Invoice raised from our side", "invoice raised"],
    ["We have raised the invoice", "raised the invoice"],
    ["PO issued today", "po issued"],
    ["Purchase order has been released", "purchase order has been released"],
    ["Contract signed 👍", "contract signed"],
    ["Let's lock it", "let's lock it"],
    ["lets lock it in for March", "lets lock it in"],
    ["Let's proceed", "let's proceed"],
    ["Please proceed with the reel", "please proceed"],
    ["Confirmed!", "confirmed"],
    ["Confirmed from our side", "confirmed"],
    ["Deal!", "deal"],
    ["ok deal 🤝", "deal"],
    ["it's a deal", "it's a deal"],
    ["Deal done, send the brief", "deal done"],
    ["I bought your course yesterday", "bought your course"],
    ["Enrolled in your cohort!", "enrolled in your cohort"],
    ["No worries, payment done", "payment done"],
  ])("English: %s", (text, phrase) => {
    expect(detectDealSignal(text)).toEqual({ phrase });
  });

  it.each([
    ["Payment kar diya hai", "payment kar diya"],
    ["maine aapko paise bhej diye", "paise bhej diye"],
    ["paisa bhej diya bhai", "paisa bhej diya"],
    ["amount transfer kar diya", "amount transfer kar diya"],
    ["Gpay kar diya", "gpay kar diya"],
    ["payment ho gaya ✅", "payment ho gaya"],
    ["done hai", "done hai"],
    ["Pakka! Monday se start", "pakka"],
    ["deal pakka", "deal pakka"],
    ["chalo proceed karte hain", "proceed karte hain"],
    ["final hai", "final hai"],
  ])("Hinglish: %s", (text, phrase) => {
    expect(detectDealSignal(text)).toEqual({ phrase });
  });

  it.each([
    ["भुगतान हो गया", "भुगतान हो गया"],
    ["मैंने पैसे भेज दिए हैं", "पैसे भेज दिए"],
    ["पेमेंट कर दिया", "पेमेंट कर दिया"],
    ["डील पक्की", "डील पक्की"],
    ["आगे बढ़ते हैं", "आगे बढ़ते"],
  ])("Devanagari: %s", (text, phrase) => {
    expect(detectDealSignal(text)?.phrase).toBe(phrase.normalize("NFC"));
  });

  it.each([
    // Questions.
    "payment done?",
    "Payment done ?",
    "Is it paid",
    "Have you paid?",
    "Did you send the money",
    "kab tak payment hoga",
    "payment ho gaya kya",
    "Payment kar diya kya?",
    "pakka?",
    "pakka bolo",
    "क्या भुगतान हो गया",
    "भुगतान हो गया?",
    "Can we lock it in?",
    // Negation.
    "not paid yet",
    "Payment not done",
    "I haven't paid",
    "payment done nahi hua",
    "pakka nahi",
    "Almost done with the payment",
    "Paid yet",
    // Future / conditional / terms.
    "Once paid, we start",
    "I'll transfer the money tomorrow",
    "Payment will be done next week",
    "payment done within 30 days of posting",
    "100% payment done after the reel goes live",
    "You will get paid 50k",
    "It needs to be confirmed",
    "Let me know once confirmed",
    "agar payment ho gaya toh batana",
    // Not about money at all.
    "We'd love a paid collaboration with you",
    "This is a paid partnership",
    "This is a paid one",
    "We work on a paid basis",
    "Here are the confirmed dates",
    "What's the deal with your rates",
    "Big brand deal for you!",
    "I sent 2 reels yesterday",
    "I transferred it to my manager",
    "Thanks for the reply",
    "",
  ])("no signal: %s", (text) => {
    expect(detectDealSignal(text)).toBeNull();
  });

  it("finds a confirmation in a later sentence after a question", () => {
    expect(detectDealSignal("Did you get the brief? Payment done btw")).toEqual({ phrase: "payment done" });
  });

  it("scopes a question to its own sentence", () => {
    expect(detectDealSignal("Payment done! When do we start?")).toEqual({ phrase: "payment done" });
  });

  it("normalizes curly apostrophes and zero-width characters", () => {
    expect(detectDealSignal("Let’s pro​ceed")).toEqual({ phrase: "let's proceed" });
    expect(detectDealSignal("I haven’t paid")).toBeNull();
  });
});

describe("extractAmountMinor", () => {
  it.each([
    ["₹50,000", "INR", 5_000_000],
    ["Rs. 1,20,000/-", "INR", 12_000_000],
    ["rs50000", "INR", 5_000_000],
    ["INR 75000", "INR", 7_500_000],
    ["50,000/-", "INR", 5_000_000],
    ["50000 rupees", "INR", 5_000_000],
    ["1.2L", "INR", 12_000_000],
    ["1.2 lakh for 2 reels", "INR", 12_000_000],
    ["2 lakhs", "INR", 20_000_000],
    ["2k", "INR", 200_000],
    ["50K", "INR", 5_000_000],
    ["1.5 cr", "INR", 1_500_000_000],
    ["₹ 50,000.50", "INR", 5_000_050],
    ["paid 25k advance, balance 25k after posting", "INR", 2_500_000],
    ["$500", "USD", 50_000],
    ["$1.5k", "USD", 150_000],
    ["2,500 USD", "USD", 250_000],
    ["£300", "GBP", 30_000],
    ["€1.500", "EUR", 150_000],
    ["€1.50", "EUR", 150],
    ["AED 2,500", "AED", 250_000],
    ["1.5m dollars", "USD", 150_000_000],
  ])("%s (%s) → %i", (text, currency, minor) => {
    expect(extractAmountMinor(text, currency)).toBe(minor);
  });

  it.each([
    ["$500", "INR"],
    ["₹50,000", "USD"],
    ["50000", "INR"],
    ["50k followers", "INR"],
    ["I have 2 kids", "INR"],
    ["call me at 98765 43210", "INR"],
    ["meet at 10:30", "INR"],
    ["₹30-50k", "INR"],
    ["50k to 1L", "INR"],
    ["back in 5m", "INR"],
    ["v2.0 is out", "INR"],
    ["", "INR"],
  ])("no amount: %s (%s)", (text, currency) => {
    expect(extractAmountMinor(text, currency)).toBeNull();
  });

  it("returns the first org-currency amount and skips foreign ones", () => {
    expect(extractAmountMinor("$400 or ₹30,000", "INR")).toBe(3_000_000);
  });
});

describe("findDealSignal", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute));
  const conversation = [
    { id: "m1", direction: "inbound", text: "Hi, can you do a reel for our launch?", sentAt: at(0) },
    { id: "m2", direction: "outbound", text: "Sure! My rate is ₹45,000 for one reel.", sentAt: at(1) },
    { id: "m3", direction: "inbound", text: "Works for us.", sentAt: at(2) },
    { id: "m4", direction: "inbound", text: "Payment done ✅", sentAt: at(3) },
  ];
  const base = { messages: conversation, state: "open", label: "brand_deal", currencyCode: "INR", recordedAt: [] };

  it("suggests the confirmation with the nearest amount and the label's deal type", () => {
    expect(findDealSignal(base)).toEqual({
      messageId: "m4",
      phrase: "payment done",
      suggestedAmountMinor: 4_500_000,
      suggestedDealType: "brand",
    });
  });

  it("prefers an amount stated in the confirmation itself", () => {
    const messages = [...conversation.slice(0, 3), { ...conversation[3]!, text: "Transferred 40k, balance after posting" }];
    expect(findDealSignal({ ...base, messages })?.suggestedAmountMinor).toBe(4_000_000);
  });

  it("is null for a closed thread or a sale already recorded after the signal", () => {
    expect(findDealSignal({ ...base, state: "closed" })).toBeNull();
    expect(findDealSignal({ ...base, recordedAt: [at(5)] })).toBeNull();
    expect(findDealSignal({ ...base, recordedAt: [at(0)] })?.messageId).toBe("m4");
  });

  it("ignores the creator's own outbound wording and old history", () => {
    const outbound = [{ id: "o1", direction: "outbound", text: "Payment done on my side", sentAt: at(0) }];
    expect(findDealSignal({ ...base, messages: outbound })).toBeNull();
    const filler = Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, direction: "inbound", text: "ok", sentAt: at(10 + i) }));
    expect(findDealSignal({ ...base, messages: [...conversation, ...filler] })).toBeNull();
  });

  it("leaves the amount and type empty when nothing supports them", () => {
    const messages = [{ id: "x", direction: "inbound", text: "Let's proceed", sentAt: at(0) }];
    expect(findDealSignal({ ...base, messages, label: null })).toEqual({
      messageId: "x",
      phrase: "let's proceed",
      suggestedAmountMinor: null,
      suggestedDealType: null,
    });
  });
});

describe("inferDealType", () => {
  it("maps commerce labels to ledger deal types", () => {
    expect(inferDealType("brand_deal")).toBe("brand");
    expect(inferDealType("coaching_lead")).toBe("coaching");
    expect(inferDealType("course_inquiry")).toBe("course");
    expect(inferDealType("other_commerce")).toBe("other");
  });

  it("returns null for non-commerce labels", () => {
    expect(inferDealType("fan")).toBeNull();
    expect(inferDealType("uncertain")).toBeNull();
    expect(inferDealType(null)).toBeNull();
    expect(inferDealType(undefined)).toBeNull();
  });
});
