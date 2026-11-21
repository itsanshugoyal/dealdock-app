import { commentReplyBy, type CommentLeadDto, type MoneyContext, type OfferDto } from "@dealdock/core";
import { DAY, DEMO_ACCOUNT_ID, DEMO_ACCOUNTS, HOUR, offerPrice } from "./demo-data";

/**
 * Demo comment leads: fictional people who commented a keyword on the demo
 * creator's reel, and the deterministic stand-in for the drafting model.
 * Pure: no React, no storage.
 */

const SIGNOFF = "– D";
const DEMO_POST_URL = "https://www.instagram.com/reel/demo-strength-basics/";
const HINGLISH = /\b(kya|hai|bhai|batao|kitna|kitne|ka|ki)\b/i;

/** @diya.moves answers PRICE and LINK; @rohan.cooks has a keyword but no comments yet; @ira.wanders has none. */
export function seedCommentKeywords(): Record<string, string[]> {
  return { [DEMO_ACCOUNT_ID]: ["PRICE", "LINK"], [DEMO_ACCOUNTS[1]!.id]: ["RECIPE"] };
}

/**
 * The demo's private reply: the offer the comment names (else the cohort),
 * its exact price and link, then a question so they reply. `shorter` is
 * "Draft again". Nothing in the comment is ever repeated back.
 */
export function commentReplyDraft(comment: string, offers: OfferDto[], ctx: MoneyContext, shorter = false): string {
  const active = offers.filter((offer) => offer.active);
  const words = comment.toLowerCase();
  const named = active.find((offer) => offer.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((word) => word.length > 3 && words.includes(word)));
  const offer = named ?? active.find((item) => item.dealType === "course") ?? active[0];
  if (!offer) return `Heyy! Thanks for asking. I'll share the details here soon. What would you like to know? ${SIGNOFF}`;
  const price = offerPrice(offer, ctx);
  if (HINGLISH.test(comment)) {
    return shorter
      ? `Heyy! ${offer.name}: ${price}.${offer.link ? ` ${offer.link}` : ""} Koi sawaal? ${SIGNOFF}`
      : `Heyy! ${offer.name} ka price ${price} hai.${offer.link ? ` Link yeh raha: ${offer.link}` : ""} Koi sawaal ho toh batao? ${SIGNOFF}`;
  }
  return shorter
    ? `Heyy! ${offer.name} is ${price}.${offer.link ? ` ${offer.link}` : ""} Any questions? ${SIGNOFF}`
    : `Heyy! ${offer.name} is ${price}.${offer.link ? ` Here's the link: ${offer.link}` : ""} Anything you'd like to know before you decide? ${SIGNOFF}`;
}

/** Four fresh PRICE comments with drafts (one in its last hours), one past the 7 days, one already answered. */
export function seedCommentLeads(now: number, offers: OfferDto[], ctx: MoneyContext): CommentLeadDto[] {
  const lead = (id: string, handle: string, text: string, ago: number, sent = false): CommentLeadDto => {
    const commentedAt = new Date(now - ago);
    const draft = commentReplyDraft(text, offers, ctx);
    return {
      id, igAccountId: DEMO_ACCOUNT_ID, commenterHandle: handle, text, keyword: "PRICE", mediaUrl: DEMO_POST_URL,
      commentedAt: commentedAt.toISOString(), replyBy: commentReplyBy(commentedAt).toISOString(),
      status: sent ? "sent" : "new", draftBody: draft, missingFacts: [], sentAt: sent ? new Date(now - ago + HOUR).toISOString() : null,
    };
  };
  return [
    lead("cl-meera", "meera.lifts", "PRICE? 🙏", 2 * HOUR),
    lead("cl-kavya", "kavya.k", "Price and link please 😍", 3 * HOUR),
    lead("cl-arjun", "arjun.fit", "Bhai price kya hai coaching ka?", DAY + 4 * HOUR),
    lead("cl-sana", "sana.runs", "price for the cohort??", 7 * DAY - 4 * HOUR),
    lead("cl-neel", "neel.moves", "price?", 9 * DAY),
    lead("cl-priya", "priya.sq", "PRICE pls", 2 * DAY, true),
  ];
}
