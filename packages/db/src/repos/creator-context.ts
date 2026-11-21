import { Prisma } from "@prisma/client";
import {
  DomainError,
  highValueThresholdMinor,
  MinorUnits,
  type Channel,
  type ClassificationLabel,
  type CurrencyCode,
  type ExclusivityNote,
  type MeasuredStyle,
  type OfferAddOns,
  type StyleCard,
  type VoiceRuleScope,
} from "@dealdock/core";
import { prisma } from "../client";
import { minorUnitsToNumber } from "../money";
import type { OrgId } from "../org-id";
import { creatorAccountOf } from "../seat-scope";
import { channelOf, listActiveExclusivities } from "./deals";
import { hasVoiceConsent } from "../voice-consent";
import { listRecentOverrides } from "./classifications";
import { inboundTexts } from "./drafts";
import { storedAddOns } from "./offers";
import { loadVoiceCorpus, type VoiceCorpusRow } from "./voice";

/** The public address of a rate-card link: the web app's /rates/<token>. Null when off, or when WEB_APP_URL isn't a valid http(s) address. */
export function rateCardUrlOf(token: string | null, webAppUrl = process.env.WEB_APP_URL): string | null {
  if (!token || !webAppUrl) return null;
  try {
    const url = new URL(`/rates/${encodeURIComponent(token)}`, webAppUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface OfferContextRow {
  id: string;
  name: string;
  dealType: "brand" | "coaching" | "course" | "other";
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  link: string | null;
  details: string | null;
  availability: string | null;
  /** Brand offers' add-on prices; null when none is set. */
  addOns: OfferAddOns | null;
}

export interface VoiceRuleContextRow {
  id: string;
  key: string;
  text: string;
  scope: VoiceRuleScope;
  status: "active" | "pinned";
  source: string;
  evidence: number;
}

export type MeasuredStyleRow = MeasuredStyle & { medianWords?: number; devanagariRate?: number; lowercaseStartRate?: number };

/** The org's business profile, as both prompts read it (onboarding questionnaire, PRD §5.1.5). */
interface BusinessContextFields {
  businessSummary: string;
  currencyCode: string;
  locale: string;
  typicalBrandDealMinor: { min: number; max: number } | null;
  typicalCoachingMinor: { min: number; max: number } | null;
  typicalCourseMinor: { min: number; max: number } | null;
}

export interface CreatorContextRow extends BusinessContextFields {
  styleCard: Record<string, unknown> | null;
  correctionExamples: Array<{ text: string; correctLabel: string }>;
  voiceEnabled: boolean;
  /** Profile version captured with the voice data used for generation. */
  voiceVersion: number | null;
  /** Samples the creator marked "not me" (consent-gated); pass this row to getDraftVoiceContext. */
  excludedMessageIds: string[];
  /** Active offers in the org currency: this account's and workspace-wide ones. */
  offers: OfferContextRow[];
  /** This creator's private rate-card link (WEB_APP_URL/rates/<token>); null when it is off or the web address isn't configured. */
  rateCardUrl: string | null;
  /** Active + pinned rules for this account (consent-gated; candidates and muted never). */
  voiceRules: VoiceRuleContextRow[];
  measured: MeasuredStyleRow[];
  styleOverrides: Partial<StyleCard> | null;
  learningPaused: boolean;
}

/**
 * What classifying one message needs (the classify prompt and the worker's
 * routing), nothing voice-derived: an @dealdock/ai CreatorContext as-is.
 */
export interface ClassifyContextRow extends BusinessContextFields {
  /** Classification never reads the style card; null keeps the row an ai CreatorContext. */
  styleCard: null;
  correctionExamples: Array<{ text: string; correctLabel: string }>;
  /** Writing-voice consent on this account: replies are pre-drafted only with it. */
  voiceEnabled: boolean;
  /** The high-value push bar for this account (core highValueThresholdMinor over its active brand offers). */
  highValueThresholdMinor: number;
}

/**
 * The business profile one creator account's prompts read: the workspace profile, with that
 * creator's own answers (businessContext.creators[id], set on Roster plans) taking precedence
 * key by key. A null in the creator's profile means "doesn't sell this", not "inherit".
 */
export function creatorBusinessContext(raw: Prisma.JsonValue | undefined, igAccountId: string): Record<string, unknown> {
  const ctx = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const creators = ctx["creators"];
  const own = creators && typeof creators === "object" && !Array.isArray(creators) ? (creators as Record<string, unknown>)[igAccountId] : undefined;
  return own && typeof own === "object" && !Array.isArray(own) ? { ...ctx, ...(own as Record<string, unknown>) } : ctx;
}

function businessContextOf(org: { currencyCode: string; locale: string; businessContext: Prisma.JsonValue }, igAccountId: string): BusinessContextFields {
  const ctx = creatorBusinessContext(org.businessContext, igAccountId);
  // Rows saved before PUT /onboarding validated ranges may hold anything: only
  // whole, non-negative minor units with min <= max reach a prompt.
  const range = (key: string) => {
    const r = ctx[key] as { min?: unknown; max?: unknown } | null | undefined;
    const min = MinorUnits.safeParse(r?.min);
    const max = MinorUnits.safeParse(r?.max);
    return min.success && max.success && min.data <= max.data ? { min: min.data, max: max.data } : null;
  };
  return {
    businessSummary:
      (ctx["businessSummary"] as string | undefined) ??
      "Commerce creator selling through Instagram DMs.",
    currencyCode: org.currencyCode,
    locale: org.locale,
    typicalBrandDealMinor: range("typicalBrandDealMinor"),
    typicalCoachingMinor: range("typicalCoachingMinor"),
    typicalCourseMinor: range("typicalCourseMinor"),
  };
}

function measuredOf(card: Record<string, unknown> | null): MeasuredStyleRow[] {
  const list = card?.["measured"];
  if (!Array.isArray(list)) return [];
  return list.filter(
    (m): m is MeasuredStyleRow =>
      typeof m === "object" && m !== null && typeof (m as MeasuredStyle).scope === "string" && typeof (m as MeasuredStyle).avgWords === "number" && Array.isArray((m as MeasuredStyle).topOpeners)
  );
}

/**
 * Assembles the per-creator AI context — strictly org-scoped; this is the ONLY
 * place prompt context is gathered, so cross-creator leakage is structurally
 * impossible (ARCHITECTURE.md §3.3). Voice data (card, rules, measured habits,
 * overrides) is present only under active consent for THIS account.
 */
export async function getCreatorContext(
  orgId: OrgId,
  accountId: string
): Promise<CreatorContextRow> {
  // An email inbox writes as its creator: consent, corrections, rules and offers live on the creator account.
  const igAccountId = await creatorAccountOf(orgId, accountId);
  const [org, voice, corrections] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { currencyCode: true, locale: true, businessContext: true },
    }),
    prisma.voiceProfile.findFirst({
      where: { orgId, igAccountId },
      select: { enabled: true, consentedAt: true, revokedAt: true, styleCard: true, styleOverrides: true, learningPaused: true, excludedMessageIds: true, version: true },
    }),
    // Corrections are creator-account scoped. A roster manager's correction
    // for one creator must never alter another creator's model prompt.
    listRecentOverrides(orgId, igAccountId, 10),
  ]);
  if (!org) throw new DomainError("org not found", 404);

  const consented = hasVoiceConsent(voice);
  const [offers, rules, account] = await Promise.all([
    prisma.offer.findMany({
      where: { orgId, active: true, currencyCode: org.currencyCode, OR: [{ igAccountId }, { igAccountId: null }] },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      take: 20,
    }),
    consented
      ? prisma.voiceRule.findMany({
          where: { orgId, igAccountId, status: { in: ["active", "pinned"] } },
          orderBy: [{ evidence: "desc" }, { key: "asc" }],
          take: 60,
          select: { id: true, key: true, text: true, scope: true, status: true, source: true, evidence: true },
        })
      : Promise.resolve([]),
    prisma.igAccount.findFirst({ where: { id: igAccountId, orgId }, select: { rateCardToken: true } }),
  ]);

  const styleCard = consented ? (voice?.styleCard as Record<string, unknown> | null) : null;

  return {
    ...businessContextOf(org, igAccountId),
    styleCard,
    correctionExamples: corrections,
    voiceEnabled: consented,
    voiceVersion: voice?.version ?? null,
    excludedMessageIds: consented ? voice.excludedMessageIds : [],
    offers: offers.map((o) => ({
      id: o.id,
      name: o.name,
      dealType: o.dealType,
      priceMinMinor: o.priceMinMinor === null ? null : minorUnitsToNumber(o.priceMinMinor, "priceMinMinor"),
      priceMaxMinor: o.priceMaxMinor === null ? null : minorUnitsToNumber(o.priceMaxMinor, "priceMaxMinor"),
      link: o.link,
      details: o.details,
      availability: o.availability,
      addOns: o.dealType === "brand" ? storedAddOns(o.addOns) : null,
    })),
    rateCardUrl: rateCardUrlOf(account?.rateCardToken ?? null),
    voiceRules: rules.map((r) => ({ ...r, scope: r.scope as VoiceRuleScope, status: r.status as "active" | "pinned" })),
    measured: measuredOf(styleCard),
    styleOverrides: consented ? ((voice?.styleOverrides as Partial<StyleCard> | null) ?? null) : null,
    learningPaused: voice?.learningPaused ?? false,
  };
}

/**
 * The classification slice of getCreatorContext: business profile and
 * corrections for the prompt, voice consent for pre-drafting, and the
 * account's high-value push bar. Never reads the style card, rules or samples.
 */
export async function getClassifyContext(orgId: OrgId, accountId: string): Promise<ClassifyContextRow> {
  const igAccountId = await creatorAccountOf(orgId, accountId);
  const [org, voice, corrections, brandOffers] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { currencyCode: true, locale: true, businessContext: true },
    }),
    prisma.voiceProfile.findFirst({
      where: { orgId, igAccountId },
      select: { enabled: true, consentedAt: true, revokedAt: true },
    }),
    // Account-scoped, as in getCreatorContext: one creator's corrections never reach another's prompt.
    listRecentOverrides(orgId, igAccountId, 10),
    prisma.offer.findMany({
      where: { orgId, active: true, dealType: "brand", OR: [{ igAccountId }, { igAccountId: null }] },
      select: { dealType: true, priceMinMinor: true, active: true, currencyCode: true },
    }),
  ]);
  if (!org) throw new DomainError("org not found", 404);

  const offers = brandOffers
    .filter((offer) => offer.currencyCode === org.currencyCode)
    .map((offer) => ({
      dealType: offer.dealType,
      active: offer.active,
      priceMinMinor: offer.priceMinMinor === null ? null : minorUnitsToNumber(offer.priceMinMinor, "priceMinMinor"),
    }));
  return {
    ...businessContextOf(org, igAccountId),
    styleCard: null,
    correctionExamples: corrections,
    voiceEnabled: hasVoiceConsent(voice),
    highValueThresholdMinor: highValueThresholdMinor(org.currencyCode as CurrencyCode, offers),
  };
}

export interface LessonPoolRow {
  draftId: string;
  threadId: string;
  scope: VoiceRuleScope;
  inboundText: string | null;
  before: string;
  after: string;
  editRatio: number;
  sentAt: Date;
}

/**
 * Retrieval pools for one draft (research 04 §4.4), consent-gated: the newest
 * ~200 outbound texts (minus excluded samples) as exemplar candidates, and
 * the last 120 days of learned, really-edited sends as lesson candidates.
 * Pass the CreatorContextRow already loaded for this account as `voice` so
 * its VoiceProfile is not read a second time.
 */
export async function getDraftVoiceContext(
  orgId: OrgId,
  accountId: string,
  now = new Date(),
  voice?: Pick<CreatorContextRow, "voiceEnabled" | "excludedMessageIds">,
): Promise<{ exemplarPool: VoiceCorpusRow[]; lessonPool: LessonPoolRow[] }> {
  const igAccountId = await creatorAccountOf(orgId, accountId);
  const state = voice ?? (await draftVoiceState(orgId, igAccountId));
  if (!state.voiceEnabled) return { exemplarPool: [], lessonPool: [] };
  const excluded = new Set(state.excludedMessageIds);
  const [corpus, lessons] = await Promise.all([
    loadVoiceCorpus(orgId, igAccountId, 200),
    prisma.draft.findMany({
      where: {
        orgId,
        status: "sent",
        thread: { igAccountId },
        learnedAt: { not: null },
        editSignals: { not: Prisma.DbNull },
        editRatio: { gte: 0.05, lte: 0.8 },
        finalText: { not: null },
        sentAt: { gte: new Date(now.getTime() - 120 * 864e5) },
      },
      orderBy: { sentAt: "desc" },
      take: 100,
      select: { id: true, sentMessageId: true, threadId: true, kind: true, label: true, body: true, finalText: true, editRatio: true, sentAt: true, replyToMessageId: true },
    }),
  ]);
  const inbound = await inboundTexts(orgId, lessons.map((l) => l.replyToMessageId));
  return {
    exemplarPool: corpus.filter((row) => !excluded.has(row.messageId)),
    lessonPool: lessons.filter((l) => !l.sentMessageId || !excluded.has(l.sentMessageId)).map((l) => ({
      draftId: l.id,
      threadId: l.threadId,
      scope: l.kind === "nudge" ? "nudge" : (l.label ?? "all"),
      inboundText: l.replyToMessageId ? (inbound.get(l.replyToMessageId) ?? null) : null,
      before: l.body,
      after: l.finalText ?? "",
      editRatio: l.editRatio ?? 0,
      sentAt: l.sentAt ?? now,
    })),
  };
}

async function draftVoiceState(orgId: OrgId, igAccountId: string): Promise<Pick<CreatorContextRow, "voiceEnabled" | "excludedMessageIds">> {
  const profile = await prisma.voiceProfile.findFirst({
    where: { orgId, igAccountId },
    select: { enabled: true, consentedAt: true, revokedAt: true, excludedMessageIds: true },
  });
  return hasVoiceConsent(profile)
    ? { voiceEnabled: true, excludedMessageIds: profile.excludedMessageIds }
    : { voiceEnabled: false, excludedMessageIds: [] };
}

export interface DraftThreadContext {
  id: string;
  igAccountId: string;
  participantHandle: string;
  topLabel: ClassificationLabel | null;
  /** Email threads draft as emails (greeting, sign-off) and show their subject to the model. */
  channel: Channel;
  subject: string | null;
  /** Last 12 messages, oldest first, with voice-note transcripts. */
  messages: Array<{ id: string; direction: "inbound" | "outbound"; contentType: "text" | "audio" | "attachment"; text: string; transcript: string | null; sentAt: Date }>;
  latestInbound: { id: string; text: string; label: ClassificationLabel | null } | null;
  /** The live (or in-flight) draft, if any. */
  liveDraft: { id: string; status: string; body: string; kind: "reply" | "nudge"; label: ClassificationLabel | null } | null;
  /** Exclusivities this creator agreed with someone else that are still running; drafts must not accept a competing deal. */
  exclusivities: ExclusivityNote[];
  /** Org IANA time zone, so drafts name dates on the org's calendar. */
  timezone: string;
}

/** What drafting needs from a thread (org-scoped; null when the thread isn't in this org). */
export async function getDraftThreadContext(orgId: OrgId, threadId: string): Promise<DraftThreadContext | null> {
  const thread = await prisma.thread.findFirst({
    where: { id: threadId, orgId },
    select: { id: true, igAccountId: true, participantHandle: true, topLabel: true, subject: true, igAccount: { select: { platform: true, org: { select: { timezone: true } } } } },
  });
  if (!thread) return null;
  const select = {
    id: true,
    direction: true,
    contentType: true,
    text: true,
    transcript: true,
    sentAt: true,
    classification: { select: { label: true, overrideLabel: true } },
  } as const;
  const [recent, latestInbound, liveDraft, exclusivities] = await Promise.all([
    prisma.message.findMany({ where: { orgId, threadId }, orderBy: [{ sentAt: "desc" }, { id: "desc" }], take: 12, select }),
    prisma.message.findFirst({ where: { orgId, threadId, direction: "inbound" }, orderBy: [{ sentAt: "desc" }, { id: "desc" }], select }),
    prisma.draft.findFirst({
      where: { orgId, threadId, status: { in: ["ready", "edited", "sending"] } },
      orderBy: { version: "desc" },
      select: { id: true, status: true, body: true, kind: true, label: true },
    }),
    // Only a brand conversation can compete with an exclusivity.
    thread.topLabel === "brand_deal" ? listActiveExclusivities(orgId, thread.igAccountId, thread.participantHandle) : Promise.resolve([]),
  ]);
  const { igAccount, ...row } = thread;
  return {
    ...row,
    exclusivities,
    timezone: igAccount.org.timezone,
    channel: channelOf(igAccount.platform),
    messages: recent.reverse().map((m) => ({ id: m.id, direction: m.direction, contentType: m.contentType, text: m.text, transcript: m.transcript, sentAt: m.sentAt })),
    latestInbound: latestInbound
      ? {
          id: latestInbound.id,
          text: latestInbound.text.trim() || latestInbound.transcript || "",
          label: latestInbound.classification ? (latestInbound.classification.overrideLabel ?? latestInbound.classification.label) : null,
        }
      : null,
    liveDraft,
  };
}

export async function upsertBusinessContext(
  orgId: OrgId,
  businessContext: Record<string, unknown>
) {
  return prisma.organization.update({
    where: { id: orgId },
    data: { businessContext: businessContext as never },
  });
}
