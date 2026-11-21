"use client";

import { useEffect, useState } from "react";
import { LABEL_FOR_DEAL_TYPE, OFFER_ADD_ONS, parseMoneyInput, type DealType, type OfferAddOnKey, type OfferAddOns, type OfferDto, type OfferInput } from "@dealdock/core";
import { ChevronDown, Copy, ExternalLink, Link2, LockKeyhole, Pencil, Plus, Tags } from "lucide-react";
import { dealTypeText } from "../../lib/format";
import { errorMessage } from "../../lib/snapshot";
import { appStore, useCan, useMoneyContext, useOffers, useSettings } from "../../lib/use-demo";
import { LargeTitle } from "../../components/kit";
import { Disclosure } from "../../components/sheet-parts";
import { Button, buttonClasses } from "../../components/ui/button";
import { formatMoney } from "../../components/ui/money-value";
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

/** Offers: the rate card drafts quote from. Private, unless the creator shares its rate-card link. */
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
        subtitle="Keep prices, availability and links ready for the replies you approve."
        accessory={offers.data && offers.data.length > 0 ? <Button variant="primary" icon={Plus} onClick={() => setEditing({ offer: null })}>Add offer</Button> : undefined}
      />
      <div className="px-4 md:px-8">
        {settings.data && accounts.length > 0 && <RateCardLink accounts={accounts} roster={settings.data.tier === "roster"} />}
        {offers.data && list.length > 0 && <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-caption text-ink-3"><p><span className="font-semibold text-ink-2">{list.filter((offer) => offer.active).length} active</span>{list.some((offer) => !offer.active) && <> · {list.filter((offer) => !offer.active).length} paused</>}</p><p className="inline-flex items-center gap-1.5"><LockKeyhole aria-hidden size={13} />Only your team sees these, until you share your rate card link</p></div>}
        <div className="min-w-0">
          {offers.status === "error" && !offers.data ? (
            <ErrorState thing="your offers" reason={offers.error} onRetry={() => void appStore.loadOffers()} />
          ) : loading ? (
            <div className="grid gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map((key) => <Skeleton key={key} className="h-[188px] rounded-[22px]" />)}</div>
          ) : list.length === 0 ? (
            <EmptyOffers onStart={(preset) => setEditing({ offer: null, preset })} />
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((offer) => (
                <li key={offer.id}><OfferCard offer={offer} accountHandle={offer.igAccountId ? accounts.find((account) => account.id === offer.igAccountId)?.handle ?? null : null} onOpen={() => setEditing({ offer })} /></li>
              ))}
            </ul>
          )}
        </div>
        <HowDraftsUse />
      </div>
      <OfferSheet key={editing ? editing.offer?.id ?? `new-${editing.preset?.name ?? ""}` : "closed"} editing={editing} accounts={accounts} accountsReady={Boolean(settings.data)} onClose={() => setEditing(null)} />
    </div>
  );
}

/**
 * The private rate-card link: one per creator, a page with their active
 * offers and add-on prices for brands that ask for rates. Create, copy, open
 * and turn off; turning off (or making a new one) ends the old link at once.
 * Creators to pick from show on Roster only.
 */
function RateCardLink({ accounts, roster }: { accounts: Array<{ id: string; handle: string; rateCardToken?: string | null }>; roster: boolean }) {
  const canManage = useCan("manage_settings");
  const [chosen, setChosen] = useState(accounts[0]!.id);
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const account = accounts.find((item) => item.id === chosen) ?? accounts[0]!;
  const url = account.rateCardToken && typeof window !== "undefined" ? `${window.location.origin}/rates/${encodeURIComponent(account.rateCardToken)}` : null;

  const change = async (on: boolean) => {
    setBusy(true);
    try {
      await appStore.setRateCardLink(account.id, on);
      toast(on ? "Rate card link ready. Copy it into any chat." : "Link turned off. Anyone who opens it now sees that it's gone.", on ? { tone: "success" } : {});
      setConfirmOff(false);
    } catch (failure) {
      toast(errorMessage(failure, "That didn't save. Try again."), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const copy = () => {
    if (!url) return;
    if (!navigator.clipboard) { toast("Couldn't copy it. Select the link and copy it yourself.", { tone: "error" }); return; }
    void navigator.clipboard.writeText(url).then(() => toast("Link copied.", { tone: "success" }), () => toast("Couldn't copy it. Select the link and copy it yourself.", { tone: "error" }));
  };

  return (
    <section aria-labelledby="rate-card-title" className="mb-5 rounded-[22px] bg-surface p-4 shadow-card sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-inset text-ink-2"><Link2 aria-hidden size={20} /></span>
        <div className="min-w-0 flex-1">
          <h2 id="rate-card-title" className="text-heading text-ink">Rate card link</h2>
          <p className="mt-0.5 text-caption text-ink-3">A page with {roster && accounts.length > 1 ? "this creator's" : "your"} active offers and add-on prices, for brands that ask for your rates. Only people with the link can open it.</p>
        </div>
      </div>
      {roster && accounts.length > 1 && (
        <Select label="Creator" className="mt-3 max-w-[320px]" value={account.id} onChange={(event) => setChosen(event.target.value)}>
          {accounts.map((item) => <option key={item.id} value={item.id}>@{item.handle}</option>)}
        </Select>
      )}
      {url ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="min-w-0 basis-full truncate rounded-xl bg-inset px-3 py-2 text-[14px] text-ink sm:flex-1 sm:basis-0" title={url}>{url}</p>
          <Button size="sm" variant="primary" icon={Copy} onClick={copy}>Copy</Button>
          <a href={url} target="_blank" rel="noopener noreferrer" className={buttonClasses({ variant: "secondary", size: "sm" })}><ExternalLink aria-hidden size={16} className="shrink-0" />Open</a>
          {canManage !== false && <Button size="sm" variant="danger-ghost" onClick={() => setConfirmOff(true)}>Turn off</Button>}
        </div>
      ) : canManage === false ? (
        <p className="mt-3 text-[14px] text-ink-2">No link yet. The workspace owner can make one here.</p>
      ) : (
        <Button className="mt-3" size="sm" variant="secondary" icon={Link2} loading={busy} loadingLabel="Making it…" onClick={() => void change(true)}>Create link</Button>
      )}
      <ConfirmDialog open={confirmOff} onClose={() => setConfirmOff(false)} title="Turn off this link?" confirmLabel="Turn off link" cancelLabel="Keep it" destructive busy={busy} busyLabel="Turning off…" onConfirm={() => void change(false)}>
        Anyone who opens it sees that it&apos;s gone. You can make a new link any time; the old one won&apos;t come back.
      </ConfirmDialog>
    </section>
  );
}

function OfferCard({ offer, accountHandle, onOpen }: { offer: OfferDto; accountHandle: string | null; onOpen: () => void }) {
  const style = LABEL_META[LABEL_FOR_DEAL_TYPE[offer.dealType]];
  const Icon = style.icon;
  const [updating, setUpdating] = useState(false);
  const toggle = async (active: boolean) => {
    if (updating) return;
    setUpdating(true);
    try {
      await toastAction(() => appStore.updateOffer(offer.id, { active }), {
        success: active ? `Drafts can mention ${offer.name} again.` : `Paused. Drafts won't mention ${offer.name}.`,
        fallback: "Couldn't change that offer.",
      });
    } finally { setUpdating(false); }
  };
  return (
    <article className={cx("flex h-full min-w-0 flex-col overflow-hidden rounded-[22px] transition-shadow", offer.active ? "bg-surface shadow-card hover:shadow-raised focus-within:shadow-raised" : "border border-dashed border-control bg-surface/60")}>
      <button type="button" onClick={onOpen} className="dd-press group flex min-w-0 flex-1 flex-col p-4 text-left outline-offset-[-4px] sm:p-5" aria-label={`Edit ${offer.name}`}>
        <div className="flex w-full items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-caption font-semibold text-ink-2"><span className={cx("flex h-8 w-8 items-center justify-center rounded-[10px]", style.tint)}><Icon aria-hidden size={16} className={style.accent} /></span>{dealTypeText(offer.dealType)}</span>
          <span className="inline-flex items-center gap-2 text-caption text-ink-3 group-hover:text-ink">{!offer.active && <span className="rounded-full bg-inset px-2 py-0.5 font-semibold text-ink-2">Paused</span>}<Pencil aria-hidden size={13} /><span>Edit</span></span>
        </div>
        <h2 className="mt-4 break-words text-[17px] font-semibold leading-6 tracking-[-0.015em] text-ink">{offer.name}</h2>
        <p className="mt-1 text-caption text-ink-3">{offer.igAccountId === null ? "Shared across all creators" : accountHandle ? `For @${accountHandle}` : "Creator details unavailable"}</p>
        <p className="mt-3 text-[26px] font-semibold leading-8 tracking-[-0.03em] text-ink">
          <span className="sr-only">Rate: </span>
          {offer.priceMinMinor === null ? <span className="text-[16px] text-ink-2">Price on request</span> : <MoneyValue minor={offer.priceMinMinor} maxMinor={offer.priceMaxMinor ?? undefined} mode={offer.priceMaxMinor ? "range" : "exact"} />}
        </p>
        {offer.availability && <p className="mt-3 text-[13px] font-medium leading-5 text-ink-2">{offer.availability}</p>}
        {offer.details && <p className="mt-2 line-clamp-2 text-[14px] leading-5 text-ink-2">{offer.details}</p>}
        {offer.link && <p className="mt-3 inline-flex max-w-full items-center gap-1.5 text-caption text-ink-3"><Link2 aria-hidden size={13} className="shrink-0" /><span className="truncate">{hostOf(offer.link)}</span></p>}
      </button>
      <div className="border-t border-hairline px-4 py-3 sm:px-5">
        <Switch checked={offer.active} disabled={updating} onChange={(active) => void toggle(active)} label={<span className="text-label font-medium">{updating ? "Updating…" : "Use in drafts"}<span className="sr-only"> for {offer.name}</span></span>} className="items-center" />
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

function HowDraftsUse() {
  return (
    <details className="group mt-6 border-t border-hairline pt-1">
      <summary className="dd-summary flex min-h-12 items-center justify-between gap-3 rounded-xl px-1 text-label font-medium text-ink-2 hover:text-ink">
        How offers shape a draft<ChevronDown aria-hidden size={16} className="transition-transform group-open:rotate-180" />
      </summary>
      <ul className="grid gap-3 px-1 pb-2 text-[14px] leading-5 text-ink-2 sm:grid-cols-2">
        <li><b className="font-semibold text-ink">Saved facts.</b> “Add my rate” uses the matching creator&apos;s active offers, including any shared offers.</li>
        <li><b className="font-semibold text-ink">Your final say.</b> Review the price, availability and link before approving a reply. Paused offers are left out of new draft context.</li>
      </ul>
    </details>
  );
}

function OfferSheet({ editing, accounts, accountsReady, onClose }: { editing: Editing; accounts: Array<{ id: string; handle: string }>; accountsReady: boolean; onClose: () => void }) {
  const offer = editing?.offer ?? null;
  const initial = {
    name: offer?.name ?? editing?.preset?.name ?? "",
    dealType: offer?.dealType ?? editing?.preset?.dealType ?? ("brand" as DealType),
    priceMin: moneyFieldText(offer?.priceMinMinor),
    priceMax: moneyFieldText(offer?.priceMaxMinor),
    link: offer?.link ?? "",
    availability: offer?.availability ?? "",
    details: offer?.details ?? "",
    igAccountId: offer ? offer.igAccountId ?? "shared" : accounts.length === 1 ? accounts[0]!.id : "",
    active: offer?.active ?? true,
    addOns: Object.fromEntries(OFFER_ADD_ONS.map(({ key }) => [key, moneyFieldText(offer?.addOns?.[key])])) as Record<OfferAddOnKey, string>,
  };
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<"name" | "priceMin" | "priceMax" | "link" | "igAccountId", string>>>({});
  const [addOnErrors, setAddOnErrors] = useState<Partial<Record<OfferAddOnKey, string>>>({});
  // Prices already set open the fold; a new offer keeps it closed.
  const [addOnsOpen, setAddOnsOpen] = useState(OFFER_ADD_ONS.some(({ key }) => initial.addOns[key]));
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const save = async () => {
    const next: typeof errors = {};
    const min = form.priceMin ? parseMoneyInput(form.priceMin) : null;
    const max = form.priceMax ? parseMoneyInput(form.priceMax) : null;
    const scope = form.igAccountId || (accounts.length === 1 ? accounts[0]!.id : "");
    if (!accountsReady) next.igAccountId = "Wait for your creator accounts to load before saving.";
    else if (!accounts.length) next.igAccountId = "Connect an Instagram account before adding an offer.";
    else if (scope !== "shared" && !accounts.some((account) => account.id === scope)) next.igAccountId = "Choose an available creator for this offer.";
    if (accounts.length > 1 && !form.igAccountId) next.igAccountId = "Choose a creator, or deliberately share this offer across the workspace.";
    if (!form.name.trim()) next.name = "Give the offer a name.";
    if (form.priceMin && min === null) next.priceMin = MONEY_INPUT_ERROR;
    if (form.priceMax && max === null) next.priceMax = MONEY_INPUT_ERROR;
    if (max !== null && min === null) next.priceMin = "Add the starting price too.";
    if (min !== null && max !== null && max < min) next.priceMax = "This should be at least the starting price.";
    if (form.link && !/^https?:\/\/\S+\.\S+/.test(form.link.trim())) next.link = "Use a full link, starting with https://";
    // Add-ons are a brand offer's: blank is "not set", which drafts never quote.
    const brand = form.dealType === "brand";
    const addOnPrices = Object.fromEntries(OFFER_ADD_ONS.map(({ key }) => [key, brand && form.addOns[key] ? parseMoneyInput(form.addOns[key]) : null])) as unknown as OfferAddOns;
    const badAddOns = Object.fromEntries(OFFER_ADD_ONS.filter(({ key }) => brand && form.addOns[key] && addOnPrices[key] === null).map(({ key }) => [key, MONEY_INPUT_ERROR]));
    setErrors(next);
    setAddOnErrors(badAddOns);
    if (Object.keys(badAddOns).length) setAddOnsOpen(true);
    if (Object.keys(next).length || Object.keys(badAddOns).length) return;
    const input: OfferInput = {
      igAccountId: scope !== "shared" ? scope : null,
      name: form.name.trim(),
      dealType: form.dealType,
      priceMinMinor: min,
      priceMaxMinor: max !== null && max !== min ? max : null,
      link: form.link.trim() || null,
      details: form.details.trim() || null,
      availability: form.availability.trim() || null,
      addOns: OFFER_ADD_ONS.some(({ key }) => addOnPrices[key] !== null) ? addOnPrices : null,
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
            <Button variant="primary" onClick={() => void save()} disabled={!accountsReady || !accounts.length} loading={busy} loadingLabel="Saving…">{offer ? "Save" : "Add offer"}</Button>
          </>
        }
      >
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          {!accountsReady ? <p role="status" className="text-label text-ink-2">Loading creator accounts before saving…</p> : !accounts.length ? <p role="alert" className="text-label text-ink-2">Connect Instagram in Settings before adding an offer.</p> : accounts.length === 1 ? <p className="text-caption text-ink-2">For @{accounts[0]!.handle}</p> : null}
          {errors.igAccountId && accounts.length <= 1 && <p role="alert" className="text-caption text-danger">{errors.igAccountId}</p>}
          {accounts.length > 1 && (
            <Select label="Creator" value={form.igAccountId} onChange={(event) => set("igAccountId", event.target.value)} error={errors.igAccountId} helper={form.igAccountId === "shared" ? "Every creator in this workspace can quote this offer." : form.igAccountId ? "Only this creator's drafts can quote the offer." : "Choose whose drafts can quote this offer."}>
              <option value="" disabled>Choose a creator…</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>@{account.handle}</option>)}
              <option value="shared">Shared across every creator</option>
            </Select>
          )}
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
            <TextField label="Name" value={form.name} maxLength={80} onChange={(event) => set("name", event.target.value)} error={errors.name} />
            <DealTypeSelect label="Type" value={form.dealType} onChange={(type) => set("dealType", type)} />
          </div>
          <fieldset className="rounded-2xl border border-separator p-3">
            <legend className="px-1 text-label font-semibold text-ink">Your price</legend>
            <div className="grid grid-cols-2 gap-3">
              <MoneyField label="Price from" value={form.priceMin} onChange={(text) => set("priceMin", text)} error={errors.priceMin} />
              <MoneyField label="Up to" optional value={form.priceMax} onChange={(text) => set("priceMax", text)} error={errors.priceMax} />
            </div>
            <p className="mt-2 text-caption text-ink-3">For one fixed price, leave “Up to” empty. No price means on request.</p>
          </fieldset>
          <TextField label="Link, optional" type="url" inputMode="url" value={form.link} onChange={(event) => set("link", event.target.value)} error={errors.link} helper="Rate card, booking page or checkout. Drafts share it as is." />
          <TextField label="Availability, optional" value={form.availability} maxLength={120} onChange={(event) => set("availability", event.target.value)} helper="Like “2 slots left in December”." />
          <TextArea label="Details, optional" value={form.details} maxLength={500} rows={3} onChange={(event) => set("details", event.target.value)} helper="What's included and payment options." />
          {form.dealType === "brand" && (
            <AddOnPrices
              open={addOnsOpen}
              onToggle={setAddOnsOpen}
              values={form.addOns}
              errors={addOnErrors}
              feeMinor={form.priceMin ? parseMoneyInput(form.priceMin) : null}
              onChange={(key, text) => set("addOns", { ...form.addOns, [key]: text })}
            />
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

/**
 * Add-on prices on a brand offer, folded away: drafts quote one only when a
 * brand asks and the price is set, and flag it as missing otherwise. Each
 * hint is the usual range (typical, not advice), worked out on the offer's
 * starting price when it has one.
 */
function AddOnPrices({ open, onToggle, values, errors, feeMinor, onChange }: {
  open: boolean;
  onToggle: (open: boolean) => void;
  values: Record<OfferAddOnKey, string>;
  errors: Partial<Record<OfferAddOnKey, string>>;
  feeMinor: number | null;
  onChange: (key: OfferAddOnKey, text: string) => void;
}) {
  const { money } = useMoneyContext();
  // Rounded to a whole hundred so the worked range stays tidy.
  const share = (percent: number) => formatMoney(Math.round((feeMinor! * percent) / 100 / 10_000) * 10_000, null, "compact", money);
  return (
    <Disclosure summary="Add-on prices (optional)" open={open} onToggle={onToggle}>
      <p className="text-caption text-ink-3">Drafts quote these only when a brand asks, and only the ones you set. The ranges below are what&apos;s typical, not advice. GST, when you charge it, goes on the invoice, not here.</p>
      {OFFER_ADD_ONS.map((addOn) => (
        <MoneyField
          key={addOn.key}
          label={`${addOn.label}${addOn.unit ? ` ${addOn.unit}` : ""}`}
          optional
          value={values[addOn.key]}
          error={errors[addOn.key]}
          onChange={(text) => onChange(addOn.key, text)}
          helper={feeMinor ? `${addOn.hint} On ${formatMoney(feeMinor, null, "compact", money)}, that's about ${share(addOn.percent[0])}–${share(addOn.percent[1])}.` : addOn.hint}
        />
      ))}
    </Disclosure>
  );
}
