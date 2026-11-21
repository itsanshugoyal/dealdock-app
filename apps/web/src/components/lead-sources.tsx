"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { LEAD_PROVIDER_NAME, pipelineStage, type LeadEventDto, type LeadSourceCreated, type LeadSourceDto, type LeadSourceProvider } from "@dealdock/core";
import { CalendarCheck, ChevronRight, Copy, CreditCard, MoreHorizontal, Plug, Plus, Unplug, type LucideIcon } from "lucide-react";
import { agoText, displayName, formatDate, pluralize } from "../lib/format";
import { useMinuteClock } from "../lib/keyboard";
import { errorMessage } from "../lib/snapshot";
import { appStore, useApp, useCan, useLeadSources, useMoneyContext } from "../lib/use-demo";
import { Group } from "./kit";
import { paidWords, StageChip } from "./pipeline";
import { SaveError } from "./sheet-parts";
import { Button } from "./ui/button";
import { cx } from "./ui/cx";
import { ErrorState, Skeleton } from "./ui/feedback";
import { TextField } from "./ui/field";
import { Menu } from "./ui/menu";
import { Avatar } from "./ui/sender";
import { ConfirmDialog, Sheet } from "./ui/sheet";
import { toast, toastAction } from "./ui/toast";

const TOOLS: Array<{ provider: LeadSourceProvider; what: string; icon: LucideIcon; tile: string }> = [
  { provider: "calendly", what: "Booked calls", icon: CalendarCheck, tile: "bg-info" },
  { provider: "cal_com", what: "Booked calls and their payments", icon: CalendarCheck, tile: "bg-info" },
  { provider: "razorpay", what: "Payment links and pages", icon: CreditCard, tile: "bg-brand" },
  { provider: "stripe", what: "Payment links", icon: CreditCard, tile: "bg-brand" },
  { provider: "other", what: "Zapier, Make or your own tools", icon: Plug, tile: "bg-ink-3" },
];
const tool = (provider: LeadSourceProvider) => TOOLS.find((item) => item.provider === provider)!;

/** The JSON a Zapier, Make or home-made step sends to the plain address. */
const OTHER_SHAPE = `{
  "event": "booked" or "paid",
  "id": "its id in your tool",
  "amount": 4999,
  "currency": "INR",
  "name": "Who booked or paid",
  "at": "2026-11-07T10:30:00Z",
  "ref": "dd_… from a DealDock link"
}`;

/**
 * Settings → Booking and payment links (owners): the tools that report
 * bookings and payments back, what they reported that matched no
 * conversation, and connecting a new one with plain steps for that tool.
 */
export function LeadSourcesSection() {
  const canManage = useCan("manage_settings");
  const view = useLeadSources(canManage === true);
  const now = useMinuteClock();
  const { locale, timezone } = useMoneyContext();
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState<LeadSourceDto | null>(null);
  const [matching, setMatching] = useState<LeadEventDto | null>(null);
  const [securing, setSecuring] = useState<LeadSourceDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (canManage === false) return null;

  const sources = view.data?.sources ?? [];
  const unmatched = view.data?.unmatched ?? [];
  const remove = async () => {
    if (!removing) return;
    setBusy(removing.id);
    if (await toastAction(() => appStore.removeLeadSource(removing.id), { success: `${LEAD_PROVIDER_NAME[removing.provider]} removed. Its address stops working now.`, fallback: "Couldn't remove it. Try again." })) setRemoving(null);
    setBusy(null);
  };
  const dismiss = async (event: LeadEventDto) => {
    setBusy(event.id);
    await toastAction(() => appStore.dismissLeadEvent(event.id), { success: "Dismissed.", fallback: "That didn't save. Try again." });
    setBusy(null);
  };
  const payments = unmatched.filter((event) => event.kind === "paid").length;
  const bookings = unmatched.length - payments;

  return (
    <Group id="tools" title="Booking and payment links" description="When someone books or pays through a link you sent, DealDock moves their conversation along and suggests recording the sale. Nothing is sent for you.">
      {view.status === "error" && !view.data ? (
        <ErrorState thing="your booking and payment links" reason={view.error} onRetry={() => void appStore.loadLeadSources()} />
      ) : !view.data ? <div className="p-4"><Skeleton className="h-12" /></div> : (
        <>
          {unmatched.length > 0 && (
            <div className="border-b border-hairline bg-waiting-tint/40">
              <p className="px-4 pt-3 text-label font-semibold text-ink md:px-5">
                {[payments ? `${payments} ${pluralize(payments, "payment")}` : null, bookings ? `${bookings} ${pluralize(bookings, "booking")}` : null].filter(Boolean).join(" and ")} we couldn&apos;t match
              </p>
              <ul>
                {unmatched.map((event) => (
                  <li key={event.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 md:px-5">
                    <div className="min-w-0 flex-1 basis-52">
                      <p className="text-[15px] font-semibold leading-5 text-ink">{event.kind === "paid" ? paidWords(event, locale) : `Booked through ${LEAD_PROVIDER_NAME[event.provider]}`}</p>
                      <p className="mt-0.5 text-caption text-ink-3">{[event.payerName ?? "No name given", formatDate(event.occurredAt, locale, timezone, { day: "numeric", month: "short" })].join(" · ")}</p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <Button size="sm" variant="secondary" onClick={() => setMatching(event)}>Match to a conversation</Button>
                      <Button size="sm" variant="ghost" loading={busy === event.id} loadingLabel="Dismissing…" onClick={() => void dismiss(event)}>Dismiss</Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ul>
            {sources.map((source, index) => {
              const item = tool(source.provider);
              return (
                <li key={source.id}>
                  {index > 0 && <div aria-hidden className="ml-4 border-t border-hairline md:ml-5" />}
                  <div className="flex items-center gap-3 px-4 py-3 md:px-5">
                    <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-white", item.tile)}><item.icon aria-hidden size={17} /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-semibold text-ink">{source.label ?? LEAD_PROVIDER_NAME[source.provider]}</p>
                      <p className={cx("text-caption", source.needsSecret ? "font-semibold text-waiting" : "text-ink-3")}>
                        {source.needsSecret ? "Waiting for its signing secret" : source.lastEventAt && now > 0 ? `Last activity ${agoText(Date.parse(source.lastEventAt), now, locale, timezone)}` : `${item.what} · no activity yet`}
                      </p>
                    </div>
                    {source.needsSecret && <Button size="sm" variant="primary" onClick={() => setSecuring(source)}>Add secret</Button>}
                    <Menu label={`More for ${LEAD_PROVIDER_NAME[source.provider]}`} icon={MoreHorizontal} items={[{ label: "Remove", icon: Unplug, destructive: true, onSelect: () => setRemoving(source) }]} />
                  </div>
                </li>
              );
            })}
          </ul>
          {sources.length > 0 && <div aria-hidden className="ml-4 border-t border-hairline md:ml-5" />}
          <button type="button" onClick={() => setConnecting(true)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-inset md:px-5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-tint text-recovered"><Plus aria-hidden size={18} /></span>
            <span className="text-[15px] font-semibold text-brand">Connect a booking or payment tool</span>
          </button>
          <p className="border-t border-hairline bg-inset/50 px-4 py-3 text-caption text-ink-2 md:px-5">
            Bookings through Topmate and UPI payments don&apos;t report back. Set those stages by hand in the conversation.
          </p>
        </>
      )}
      <ConnectSheet open={connecting} onClose={() => setConnecting(false)} />
      <SecretSheet source={securing} onClose={() => setSecuring(null)} />
      <MatchSheet event={matching} onClose={() => setMatching(null)} />
      <ConfirmDialog open={removing !== null} onClose={() => setRemoving(null)} title={`Remove ${removing ? LEAD_PROVIDER_NAME[removing.provider] : "this tool"}?`} confirmLabel="Remove" destructive busy={busy !== null} busyLabel="Removing…" onConfirm={() => void remove()}>
        Its address stops working at once, and DealDock forgets what it reported. Conversations and their stages stay.{removing?.provider === "calendly" && " You can also delete the access key in Calendly."}
      </ConfirmDialog>
    </Group>
  );
}

/** Numbered setup steps in plain words. */
function Steps({ children }: { children: ReactNode[] }) {
  return <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[14px] leading-5 text-ink-2">{children.map((step, index) => <li key={index}>{step}</li>)}</ol>;
}

/** The address to paste into the tool, shown once, with a copy button. */
function AddressField({ address }: { address: string }) {
  const copy = () => {
    if (!navigator.clipboard) { toast("Couldn't copy it. Select the address and copy it yourself.", { tone: "error" }); return; }
    void navigator.clipboard.writeText(address).then(() => toast("Address copied.", { tone: "success" }), () => toast("Couldn't copy it. Select the address and copy it yourself.", { tone: "error" }));
  };
  return (
    <div className="flex flex-col gap-2">
      <TextField label="Address to paste into the tool" readOnly value={address} onFocus={(event) => event.currentTarget.select()} helper="DealDock shows it only this once. If you lose it, remove the tool and connect it again." />
      <Button variant="secondary" icon={Copy} className="self-start" onClick={copy}>Copy address</Button>
    </div>
  );
}

/** Pick a tool, give it what it needs, then paste the address it shows (Calendly is set up by DealDock instead). */
function ConnectSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [provider, setProvider] = useState<LeadSourceProvider | null>(null);
  const [secret, setSecret] = useState("");
  const [created, setCreated] = useState<LeadSourceCreated | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { onClose(); setProvider(null); setSecret(""); setCreated(null); setError(null); };
  const name = provider === "other" ? "another tool" : provider ? LEAD_PROVIDER_NAME[provider] : "";

  const connect = async () => {
    if (!provider) return;
    const value = secret.trim();
    if ((provider === "calendly" || provider === "razorpay") && value.length < (provider === "calendly" ? 20 : 8)) {
      setError(provider === "calendly" ? "Paste the whole access key from Calendly." : "Enter a secret of at least 8 characters, and use the same one in Razorpay.");
      return;
    }
    if (provider === "cal_com" && value && value.length < 8) { setError("Use at least 8 characters, or leave it empty."); return; }
    setBusy(true);
    setError(null);
    try {
      setCreated(await appStore.connectLeadSource(provider === "calendly" ? { provider, accessKey: value } : { provider, ...(value ? { secret: value } : {}) }));
      setSecret("");
    } catch (failure) {
      setError(errorMessage(failure, `${name} couldn't be connected. Try again.`));
    } finally {
      setBusy(false);
    }
  };
  const saveSecret = async () => {
    if (!created) return;
    if (secret.trim().length < 8) { setError("Paste the whole signing secret from Stripe."); return; }
    setBusy(true);
    setError(null);
    try {
      await appStore.saveLeadSourceSecret(created.source.id, secret.trim());
      toast("Stripe is connected.", { tone: "success" });
      close();
    } catch (failure) {
      setError(errorMessage(failure, "The secret didn't save. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const footer = !provider ? undefined
    : !created ? <Button variant="primary" size="lg" fullWidth loading={busy} loadingLabel="Connecting…" onClick={() => void connect()}>{provider === "other" ? "Get the address" : `Connect ${name}`}</Button>
    : created.source.provider === "stripe" ? <Button variant="primary" size="lg" fullWidth loading={busy} loadingLabel="Saving…" onClick={() => void saveSecret()}>Save and finish</Button>
    : <Button variant="primary" size="lg" fullWidth onClick={close}>Done</Button>;

  return (
    <Sheet
      open={open}
      onClose={close}
      title={provider ? `Connect ${name}` : "Connect a tool"}
      description={provider ? undefined : "Pick the tool your booking or payment links come from."}
      placement="center"
      dirty={Boolean(secret.trim()) && !busy}
      footer={footer}
    >
      <div className="flex flex-col gap-4">
        {!provider ? (
          <ul className="-mx-1 flex flex-col">
            {TOOLS.map((item) => (
              <li key={item.provider}>
                <button type="button" onClick={() => setProvider(item.provider)} className="dd-press flex min-h-14 w-full items-center gap-3 rounded-2xl px-2 py-2 text-left hover:bg-inset">
                  <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-white", item.tile)}><item.icon aria-hidden size={17} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold text-ink">{item.provider === "other" ? "Something else" : LEAD_PROVIDER_NAME[item.provider]}</span>
                    <span className="block text-caption text-ink-3">{item.what}</span>
                  </span>
                  <ChevronRight aria-hidden size={18} className="shrink-0 text-ink-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : !created ? (
          <>
            {provider === "calendly" && <>
              <Steps>{[
                <>In Calendly, open Integrations, then &ldquo;API &amp; Webhooks&rdquo;.</>,
                <>Under &ldquo;Personal access tokens&rdquo;, create one and copy it.</>,
                <>Paste it here. DealDock uses it once to set Calendly up, and doesn&apos;t keep it.</>,
              ]}</Steps>
              <TextField label="Calendly access key" type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} />
            </>}
            {provider === "cal_com" && <>
              <p className="text-[14px] text-ink-2">Bookings move the conversation to Booked, and paid bookings to Paid.</p>
              <TextField label="Secret, optional" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} helper="Make one up and paste the same into Cal.com. It proves the bookings come from your Cal.com." />
            </>}
            {provider === "razorpay" && <>
              <p className="text-[14px] text-ink-2">Payments move the conversation to Paid and suggest recording the sale. Razorpay links can&apos;t say which conversation they&apos;re from, so DealDock matches the payer&apos;s name, and you match the rest here.</p>
              <TextField label="Secret" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} helper="Make one up (8 characters or more). You'll enter the same one in Razorpay." />
            </>}
            {provider === "stripe" && <p className="text-[14px] text-ink-2">Payments through your Stripe payment links move the conversation to Paid and suggest recording the sale. Next, you&apos;ll paste an address into Stripe and bring back its signing secret.</p>}
            {provider === "other" && <p className="text-[14px] text-ink-2">For tools that can send a request when someone books or pays: Zapier, Make, or your own. You&apos;ll get an address to send it to.</p>}
            <SaveError message={error} />
            <Button variant="ghost" size="sm" className="self-start" onClick={() => { setProvider(null); setSecret(""); setError(null); }}>Pick another tool</Button>
          </>
        ) : created.address === null ? (
          <p role="status" className="text-[14px] text-ink-2"><b className="font-semibold text-ink">Calendly is connected.</b> New bookings move the conversation to Booked. DealDock didn&apos;t keep your access key; you can delete it in Calendly now.</p>
        ) : (
          <>
            <AddressField address={created.address} />
            {created.source.provider === "cal_com" && <Steps>{[
              <>In Cal.com, open Settings, then Developer, then &ldquo;Webhooks&rdquo;, and add a new one.</>,
              <>Paste the address, and the same secret if you set one.</>,
              <>Choose Booking created and Booking paid, then save.</>,
            ]}</Steps>}
            {created.source.provider === "razorpay" && <Steps>{[
              <>In Razorpay, open Account &amp; Settings, then &ldquo;Webhooks&rdquo;, and add a new one.</>,
              <>Paste the address and enter the same secret.</>,
              <>Tick payment.captured, payment_link.paid and order.paid, then save. Test mode and live mode each need their own.</>,
            ]}</Steps>}
            {created.source.provider === "stripe" && <>
              <Steps>{[
                <>In Stripe, open Workbench, then &ldquo;Webhooks&rdquo;, and add a destination.</>,
                <>Choose checkout.session.completed and checkout.session.async_payment_succeeded, then paste the address.</>,
                <>Stripe then shows a signing secret starting with whsec_. Paste it here.</>,
              ]}</Steps>
              <TextField label="Stripe signing secret" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} />
            </>}
            {created.source.provider === "other" && <>
              <Steps>{[
                <>In Zapier or Make, add a step that sends a POST request to this address when someone books or pays.</>,
                <>Send JSON in this shape. Only &ldquo;event&rdquo; and &ldquo;id&rdquo; are required; &ldquo;amount&rdquo; is in rupees or your currency&apos;s main unit, and the currency defaults to yours.</>,
              ]}</Steps>
              <pre className="overflow-x-auto rounded-2xl bg-inset px-4 py-3 font-mono text-[13px] leading-5 text-ink">{OTHER_SHAPE}</pre>
            </>}
            <SaveError message={error} />
          </>
        )}
      </div>
    </Sheet>
  );
}

/** Razorpay's or Stripe's signing secret, added after connecting. */
function SecretSheet({ source, onClose }: { source: LeadSourceDto | null; onClose: () => void }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = source ? LEAD_PROVIDER_NAME[source.provider] : "";
  const save = async () => {
    if (!source) return;
    if (secret.trim().length < 8) { setError(`Paste the whole signing secret from ${name}.`); return; }
    setBusy(true);
    setError(null);
    try {
      await appStore.saveLeadSourceSecret(source.id, secret.trim());
      toast(`${name} is connected.`, { tone: "success" });
      setSecret("");
      onClose();
    } catch (failure) {
      setError(errorMessage(failure, "The secret didn't save. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={source !== null} onClose={() => { setSecret(""); setError(null); onClose(); }} title={`${name} signing secret`} description={`Until it's saved, DealDock ignores what ${name} sends.`} placement="center" dirty={Boolean(secret.trim()) && !busy}
      footer={<Button variant="primary" size="lg" fullWidth loading={busy} loadingLabel="Saving…" onClick={() => void save()}>Save</Button>}>
      <div className="flex flex-col gap-4">
        <TextField label="Signing secret" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} helper={source?.provider === "stripe" ? "Stripe shows it on the destination's page; it starts with whsec_." : "The one you entered in Razorpay."} />
        <SaveError message={error} />
      </div>
    </Sheet>
  );
}

/** Put an unmatched payment or booking with one of the recent coaching and course conversations. */
function MatchSheet({ event, onClose }: { event: LeadEventDto | null; onClose: () => void }) {
  const router = useRouter();
  const { threads } = useApp();
  const { locale } = useMoneyContext();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const candidates = threads
    .filter((thread) => thread.routedTo === "inbox" && pipelineStage(thread) !== null)
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .slice(0, 12);
  const match = async (threadId: string, who: string) => {
    if (!event) return;
    setBusy(threadId);
    setError(null);
    try {
      await appStore.matchLeadEvent(event.id, threadId);
      toast(`Matched to ${who}.`, { tone: "success", action: { label: "Open", onClick: () => router.push(`/thread/${encodeURIComponent(threadId)}`) } });
      onClose();
    } catch (failure) {
      setError(errorMessage(failure, "That didn't save. Try again."));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet open={event !== null} onClose={onClose} title="Match to a conversation" description={event ? `${event.kind === "paid" ? paidWords(event, locale) : `Booked through ${LEAD_PROVIDER_NAME[event.provider]}`}${event.payerName ? `, by ${event.payerName}` : ""}. Which conversation is it?` : undefined} placement="center">
      <div className="flex flex-col gap-3">
        {candidates.length === 0 ? <p className="text-[14px] text-ink-2">No coaching or course conversations are open right now.</p> : (
          <ul className="-mx-1 flex flex-col">
            {candidates.map((thread) => {
              const who = displayName(thread.participant, thread.handle);
              return (
                <li key={thread.id}>
                  <button type="button" disabled={busy !== null} onClick={() => void match(thread.id, who)} className="dd-press flex min-h-14 w-full items-center gap-3 rounded-2xl px-2 py-2 text-left hover:bg-inset disabled:opacity-60">
                    <Avatar handle={thread.handle} name={thread.participant.name} src={thread.participant.avatarUrl} size={36} />
                    <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink"><bdi>{who}</bdi></span>
                    <StageChip stage={pipelineStage(thread)!} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <SaveError message={error} />
      </div>
    </Sheet>
  );
}
