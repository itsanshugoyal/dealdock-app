"use client";

import { useEffect, useState } from "react";
import { LABEL_FOR_DEAL_TYPE, OFFER_ADD_ONS, type MoneyContext, type PublicRateCard, type PublicRateCardOffer } from "@dealdock/core";
import { ExternalLink, RefreshCw } from "lucide-react";
import { dealTypeText } from "../lib/format";
import { errorMessage } from "../lib/snapshot";
import { appStore, IS_DEMO_MODE } from "../lib/use-demo";
import { HeroCard, Logo } from "./kit";
import { Button } from "./ui/button";
import { cx } from "./ui/cx";
import { Skeleton } from "./ui/feedback";
import { LABEL_META } from "./ui/label-chip";
import { MoneyValue } from "./ui/money-value";
import { Avatar } from "./ui/sender";

type Load = { status: "loading" } | { status: "ready"; card: PublicRateCard } | { status: "gone" } | { status: "error"; message: string };

/**
 * A creator's rate card behind their private link, as a brand sees it: the
 * creator, then each active offer with its price, what's included, when it's
 * available, its add-on prices and its link. Nothing internal, and a plain
 * "not available" once the link is turned off or replaced.
 */
export function RateCardView({ token }: { token: string }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoad({ status: "loading" });
    appStore.loadPublicRateCard(token).then(
      (card) => { if (active) setLoad(card ? { status: "ready", card } : { status: "gone" }); },
      (failure: unknown) => { if (active) setLoad({ status: "error", message: errorMessage(failure, "This rate card didn't load. Try again in a moment.") }); },
    );
    return () => { active = false; };
  }, [token, attempt]);

  return (
    <main id="main-content" className="min-h-dvh bg-canvas px-4 pb-16 pt-[max(env(safe-area-inset-top),24px)] md:pt-12">
      <div className="mx-auto w-full max-w-[640px]">
        {IS_DEMO_MODE && <p role="note" className="mb-4 text-center text-caption text-ink-3">Demo · fictional data</p>}
        {load.status === "loading" ? (
          <div aria-busy="true" aria-label="Loading the rate card" className="flex flex-col gap-3">
            <Skeleton className="h-[148px] rounded-[26px]" />
            <Skeleton className="h-[180px] rounded-[22px]" />
            <Skeleton className="h-[180px] rounded-[22px]" />
          </div>
        ) : load.status === "gone" ? (
          <section className="flex min-h-[60dvh] flex-col items-center justify-center text-center">
            <Logo size={48} />
            <h1 className="mt-6 text-title text-ink">This rate card isn&apos;t available.</h1>
            <p className="mt-2 max-w-sm text-body text-ink-2">The link was turned off or replaced. Ask the creator for their current rate card.</p>
          </section>
        ) : load.status === "error" ? (
          <section className="flex min-h-[60dvh] flex-col items-center justify-center text-center">
            <h1 className="text-title text-ink">This rate card didn&apos;t load.</h1>
            <p className="mt-2 max-w-sm text-body text-ink-2">{load.message}</p>
            <Button className="mt-5" variant="primary" icon={RefreshCw} onClick={() => setAttempt((count) => count + 1)}>Try again</Button>
          </section>
        ) : (
          <Card card={load.card} />
        )}
      </div>
    </main>
  );
}

function Card({ card }: { card: PublicRateCard }) {
  const ctx: MoneyContext = { currency: card.currencyCode, locale: card.locale };
  return (
    <>
      <HeroCard glow="money" className="p-5 md:p-7">
        <div className="flex items-center gap-3">
          <Avatar handle={card.handle} size={52} />
          <div className="min-w-0">
            <p className="text-label font-semibold text-on-hero/60">Rate card</p>
            <h1 className="truncate text-title text-on-hero">@{card.handle}</h1>
          </div>
        </div>
        <p className="mt-4 text-body text-on-hero/70">
          {card.offers.length ? `${card.offers.length} ${card.offers.length === 1 ? "offer" : "offers"} · prices in ${card.currencyCode}, before any tax` : "No offers are listed right now."}
        </p>
      </HeroCard>
      {card.offers.length > 0 && (
        <ul aria-label="Offers" className="mt-5 flex flex-col gap-3">
          {card.offers.map((offer, index) => <OfferItem key={`${offer.name}-${index}`} offer={offer} ctx={ctx} />)}
        </ul>
      )}
      <p className="mt-8 text-center text-caption text-ink-3">Shared by @{card.handle}. To book, reply in your chat with them.</p>
    </>
  );
}

function OfferItem({ offer, ctx }: { offer: PublicRateCardOffer; ctx: MoneyContext }) {
  const style = LABEL_META[LABEL_FOR_DEAL_TYPE[offer.dealType]];
  const addOns = OFFER_ADD_ONS.flatMap((addOn) => {
    const price = offer.addOns?.[addOn.key];
    return price === null || price === undefined ? [] : [{ ...addOn, price }];
  });
  return (
    <li className="rounded-[22px] bg-surface p-4 shadow-card sm:p-5">
      <p className="inline-flex items-center gap-2 text-caption font-semibold text-ink-2"><span aria-hidden className={cx("h-2 w-2 rounded-full", style.dot)} />{dealTypeText(offer.dealType)}</p>
      <h2 className="mt-2 break-words text-[17px] font-semibold leading-6 tracking-[-0.015em] text-ink">{offer.name}</h2>
      <p className="mt-1 text-[24px] font-semibold leading-8 tracking-[-0.03em] text-ink">
        {/* A brand sees exact amounts, never the compact "₹60K" the creator's own screens use. */}
        {offer.priceMinMinor === null
          ? <span className="text-[16px] text-ink-2">Price on request</span>
          : <><MoneyValue minor={offer.priceMinMinor} mode="exact" ctx={ctx} />{offer.priceMaxMinor !== null && offer.priceMaxMinor !== offer.priceMinMinor && <>–<MoneyValue minor={offer.priceMaxMinor} mode="exact" ctx={ctx} /></>}</>}
      </p>
      {offer.availability && <p className="mt-2 text-[14px] font-medium leading-5 text-ink-2">{offer.availability}</p>}
      {offer.details && <p className="mt-2 whitespace-pre-line break-words text-[14px] leading-5 text-ink-2">{offer.details}</p>}
      {addOns.length > 0 && (
        <div className="mt-3 rounded-2xl bg-inset px-3 py-2.5">
          <h3 className="text-caption font-semibold text-ink-3">Add-ons</h3>
          <dl className="mt-1 flex flex-col gap-1">
            {addOns.map((addOn) => (
              <div key={addOn.key} className="flex items-baseline justify-between gap-3 text-[14px]">
                <dt className="min-w-0 text-ink">{addOn.label}</dt>
                <dd className="shrink-0 text-ink"><MoneyValue minor={addOn.price} mode="exact" ctx={ctx} className="font-semibold" />{addOn.unit && <span className="text-ink-3"> {addOn.unit}</span>}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {offer.link && (
        <a href={offer.link} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-label font-semibold text-ink underline underline-offset-4">
          More details<ExternalLink aria-hidden size={14} />
        </a>
      )}
    </li>
  );
}
