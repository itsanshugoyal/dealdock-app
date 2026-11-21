import {
  addOnPrice,
  ClassificationResult,
  CURRENCY_CODES,
  formatMoneyExact,
  HIGH_INTENT_LABELS,
  OFFER_ADD_ONS,
  type ClassificationLabel,
  type CurrencyCode,
  type DealSuggestion,
  type MessageLanguage,
} from "@dealdock/core";
import type { AiPipeline, ClassifyInput, DealSuggestionInput, DraftInput, DraftResult } from "./types";
import { suggestDealHeuristically } from "./deal-suggestion";
import {
  buildDraftPrompt,
  mergedStyleCard,
  mergeMissingFacts,
  messageText,
  missingOfferFacts,
  offerDealTypeFor,
  offerPrice,
  PROMPT_VERSION,
  usualHindiShare,
  type DealFacts,
} from "./prompts";
import { lintDraft, quotedValue, ruleFamily } from "./style-learning";
import { emojiCount, greetingOf, wordCount } from "./style-text";

export const HEURISTIC_MODEL_VERSION = "heuristic-fallback-1";

/**
 * Deterministic keyword pipeline used only when development fallback is allowed
 * (local dev, CI, demos) and in unit tests. Honest about what it is:
 * every row it writes is stamped `heuristic-fallback-1` so no heuristic
 * output ever pollutes real accuracy metrics.
 */
export class HeuristicPipeline implements AiPipeline {
  async classify(input: ClassifyInput): Promise<ClassificationResult> {
    if (input.isIgnoredHandle) throw new Error("classification is blocked for an ignored handle");
    const email = input.channel === "email";
    // An email's subject often carries the signal ("Paid collab: 1 reel, budget ₹50k").
    const message = email && input.subject?.trim() ? `${input.subject.trim()}\n${input.messageText}` : input.messageText;
    const { label, confidence, rationale } = matchLabel(message.toLowerCase(), email ? input.senderHandle : `@${input.senderHandle}`);
    const language = detectLanguage(message);

    const isCommerce = (HIGH_INTENT_LABELS as readonly string[]).includes(label);
    const range = isCommerce ? valueRangeFor(label, input) : null;

    return ClassificationResult.parse({
      label,
      confidence,
      language,
      valueRange: range,
      rationale,
      modelVersion: HEURISTIC_MODEL_VERSION,
      promptVersion: PROMPT_VERSION,
    });
  }

  /**
   * Deterministic mirror of the v2 prompt so demo/local mode exercises the
   * learning loop: the same targets and "Why this draft" context, the
   * creator's rules first (greeting, sign-off, emoji, language, casing,
   * avoid-phrases, length), then Voice Studio edits, the closest exemplar's
   * opener and the card; chips steer it; no stock AI phrasing.
   */
  async draft(input: DraftInput): Promise<DraftResult> {
    if (input.isIgnoredHandle) throw new Error("drafting is blocked for an ignored handle");
    if (input.voiceConsent === false) {
      throw new Error("drafting is blocked because voice-model consent is disabled");
    }
    const prompt = buildDraftPrompt(input);
    const chips = new Set(input.chips ?? []);
    const creator = input.creator;
    const rules = (creator.voiceRules ?? []).filter((r) => r.scope === prompt.scope || r.scope === "all");
    const has = (key: string) => rules.some((r) => r.key === key);
    const ruleFor = (family: string) =>
      rules.filter((r) => ruleFamily(r.key) === family).sort((a, b) => (a.scope === "all" ? 1 : 0) - (b.scope === "all" ? 1 : 0))[0];
    const card = mergedStyleCard(creator);
    const measured = creator.measured?.find((m) => m.scope === prompt.scope) ?? creator.measured?.find((m) => m.scope === "all");

    const hinglish =
      chips.has("more_hinglish") ||
      (!chips.has("more_english") &&
        !has("language:english") &&
        (has("language:hinglish") || (prompt.language !== "en" && (usualHindiShare(creator, prompt.scope) >= 0.15 || !measured))));

    const greetingRule = ruleFor("greeting");
    const exemplar = input.exemplars?.[input.exemplars.length - 1];
    let greeting: string;
    if (chips.has("more_formal")) greeting = "Hello,";
    else if (greetingRule) greeting = greetingRule.key === "greeting:none" ? "" : (quotedValue(greetingRule.text) ?? "");
    else greeting = creator.styleOverrides?.greeting || (exemplar ? greetingOf(exemplar.text) : "") || card.greeting || measured?.topOpeners[0] || "Hey!";

    const signoffRule = ruleFor("signoff");
    const signoff = signoffRule
      ? signoffRule.key === "signoff:none"
        ? ""
        : (quotedValue(signoffRule.text) ?? "")
      : creator.styleOverrides?.signoff ?? card.signoff ?? measured?.topSignoffs[0] ?? "";

    const structure = prompt.scope === "nudge" ? "nudge" : (TEMPLATES.en[prompt.scope] ? prompt.scope : "neutral");
    const deal = prompt.deal;
    // A comment lead's private reply answers from the offers alone; the comment's words never reach the reply.
    const commentReply = !deal && input.comment ? commentAnswer(input.comment.keyword, creator) : null;
    // The prompt's own flags (add-on prices, an exclusivity, a usage price) come first, as every pipeline reports them.
    const missingFacts = mergeMissingFacts(prompt.context.missingFacts, deal ? [] : commentReply ? commentReply.missing : missingOfferFacts(prompt.scope, creator.offers ?? [], chips.has("quote_rate")));
    // A brand asking about add-ons gets the prices the creator set, exactly; the rest stay flagged.
    const addOns = prompt.scope === "brand_deal" ? addOnQuotes(latestInboundText(input), creator) : [];
    const compose = (useHinglish: boolean, shorter: boolean) => {
      const language = useHinglish ? "hi" : "en";
      let body: string;
      // Purpose drafts skip reply steering and trimming: every term of the deal has to survive.
      if (deal) body = deal.invoice ? invoiceBody(deal, deal.invoice, language) : deal.renewal ? renewalBody(deal, deal.renewal, language) : deal.usageRights ? usageRightsBody(deal.usageRights, language) : deal.purpose === "recap" ? recapBody(deal, language) : reminderBody(deal, language);
      else if (commentReply) body = commentReply[language];
      else {
        body = chips.has("decline_politely") ? DECLINE[language] : TEMPLATES[language][structure]!;
        if (chips.has("warmer")) body = `${useHinglish ? "Aww, love this!" : "Love this!"} ${body}`;
        if (chips.has("quote_rate")) {
          const dealType = offerDealTypeFor(prompt.scope);
          const offer = (creator.offers ?? []).find((o) => o.dealType === dealType && offerPrice(o, money(creator)));
          body += offer ? ` My rate for ${offer.name} is ${offerPrice(offer, money(creator))}.` : ` ${BUDGET[language]}`;
        } else if (chips.has("ask_budget") && !/budget/i.test(body)) {
          body += ` ${BUDGET[language]}`;
        }
        if (chips.has("longer")) body += ` ${CALL[language]}`;
        const limit = shorter || chips.has("shorter") ? Math.min(prompt.targetWords, Math.round(wordCount(body) * 0.6)) : prompt.targetWords;
        body = fitWords(body, limit);
        if (addOns.length) body += ` ${addOns.join(" ")}`;
      }
      // An email adds an emoji only when asked; a DM also follows the creator's emoji habit.
      let text = prompt.email
        ? emailText(greeting, chips.has("add_emoji") && emojiCount(body) === 0 ? `${body} 🙌` : body, signoff, prompt.email)
        : `${greeting ? `${greeting} ` : ""}${body}${signoff ? `\n${signoff}` : ""}`;
      for (const phrase of prompt.lint.avoidPhrases) text = removePhrase(text, phrase);
      if (chips.has("no_emoji") || chips.has("more_formal") || (has("emoji:none") && !chips.has("add_emoji"))) {
        text = text.replace(/\p{Extended_Pictographic}️?/gu, "").replace(/[ \t]{2,}/g, " ").trim();
      } else if (!prompt.email && (chips.has("add_emoji") || has("emoji:light") || has("emoji:heavy")) && emojiCount(text) === 0) {
        text = signoff ? text.replace(/\n(?=[^\n]*$)/, " 🙌\n") : `${text} 🙌`;
      }
      if (chips.has("more_casual") || has("casing:lowercase")) text = text.charAt(0).toLowerCase() + text.slice(1);
      return text.trim();
    };

    const body = compose(hinglish, false);
    const alternatives =
      prompt.variants > 1 ? [...new Set([body, compose(hinglish, true), compose(!hinglish, false)])].slice(0, prompt.variants) : [];
    return {
      body,
      alternatives,
      context: { ...prompt.context, missingFacts },
      lintViolations: lintDraft(body, prompt.lint),
      modelVersion: HEURISTIC_MODEL_VERSION,
      promptVersion: PROMPT_VERSION,
    };
  }

  async suggestDeal(input: DealSuggestionInput): Promise<DealSuggestion> {
    return suggestDealHeuristically(input, HEURISTIC_MODEL_VERSION);
  }
}

const TEMPLATES: Record<"en" | "hi", Record<string, string>> = {
  en: {
    brand_deal: "This sounds interesting. Could you share the brief with deliverables, timeline and budget range? I'll take a look and get back to you quickly.",
    coaching_lead: "Love that you're serious about this. My program is built exactly for where you are. Happy to share how it works and what it costs. Want me to send the details?",
    course_inquiry: "Yes! Enrollment details coming right up. Tell me which batch works for you and I'll share the payment options.",
    other_commerce: "Sounds like a great fit. Could you share the date, audience size and session length? I'll send over my terms.",
    fan: "Thank you so much, this genuinely made my day!",
    personal: "Got it! Let's catch up soon.",
    nudge: "Just circling back on this. Still keen to make it work if you are. Any update on your side?",
    neutral: "Thanks for the message! What did you have in mind?",
  },
  hi: {
    brand_deal: "Sounds interesting! Brief share kar do, deliverables, timeline aur budget range ke saath. Dekh ke jaldi reply karte hain.",
    coaching_lead: "Love that you're serious about this! Mera program bilkul aapke level ke liye bana hai. Details aur price bhej doon?",
    course_inquiry: "Haan ji! Enrollment details abhi bhejte hain. Kaunsa batch suit karega, batao, phir payment options share karte hain.",
    other_commerce: "Sounds like a great fit! Date, audience size aur session length share kar do, phir terms bhejte hain.",
    fan: "Thank you so much, dil khush ho gaya!",
    personal: "Haan haan, done! Jaldi milte hain.",
    nudge: "Bas check kar rahe the, is pe koi update? Still keen to make it work!",
    neutral: "Thanks for the message! Aap kya plan kar rahe ho, batao?",
  },
};
const DECLINE = {
  en: "Thank you for thinking of me! I'll have to pass on this one for now, but I'd love to stay in touch for future work.",
  hi: "Thank you for thinking of me! Abhi ke liye pass karna padega, but future mein zaroor connect karte hain.",
};
const BUDGET = { en: "What budget do you have in mind?", hi: "Budget kya socha hai?" };
const CALL = { en: "Happy to hop on a quick call if that's easier.", hi: "Chaho toh ek quick call bhi kar sakte hain." };

/**
 * The same voice laid out as an email: "Hi Priya," (their usual hello word),
 * short paragraphs of two sentences, then a sign-off with the creator's name
 * when it is known, else their own sign-off. Never a subject line.
 */
function emailText(greeting: string, body: string, signoff: string, names: { theirName: string | null; creatorName: string | null }): string {
  const hello = /^(?:hi+|hey+|hello+|hiya|heya)(?![\p{L}])/iu.exec(greeting)?.[0] ?? "Hi";
  const sentences = body.split(/(?<=[.!?])\s+(?=\S)/);
  const paragraphs: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) paragraphs.push(sentences.slice(i, i + 2).join(" "));
  const closing = names.creatorName && !signoff.includes(names.creatorName) ? `Thanks,\n${names.creatorName}` : signoff || "Thanks!";
  return [`${hello}${names.theirName ? ` ${names.theirName}` : ""},`, ...paragraphs, closing].join("\n\n");
}

/** Every term the deal has and none it doesn't, then a request to confirm. */
function recapBody(f: DealFacts, language: "en" | "hi"): string {
  const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  const terms = [
    f.usage && `Usage: ${f.usage}.`,
    f.exclusivity && `Exclusivity: ${f.exclusivity}.`,
    f.revisions && sentence(`${f.revisions} included`),
    f.payment && sentence(f.payment),
    f.dueDate && `Payment due by ${f.dueDate}.`,
  ];
  const what = f.deliverables ?? f.title;
  const parts =
    language === "hi"
      ? [`Ek quick recap, taaki sab clear rahe: ${what}, ${f.amount} mein.`, ...terms, "Sab sahi hai toh confirm kar do?"]
      : [`Quick recap so we're on the same page: ${what}, for ${f.amount}.`, ...terms, "Can you confirm this works for you?"];
  return parts.filter(Boolean).join(" ");
}

/** The invoice number, amount and due date; the PDF carries the bank and tax details, so the note never states them. */
function invoiceBody(f: DealFacts, invoice: NonNullable<DealFacts["invoice"]>, language: "en" | "hi"): string {
  const which = invoice.kind === "advance" ? "the advance invoice" : invoice.kind === "balance" ? "the balance invoice" : "the invoice";
  const due = f.dueDate;
  return language === "hi"
    ? `${f.title} ke liye ${which.replace("the ", "")} ${invoice.number} bhej rahe hain: ${f.amount}${due ? `, ${due} tak` : ""}. PDF attached hai, payment details usi mein hain. Process ho jaye toh bata dena!`
    : `Sharing ${which} for ${f.title}: ${invoice.number} for ${f.amount}${due ? `, due by ${due}` : ""}. The PDF is attached with the payment details. Let me know once it's processed!`;
}

/** A warm check-in naming the past work; a rate only from the creator's brand offers, exactly; never the old fee. */
function renewalBody(f: DealFacts, renewal: NonNullable<DealFacts["renewal"]>, language: "en" | "hi"): string {
  const rate = renewal.rates[0];
  if (language === "hi") {
    return [
      `${f.title} pe aapke saath kaam karke bahut maza aaya!`,
      renewal.festive ? "Festive campaigns abhi plan ho rahe honge, toh" : "Toh",
      "socha phir se kuch saath karte hain. Kuch aa raha hai aapki side se?",
      rate ? `Meri current rate ${rate.name} ke liye ${rate.price} hai.` : "",
    ].filter(Boolean).join(" ");
  }
  return [
    `Loved working with you on ${f.title}!`,
    renewal.festive ? "With festive campaigns being planned now, I'd love to team up again." : "I'd love to team up again.",
    "Anything coming up that we could work on together?",
    rate ? `My current rate for ${rate.name} is ${rate.price}.` : "",
  ].filter(Boolean).join(" ");
}

/** Warm at first, firmer as it gets later; the final tone pauses work but never threatens. */
function reminderBody(f: DealFacts, language: "en" | "hi"): string {
  const due = f.dueDate;
  if (language === "hi") {
    if (f.tone === "gentle") return `Hope sab badhiya hai! Bas ek quick reminder, ${f.title} ka payment ${f.amount}${due ? ` (due ${due})` : ""}. Kab tak process ho jayega, bata do?`;
    if (f.tone === "firm") return `${f.title} ke payment ka follow up: ${f.amount}${due ? `, jo ${due} ko due tha` : ""}. Is week process kar do please, aur ho jaye toh confirmation bhej dena.`;
    return `Ek baar phir check kar rahe the: ${f.title} ka ${f.amount}${due ? `, jo ${due} ko due tha,` : ""} abhi bhi pending hai. Payment aane tak aage ka kaam pause rakhna padega. Process hote hi bata dena.`;
  }
  if (f.tone === "gentle") return `Hope all's well! A quick reminder about the payment of ${f.amount} for ${f.title}${due ? `, due on ${due}` : ""}. Could you let me know when it'll be processed?`;
  if (f.tone === "firm") return `Following up on the payment of ${f.amount} for ${f.title}${due ? `, which was due on ${due}` : ""}. Could you please process it this week and share the confirmation once it's done?`;
  return `Checking in again on the ${f.amount} for ${f.title}, which ${due ? `was due on ${due} and ` : ""}is still pending. I'll have to pause any further work until the payment comes through. Please let me know as soon as it's processed.`;
}

/** Usage rights end: the date, then an extension at the creator's usage price per month (or a question, never a price), else a request to stop. No threats. */
function usageRightsBody(rights: NonNullable<DealFacts["usageRights"]>, language: "en" | "hi"): string {
  const ends = rights.endsOn ?? (language === "hi" ? "jaldi" : "soon");
  if (language === "hi") {
    return [
      `Ek quick heads-up: ${rights.content} ke usage rights ${rights.endsOn ? `${ends} ko` : ends} end ho rahe hain.`,
      rights.perMonth ? `Aage bhi run karna ho toh ${rights.perMonth} per month mein extend kar sakte hain.` : "Aage bhi run karna ho toh batao kitne time ke liye, price confirm karke batate hain.",
      "Warna us date ke baad content use na karein please. Bata dena!",
    ].join(" ");
  }
  return [
    `A quick heads-up: the usage rights for ${rights.content} end ${rights.endsOn ? `on ${ends}` : ends}.`,
    rights.perMonth ? `If you'd like to keep running it, I can extend them at ${rights.perMonth} per month.` : "If you'd like to keep running it, how long would you like to extend for? I'll confirm the price.",
    "Otherwise, please stop using the content after that date. Let me know which works!",
  ].join(" ");
}

/** The newest message from them, as drafting reads it. */
function latestInboundText(input: DraftInput): string {
  const latest = [...input.threadHistory].reverse().find((message) => message.direction === "inbound");
  return latest ? messageText(latest) : "";
}

/** "Usage rights are ₹15,000 per month.": one line per add-on they asked about that the creator priced; unpriced ones are only flagged. */
function addOnQuotes(text: string, creator: DraftInput["creator"]): string[] {
  const ctx = money(creator);
  if (!ctx) return [];
  return OFFER_ADD_ONS.flatMap(({ key, label, unit, asked }) => {
    const price = asked.test(text) ? addOnPrice(creator.offers ?? [], key) : null;
    return price === null ? [] : [`${label} ${/s$/.test(label) ? "are" : "is"} ${formatMoneyExact(price, ctx)}${unit ? ` ${unit}` : ""}.`];
  });
}

function money(creator: DraftInput["creator"]) {
  const currency = creator.currencyCode as CurrencyCode;
  return (CURRENCY_CODES as readonly string[]).includes(currency) ? { currency, locale: creator.locale } : null;
}

/**
 * A comment lead's private reply from the offers only: the offer its keyword
 * names (else the first with a price or link), that price and link exactly,
 * then a question so they reply. A fact no offer gives is flagged, never made up.
 */
function commentAnswer(keyword: string, creator: DraftInput["creator"]): { en: string; hi: string; missing: string[] } {
  const offers = creator.offers ?? [];
  const word = keyword.toLowerCase();
  const offer = offers.find((o) => o.name.toLowerCase().includes(word) || o.dealType === word) ?? offers.find((o) => o.link || offerPrice(o, money(creator)));
  if (!offer) {
    return {
      en: "Thanks for asking! I'll share the details with you here. What would you like to know first?",
      hi: "Thanks for asking! Details yahin share karte hain. Pehle kya jaanna hai, batao?",
      missing: ["what you sell, with its price and link"],
    };
  }
  const price = offerPrice(offer, money(creator));
  const { name, link } = offer;
  const en = [`Thanks for asking! ${price ? `${name} is ${price}.` : `Happy to tell you about ${name}.`}`, link ? `Here's the link: ${link}` : null, "Anything you'd like to know before you decide?"];
  const hi = [`Thanks for asking! ${price ? `${name} ka price ${price} hai.` : `${name} ke baare mein batate hain.`}`, link ? `Link yeh raha: ${link}` : null, "Kuch aur jaanna ho toh batao?"];
  return { en: en.filter(Boolean).join(" "), hi: hi.filter(Boolean).join(" "), missing: price ? [] : [`your price for ${name}`] };
}

/** Keep whole sentences while they fit the word budget (always at least the first). */
function fitWords(text: string, limit: number): string {
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [text];
  let out = "";
  for (const sentence of sentences) {
    if (out && wordCount(out + sentence) > limit) break;
    out += sentence;
  }
  return out.trim();
}

function removePhrase(text: string, phrase: string): string {
  if (phrase.trim() === "—") return text.replace(/\s*—\s*/g, ", ");
  const parts = phrase.split(/\s+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (parts.length === 0) return text;
  return text
    .replace(new RegExp(`(^|[^\\p{L}])${parts.join("[\\s'’,.!?-]+")}(?![\\p{L}])[\\s,.!?]*`, "giu"), "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function matchLabel(
  text: string,
  sender: string
): { label: ClassificationLabel; confidence: number; rationale: string } {
  if (/(guaranteed|10x (your )?follow|buy .*follow|registration to claim|paid promotion packages|free audit)/.test(text)) {
    return { label: "spam", confidence: 0.95, rationale: "Follower-scheme language — classic spam pattern." };
  }
  if (/(collab|campaign|partnership|sponsor|ambassad|brand|deliverable|paid collaboration|media kit|commercials|retainer)/.test(text)) {
    return { label: "brand_deal", confidence: 0.88, rationale: "Mentions paid collaboration/campaign terms." };
  }
  if (/(coaching|1-on-1|one.on.one|mentorship|transformation program|personal coach|12.week|program ke)/.test(text)) {
    return { label: "coaching_lead", confidence: 0.86, rationale: "Asks about coaching/program with buying intent." };
  }
  if (/(course|cohort|enroll|curriculum|batch|waitlist|emi)/.test(text)) {
    return { label: "course_inquiry", confidence: 0.85, rationale: "Asks about course enrollment/pricing." };
  }
  if (/(workshop|consult|speaker|speaking|summit|license|licensing|session for our)/.test(text)) {
    return { label: "other_commerce", confidence: 0.82, rationale: "Paid workshop/consulting/speaking request." };
  }
  if (/(ghar|mummy|birthday|call kar|bhaiya .*aa rahe)/.test(text)) {
    return { label: "personal", confidence: 0.75, rationale: "Personal/family context, no commercial intent." };
  }
  if (/(love your|legend|inspire|respect|goosebumps|🔥|❤️|aapki wajah se|best .* creator)/.test(text)) {
    return { label: "fan", confidence: 0.84, rationale: "Appreciation message, no commercial intent." };
  }
  return {
    label: "uncertain",
    confidence: 0.4,
    rationale: `No clear commercial or fan signal from ${sender} — needs your judgement.`,
  };
}

function detectLanguage(text: string): MessageLanguage {
  const hinglish =
    /\b(bhai|bhaiya|didi|yaar|hai|hain|kya|kab|nahi|karo|ke|ka|ki|mein|aap|aapki|mujhe|maine|bata|dijiye|abhi|wala|saath|hoon)\b/i.test(
      text
    );
  const devanagari = /[ऀ-ॿ]/.test(text);
  if (devanagari && hinglish) return "mixed";
  if (devanagari) return "hi";
  if (hinglish) return "hinglish";
  return "en";
}

function valueRangeFor(label: ClassificationLabel, input: ClassifyInput) {
  const c = input.creator;
  const base =
    label === "brand_deal"
      ? c.typicalBrandDealMinor
      : label === "coaching_lead"
        ? c.typicalCoachingMinor
        : label === "course_inquiry"
          ? c.typicalCourseMinor
          : (c.typicalBrandDealMinor ?? c.typicalCoachingMinor);
  if (!base) return null;
  return { minMinor: base.min, maxMinor: base.max };
}
