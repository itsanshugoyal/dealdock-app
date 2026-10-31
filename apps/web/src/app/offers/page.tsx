"use client";

import { useEffect, useState } from "react";
import { LABEL_FOR_DEAL_TYPE, parseMoneyInput, type DealType, type OfferDto, type OfferInput } from "@dealdock/core";
import { AudioLines, Link2, Plus, Tags } from "lucide-react";
import { dealTypeText } from "../../lib/format";
import { errorMessage } from "../../lib/snapshot";
import { appStore, useOffers, useSettings } from "../../lib/use-demo";
import { LargeTitle, Tag } from "../../components/kit";
import { Button } from "../../components/ui/button";
import { cx } from "../../components/ui/cx";
import { ErrorState, Skeleton } from "../../components/ui/feedback";
import { DealTypeSelect, MONEY_INPUT_ERROR, MoneyField, Select, Switch, TextArea, TextField, moneyFieldText } from "../../components/ui/field";
import { LABEL_META } from "../../components/ui/label-chip";
import { MoneyValue } from "../../components/ui/money-value";
import { Chip } from "../../components/ui/selection";
import { ConfirmDialog, Sheet } from "../../components/ui/sheet";
import { toast, toastAction } from "../../components/ui/toast";

/** Starting points for a first offer; the sheet opens prefilled with these. */
const STARTERS: Array<{ name: string; dealType: DealType }> = [
  { name: "Reel + stories", dealType: "brand" },
  { name: "1:1 coaching", dealType: "coaching" },
  { name: "Online course", dealType: "course" },
  { name: "Workshop", dealType: "other" },
];

type Editing = { offer: OfferDto | null; preset?: { name: string; dealType: DealType } } | null;

function hostOf(link: string): string {
  try { return new URL(link).host.replace(/^www\./, ""); } catch { return link; }
}

/** Offers: the private rate card drafts quote from. Never a public page. */
export default function OffersPage() {
  const offers = useOffers();
  const settings = useSettings();
  const [editing, setEditing] = useState<Editing>(null);
  // The command palette's "Add an offer…" opens /offers#new.
  useEffect(() => { if (window.location.hash === "#new") setEditing({ offer: null }); }, []);
  const list = [...(offers.data ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || a.sortOrder - b.sortOrder);
  const accounts = settings.data?.accounts ?? [];
  const loading = !offers.data && offers.status !== "error";

  return (
    <div className="mx-auto w-full max-w-[1180px] pb-12">
      <LargeTitle
        eyebrow="Your rate card"
        title="Offers"
        subtitle="What you sell, at what price. Drafts quote these exactly, so nobody gets a made-up number. Only your team sees them."
        accessory={offers.data && offers.data.length > 0 ? <Button variant="primary" icon={Plus} onClick={() => setEditing({ offer: null })}>Add offer</Button> : undefined}
      />
      <div className="grid gap-5 px-4 md:px-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)] lg:gap-6">
        <div className="min-w-0">
          {offers.status === "error" && !offers.data ? (
            <ErrorState thing="your offers" reason={offers.error} onRetry={() => void appStore.loadOffers()} />
          ) : loading ? (
            <div className="grid gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map((key) => <Skeleton key={key} className="h-[188px] rounded-[22px]" />)}</div>
          ) : list.length === 0 ? (
            <EmptyOffers onStart={(preset) => setEditing({ offer: null, preset })} />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {list.map((offer) => (
                <li key={offer.id}><OfferCard offer={offer} accountHandle={offer.igAccountId ? accounts.find((account) => account.id === offer.igAccountId)?.handle ?? null : null} onOpen={() => setEditing({ offer })} /></li>
              ))}
            </ul>
          )}
        </div>
        <aside className="flex flex-col gap-4">
          <HowDraftsUse offers={list} />
        </aside>
      </div>
      <OfferSheet key={editing ? editing.offer?.id ?? `new-${editing.preset?.name ?? ""}` : "closed"} editing={editing} accounts={accounts} onClose={() => setEditing(null)} />
    </div>
  );
}

function OfferCard({ offer, accountHandle, onOpen }: { offer: OfferDto; accountHandle: string | null; onOpen: () => void }) {
  const style = LABEL_META[LABEL_FOR_DEAL_TYPE[offer.dealType]];
  const Icon = style.icon;
  const toggle = (active: boolean) => toastAction(() => appStore.updateOffer(offer.id, { active }), {
    success: active ? `Drafts can mention ${offer.name} again.` : `Paused. Drafts won't mention ${offer.name}.`,
    fallback: "Couldn't change that offer.",
  });
  return (
    <article className="flex h-full flex-col rounded-[22px] bg-surface p-4 shadow-card md:p-5">
      <button type="button" onClick={onOpen} className="dd-press -m-2 flex flex-1 flex-col rounded-2xl p-2 text-left hover:bg-inset/60" aria-label={`Edit ${offer.name}`}>
        <div className="flex items-start gap-3">
          <span className={cx("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", style.tint, style.accent)}><Icon aria-hidden size={19} /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-semibold leading-5 text-ink">{offer.name}</h2>
            <p className="mt-0.5 text-caption text-ink-3">{dealTypeText(offer.dealType)}{accountHandle ? ` · @${accountHandle}` : ""}</p>
          </div>
          {!offer.active && <Tag>Paused</Tag>}
        </div>
        <p className="mt-4 text-[24px] font-semibold leading-7 tracking-[-0.02em] text-ink">
          {offer.priceMinMinor === null ? <span className="text-[17px] text-ink-2">Price on request</span> : <MoneyValue minor={offer.priceMinMinor} maxMinor={offer.priceMaxMinor ?? undefined} mode={offer.priceMaxMinor ? "range" : "exact"} />}
        </p>
        {offer.availability && <p className="mt-1 text-[14px] font-semibold text-recovered">{offer.availability}</p>}
        {offer.details && <p className="mt-2 line-clamp-2 text-[14px] leading-5 text-ink-2">{offer.details}</p>}
        {offer.link && <p className="mt-3 inline-flex max-w-full items-center gap-1.5 text-caption font-semibold text-ink-3"><Link2 aria-hidden size={14} className="shrink-0" /><span className="truncate">{hostOf(offer.link)}</span></p>}
      </button>
      <div className="mt-4 border-t border-hairline pt-3">
        <Switch checked={offer.active} onChange={(active) => void toggle(active)} label={<span className="text-[14px] font-semibold">Drafts can mention this</span>} className="items-center" />
      </div>
    </article>
  );
}

function EmptyOffers({ onStart }: { onStart: (preset: { name: string; dealType: DealType }) => void }) {
  return (
    <section aria-labelledby="empty-offers" className="rounded-[26px] bg-surface p-6 shadow-card md:p-8">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-tint text-recovered"><Tags aria-hidden size={22} /></span>
      <h2 id="empty-offers" className="mt-4 text-title text-ink">Add what you sell</h2>
      <p className="mt-1 max-w-md text-body text-ink-2">When someone asks for your rate, the draft quotes your real price and link instead of guessing. Start with one:</p>
      <div className="mt-5 flex flex-wrap gap-2">
        {STARTERS.map((starter) => <Chip key={starter.name} variant="action" icon={Plus} onClick={() => onStart(starter)}>{starter.name}</Chip>)}
      </div>
    </section>
  );
}

function HowDraftsUse({ offers }: { offers: OfferDto[] }) {
  const example = offers.find((offer) => offer.active && offer.priceMinMinor !== null);
  return (
    <section aria-labelledby="how-offers" className="rounded-[22px] bg-surface p-5 shadow-card">
      <h2 id="how-offers" className="flex items-center gap-2 text-heading text-ink"><AudioLines aria-hidden size={18} className="text-recovered" />How drafts use this</h2>
      {example && (
        <div className="mt-4 flex flex-col gap-2 rounded-2xl bg-inset p-3">
          <p className="dd-bubble-in max-w-[88%] self-start px-3.5 py-2 text-[14px] leading-5 text-ink">Hi! What do you charge?</p>
          <p className="dd-bubble-out max-w-[88%] self-end px-3.5 py-2 text-[14px] leading-5">
            Heyy! {example.name} is <MoneyValue minor={example.priceMinMinor!} maxMinor={example.priceMaxMinor ?? undefined} mode={example.priceMaxMinor ? "range" : "exact"} className="font-semibold" />{example.link ? `. Details: ${hostOf(example.link)}` : "."}
          </p>
        </div>
      )}
      <ul className="mt-4 flex flex-col gap-2.5 text-[14px] leading-5 text-ink-2">
        <li>“Add my rate” in a draft uses the price saved here.</li>
        <li>Links go out exactly as you saved them.</li>
        <li>Paused offers are never mentioned.</li>
        <li>Nothing here is public. It&apos;s only used to write your drafts.</li>
      </ul>
    </section>
  );
}

function OfferSheet({ editing, accounts, onClose }: { editing: Editing; accounts: Array<{ id: string; handle: string }>; onClose: () => void }) {
  const offer = editing?.offer ?? null;
  const initial = {
    name: offer?.name ?? editing?.preset?.name ?? "",
    dealType: offer?.dealType ?? editing?.preset?.dealType ?? ("brand" as DealType),
    priceMin: moneyFieldText(offer?.priceMinMinor),
    priceMax: moneyFieldText(offer?.priceMaxMinor),
    link: offer?.link ?? "",
    availability: offer?.availability ?? "",
    details: offer?.details ?? "",
    igAccountId: offer?.igAccountId ?? "",
    active: offer?.active ?? true,
  };
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<"name" | "priceMin" | "priceMax" | "link", string>>>({});
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const save = async () => {
    const next: typeof errors = {};
    const min = form.priceMin ? parseMoneyInput(form.priceMin) : null;
    const max = form.priceMax ? parseMoneyInput(form.priceMax) : null;
    if (!form.name.trim()) next.name = "Give the offer a name.";
    if (form.priceMin && min === null) next.priceMin = MONEY_INPUT_ERROR;
    if (form.priceMax && max === null) next.priceMax = MONEY_INPUT_ERROR;
    if (max !== null && min === null) next.priceMin = "Add the starting price too.";
    if (min !== null && max !== null && max < min) next.priceMax = "This should be at least the starting price.";
    if (form.link && !/^https?:\/\/\S+\.\S+/.test(form.link.trim())) next.link = "Use a full link, starting with https://";
    setErrors(next);
    if (Object.keys(next).length) return;
    const input: OfferInput = {
      igAccountId: form.igAccountId || null,
      name: form.name.trim(),
      dealType: form.dealType,
      priceMinMinor: min,
      priceMaxMinor: max !== null && max !== min ? max : null,
      link: form.link.trim() || null,
      details: form.details.trim() || null,
      availability: form.availability.trim() || null,
      active: form.active,
      sortOrder: offer?.sortOrder ?? Date.now() % 100_000,
    };
    setBusy(true);
    try {
      if (offer) await appStore.updateOffer(offer.id, input);
      else await appStore.createOffer(input);
      toast(offer ? "Offer saved." : "Offer added. Drafts can quote it now.", { tone: "success" });
      onClose();
    } catch (failure) {
      toast(errorMessage(failure, "Couldn't save the offer. Try again."), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!offer) return;
    setBusy(true);
    try {
      await appStore.deleteOffer(offer.id);
      toast(`${offer.name} deleted.`);
      setConfirmDelete(false);
      onClose();
    } catch (failure) {
      toast(errorMessage(failure, "Couldn't delete the offer."), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Sheet
        open={editing !== null && !confirmDelete}
        onClose={onClose}
        title={offer ? "Edit offer" : "Add an offer"}
        dirty={dirty && !busy}
        footer={
          <>
            {offer && <Button variant="danger-ghost" className="mr-auto" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete</Button>}
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={() => void save()} loading={busy} loadingLabel="Saving…">{offer ? "Save" : "Add offer"}</Button>
          </>
        }
      >
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <TextField label="Name" value={form.name} maxLength={80} onChange={(event) => set("name", event.target.value)} error={errors.name} helper="As you'd say it in a DM, like “Reel + 2 stories”." />
          <DealTypeSelect label="Type" value={form.dealType} onChange={(type) => set("dealType", type)} />
          <div className="grid grid-cols-2 gap-3">
            <MoneyField label="Price from" value={form.priceMin} onChange={(text) => set("priceMin", text)} error={errors.priceMin} />
            <MoneyField label="Up to" optional value={form.priceMax} onChange={(text) => set("priceMax", text)} error={errors.priceMax} />
          </div>
          <p className="-mt-2 text-caption text-ink-3">Leave the price empty and drafts say it&apos;s on request.</p>
          <TextField label="Link, optional" type="url" inputMode="url" value={form.link} onChange={(event) => set("link", event.target.value)} error={errors.link} helper="Rate card, booking page or checkout. Drafts share it as is." />
          <TextField label="Availability, optional" value={form.availability} maxLength={120} onChange={(event) => set("availability", event.target.value)} helper="Like “2 slots left in December”." />
          <TextArea label="Details, optional" value={form.details} maxLength={500} rows={3} onChange={(event) => set("details", event.target.value)} helper="What's included, add-ons, payment options." />
          {accounts.length > 1 && (
            <Select label="Creator" value={form.igAccountId} onChange={(event) => set("igAccountId", event.target.value)}>
              <option value="">Every creator</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>@{account.handle}</option>)}
            </Select>
          )}
          <Switch checked={form.active} onChange={(active) => set("active", active)} label="Drafts can mention this" description="Turn off to pause an offer without deleting it." />
        </form>
      </Sheet>
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${offer?.name ?? "this offer"}?`} confirmLabel="Delete offer" destructive busy={busy} busyLabel="Deleting…" onConfirm={() => void remove()}>
        Drafts stop quoting it. Sales you already recorded aren&apos;t affected.
      </ConfirmDialog>
    </>
  );
}
