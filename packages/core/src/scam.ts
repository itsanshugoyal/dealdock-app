/**
 * Scam check for incoming messages. Fake "brand deals" are the scam creators
 * meet most: a fee to join, an outside login page, a locked "contract" file,
 * or a move to another chat app. Deterministic, so the worker, the API read
 * models and the demo agree, and a model swap can never silently turn it off.
 *
 * It looks at what the sender asks the creator to do. A brand offering to pay,
 * cover shipping, share a short link or chat on WhatsApp is normal, so those
 * weak signals only count in combination.
 */

export type ScamSignal =
  // Strong: each one warns on its own.
  | "asks_payment"
  | "credential_request"
  | "locked_file"
  | "outside_login"
  // Weak: common in real deals too; two together warn.
  | "chat_app"
  | "short_link"
  | "archive";

export interface ScamCheck {
  signals: ScamSignal[];
  /** Strong enough to warn the creator and skip money estimates. */
  likely: boolean;
  /** One plain sentence for the warning, or null when not likely. */
  reason: string | null;
}

const STRONG = ["asks_payment", "credential_request", "locked_file", "outside_login"] as const;
type StrongSignal = typeof STRONG[number];

// Patterns stay inside one sentence ([^.!?\n]) so unrelated clauses don't combine.
const PATTERNS: Record<ScamSignal, RegExp[]> = {
  asks_payment: [
    /\b(?:registration|joining|onboarding|activation|membership|verification|processing|refundable|security|enrol(?:l?ment)?)\s+(?:fees?|charges?|deposit|amount)\b/gi,
    /\b(?:you\s+(?:need|have|will\s+need)\s+to|kindly|please|just)\s+(?:pay|deposit)\b(?!\s+(?:attention|a\s+visit|heed))/gi,
    /\bpay\s+(?:a|the|small|one[- ]time|refundable|nominal)\s+(?:small\s+)?(?:fee|amount|deposit|charge)\b/gi,
    /\byou\s+(?:only\s+|just\s+)?(?:pay|cover|bear)\s+(?:the\s+|for\s+)?(?:shipping|delivery|courier|customs)\b/gi,
    /\b(?:aapko|tumhe|tumko)\b[^.!?\n]{0,40}\b(?:dena|bharna|pay\s+karna|bhejna|transfer\s+karna)\s+(?:hoga|padega|hai)\b/gi,
  ],
  credential_request: [
    /\b(?:share|send|enter|provide|confirm|bhejo|batao|bata\s+do)\b[^.!?\n]{0,40}\b(?:password|otp|one[- ]time\s+password|login\s+(?:details|credentials)|verification\s+code|2fa\s+code)\b/gi,
    /\b(?:password|otp|verification\s+code)\b[^.!?\n]{0,30}\b(?:share|send|bhejo|batao)\b/gi,
  ],
  locked_file: [
    /\bpassword[- ]protected\b/gi,
    /\b(?:file|archive|document|zip)\s+password\s*(?:is|:)/gi,
  ],
  outside_login: [
    /\b(?:creator|collab(?:oration)?|ambassador|partner|influencer)\s+(?:portal|platform|dashboard)\b[^.!?\n]{0,50}\b(?:sign\s+in|log\s?in|register|verify)\b/gi,
    /\b(?:sign|log)\s+in\s+with\s+(?:your\s+)?(?:google|gmail|instagram|facebook)\b/gi,
  ],
  chat_app: [
    /\b(?:telegram|signal\s+app)\b/gi,
    /\bwa\.me\//gi,
    /\bwhatsapp\b[^.!?\n]{0,40}\b(?:join|contact|message|ping|text|dm|aao|karo)\b/gi,
  ],
  short_link: [/\b(?:bit\.ly|tinyurl\.com|t\.me|forms\.gle|rb\.gy|cutt\.ly|shorturl\.at|is\.gd)\//gi],
  archive: [/\b(?:zip|rar)\s+file\b/gi, /\.(?:zip|rar|exe|scr|apk)\b/gi],
};

const REASONS: Record<StrongSignal, string> = {
  asks_payment: "They're asking you to pay to take part.",
  credential_request: "They're asking for a password or login code.",
  locked_file: "They sent a locked file to open.",
  outside_login: "They want you to sign in on an outside site.",
};
const WEAK_REASON = "They're pushing outside links, files or chat apps.";

// "No registration fee", "free registration", "never share your OTP" are reassurances, not asks.
const NEGATED = /\b(?:no|not|without|zero|free|never|koi\s+nahi)\b[^.!?\n]{0,12}$/i;

function found(pattern: RegExp, body: string): boolean {
  for (const match of body.matchAll(pattern)) {
    if (!NEGATED.test(body.slice(Math.max(0, match.index - 24), match.index))) return true;
  }
  return false;
}

export function checkScam(text: string | null | undefined): ScamCheck {
  const body = (text ?? "").slice(0, 4000);
  const signals = (Object.keys(PATTERNS) as ScamSignal[]).filter((signal) => PATTERNS[signal].some((pattern) => found(pattern, body)));
  const strong = signals.filter((signal): signal is StrongSignal => (STRONG as readonly string[]).includes(signal));
  const weak = signals.length - strong.length;
  const likely = strong.length > 0 || weak >= 2;
  return { signals, likely, reason: strong[0] ? REASONS[strong[0]] : likely ? WEAK_REASON : null };
}
