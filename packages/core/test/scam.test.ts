import { describe, expect, it } from "vitest";
import { checkScam } from "../src/scam";

describe("checkScam", () => {
  it.each([
    ["Congratulations! You're selected as our brand ambassador. Pay the registration fee of ₹999 to confirm your slot.", "asks_payment"],
    ["You need to pay a small refundable deposit before we ship the products.", "asks_payment"],
    ["Collab confirm hai! Aapko bas ₹499 registration ke liye pay karna hoga.", "asks_payment"],
    ["To receive the payment, kindly share the OTP you just received.", "credential_request"],
    ["The agreement is attached as a password-protected file, the file password is 2026.", "locked_file"],
    ["Please sign in with Google on our creator portal to see your brief.", "outside_login"],
  ])("warns on %s", (text, signal) => {
    const check = checkScam(text);
    expect(check.likely).toBe(true);
    expect(check.signals).toContain(signal);
    expect(check.reason).toBeTruthy();
  });

  it("warns when two weak signals combine", () => {
    const check = checkScam("Join our Telegram for paid collabs: t.me/brandcollabs2026");
    expect(check.signals).toEqual(expect.arrayContaining(["chat_app", "short_link"]));
    expect(check.likely).toBe(true);
  });

  it.each([
    "Hi! We'd love to pay you ₹50,000 for 1 reel and 2 stories. Shipping charges will be covered by us.",
    "There's no registration fee, the event is free for creators.",
    "Aapki fees dene ko ready hain, 7 din mein payment kar denge.",
    "Brief is here: bit.ly/glowco-brief. Can we continue on WhatsApp to share the product details?",
    "Sharing a zip file with our logos and brand guidelines.",
    "Please pay attention to the do's and don'ts in the brief.",
    "Never share your OTP with anyone, we will never ask for it.",
    "",
  ])("stays quiet on %s", (text) => {
    expect(checkScam(text)).toMatchObject({ likely: false, reason: null });
  });
});
