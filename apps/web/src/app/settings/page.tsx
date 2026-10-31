"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CURRENCY_SYMBOL, TIER_LIMITS } from "@dealdock/core";
import { Activity, AlertTriangle, AtSign, AudioLines, Bell, ChevronRight, CreditCard, Database, Download, Globe2, LogOut, Moon, Plus, Tags, Target, Trash2, UserPlus, UsersRound, X, type LucideIcon } from "lucide-react";
import { formatDate, pluralize, roleText, tierText } from "../../lib/format";
import { SETTINGS_SECTIONS } from "../../lib/settings-sections";
import { errorMessage } from "../../lib/snapshot";
import { appStore, useBilling, useCan, useDataSummary, useIgnoreList, useMe, useNotificationPrefs, useSeats, useSettings } from "../../lib/use-demo";
import { setUiPref, useUiPrefs, type ThemePreference, type UndoSeconds } from "../../lib/ui-prefs";
import { useAuthActions } from "../../components/auth-session";
import { GoalField, useGoalEditor } from "../../components/goal-editor";
import { Group, LargeTitle, Tag } from "../../components/kit";
import { enablePush, pushConfigured } from "../../components/pwa";
import { Button, buttonClasses } from "../../components/ui/button";
import { cx } from "../../components/ui/cx";
import { ErrorState, Skeleton } from "../../components/ui/feedback";
import { Select, Switch, TextField } from "../../components/ui/field";
import { Segmented } from "../../components/ui/selection";
import { ConfirmDialog, Sheet } from "../../components/ui/sheet";
import { toast, toastAction } from "../../components/ui/toast";
import { Avatar } from "../../components/ui/sender";

const FALLBACK_ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Australia/Sydney"];
const LOCALES = [
  { value: "en-IN", label: "India (1,00,000)" },
  { value: "en-US", label: "United States (100,000)" },
  { value: "en-GB", label: "United Kingdom (100,000)" },
];

/** Settings (the "You" tab): accounts, alerts, region, team, plan, appearance and data controls. */
export default function SettingsPage() {
  const settings = useSettings();
  const me = useMe();

  return (
    <div className="mx-auto w-full max-w-[1100px] pb-16">
      <LargeTitle title="Settings" />
      <div className="px-4 md:px-8 lg:grid lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-10">
        <nav aria-label="Settings sections" className="hidden lg:block">
          <ul className="sticky top-6 flex flex-col gap-0.5">
            {SETTINGS_SECTIONS.map((section) => (
              <li key={section.id}><a href={`#${section.id}`} className="block rounded-xl px-3 py-2 text-[14px] font-medium text-ink-2 hover:bg-inset hover:text-ink">{section.label}</a></li>
            ))}
            <li><Link href="/activity" className="block rounded-xl px-3 py-2 text-[14px] font-medium text-ink-2 hover:bg-inset hover:text-ink">Activity</Link></li>
          </ul>
        </nav>
        <div className="flex min-w-0 max-w-[720px] flex-col gap-7">
          <Profile />
          <StudioLinks />
          {settings.status === "error" && !settings.data ? (
            <ErrorState thing="your settings" reason={settings.error} onRetry={() => void appStore.loadSettings()} />
          ) : !settings.data ? (
            <div className="flex flex-col gap-5">{[0, 1, 2].map((key) => <Skeleton key={key} className="h-40 rounded-[20px]" />)}</div>
          ) : (
            <>
              <InstagramSection />
              <NotificationsSection />
              <RegionSection />
              <GoalSection />
              <SkipSection />
              <TeamSection />
              <PlanSection />
              <AppearanceSection />
              <ActivityLink />
              <DataSection />
            </>
          )}
          {me.data === null && me.status === "error" && <p className="text-caption text-ink-3">Your profile didn&apos;t load. Settings still work.</p>}
        </div>
      </div>
    </div>
  );
}

/* ── Shared pieces ─────────────────────────────────────────────────────── */

/** iOS-style settings row: tinted icon tile, title, detail, trailing control. */
function Row({ icon: Icon, tile, title, detail, trailing, className }: { icon?: LucideIcon; tile?: string; title: ReactNode; detail?: ReactNode; trailing?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-center gap-3 px-4 py-3 md:px-5", className)}>
      {Icon && <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-white", tile ?? "bg-ink-3")}><Icon aria-hidden size={17} /></span>}
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold leading-5 text-ink">{title}</div>
        {detail && <div className="mt-0.5 text-caption text-ink-3">{detail}</div>}
      </div>
      {trailing}
    </div>
  );
}

function Divider() {
  return <div aria-hidden className="ml-4 border-t border-hairline md:ml-5" />;
}

/* ── Profile ───────────────────────────────────────────────────────────── */

function Profile() {
  const me = useMe();
  const settings = useSettings();
  const { signOut } = useAuthActions();
  const name = me.data?.name ?? me.data?.email ?? null;
  const tier = settings.data?.tier ?? me.data?.tier ?? null;
  return (
    <section aria-label="Your profile" className="flex items-center gap-4 rounded-[24px] bg-surface p-4 shadow-card md:p-5">
      {me.data ? <Avatar handle={name ?? "you"} name={name} size={56} /> : <Skeleton className="h-14 w-14 rounded-full" />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[18px] font-semibold leading-6 text-ink">{name ?? (me.data ? "Your account" : <Skeleton className="h-5 w-32" />)}</p>
        {me.data?.email && me.data.name && <p className="truncate text-caption text-ink-3">{me.data.email}</p>}
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {me.data && <Tag>{roleText(me.data.role)}</Tag>}
          {tier && <Tag tone="money">{tierText(tier)} plan</Tag>}
        </div>
      </div>
      {signOut && <Button variant="secondary" size="sm" icon={LogOut} onClick={signOut}>Sign out</Button>}
    </section>
  );
}

/** Phone hub for the studio screens (desktop has them in the sidebar). */
function StudioLinks() {
  const settings = useSettings();
  const roster = settings.data?.tier === "roster";
  const links: Array<{ href: string; icon: LucideIcon; tile: string; title: string; detail: string }> = [
    { href: "/voice", icon: AudioLines, tile: "bg-brand", title: "Your voice", detail: "How drafts learn to sound like you" },
    { href: "/offers", icon: Tags, tile: "bg-label-course", title: "Offers", detail: "Your rate card for drafts" },
    ...(roster ? [{ href: "/roster", icon: UsersRound, tile: "bg-label-brand", title: "All creators", detail: "Every creator's money at a glance" }] : []),
    { href: "/activity", icon: Activity, tile: "bg-review", title: "Activity", detail: "Who sent what, and when" },
  ];
  return (
    <nav aria-label="Studio" className="overflow-hidden rounded-[20px] bg-surface shadow-card lg:hidden">
      <ul>
        {links.map((link, index) => (
          <li key={link.href}>
            {index > 0 && <div aria-hidden className="ml-[60px] border-t border-hairline" />}
            <Link href={link.href} className="dd-row-press flex items-center gap-3 px-4 py-3 hover:bg-inset">
              <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-white", link.tile)}><link.icon aria-hidden size={17} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-ink">{link.title}</span>
                <span className="block truncate text-caption text-ink-3">{link.detail}</span>
              </span>
              <ChevronRight aria-hidden size={18} className="text-ink-3" />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* ── Instagram ─────────────────────────────────────────────────────────── */

function InstagramSection() {
  const settings = useSettings().data!;
  const canManage = useCan("manage_settings");
  const [disconnecting, setDisconnecting] = useState<{ id: string; handle: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const limit = TIER_LIMITS[settings.tier].igAccounts;
  const connected = settings.accounts.filter((account) => account.status !== "disconnected").length;

  const connect = async () => {
    setBusy(true);
    try {
      const { authorizeUrl } = await appStore.connectInstagram();
      window.location.assign(authorizeUrl);
    } catch (failure) {
      toast(errorMessage(failure, "Couldn't open Instagram. Try again."), { tone: "error" });
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!disconnecting) return;
    setBusy(true);
    if (await toastAction(() => appStore.disconnectInstagram(disconnecting.id), { success: `@${disconnecting.handle} disconnected.`, fallback: "Couldn't disconnect. Try again." })) setDisconnecting(null);
    setBusy(false);
  };

  return (
    <Group id="instagram" title="Instagram" description={`${connected} of ${limit} ${pluralize(limit, "account")} on your plan`}>
      <ul>
        {settings.accounts.map((account, index) => {
          const healthy = account.status === "active";
          const disconnected = account.status === "disconnected";
          return (
            <li key={account.id}>
              {index > 0 && <Divider />}
              <div className="flex items-center gap-3 px-4 py-3 md:px-5">
                <Avatar handle={account.handle} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold text-ink">@{account.handle}</p>
                  <p className={cx("text-caption font-semibold", healthy ? "text-recovered" : disconnected ? "text-ink-3" : "text-waiting")}>
                    {healthy ? "Connected" : disconnected ? "Disconnected" : <span className="inline-flex items-center gap-1"><AlertTriangle aria-hidden size={13} />Needs reconnecting</span>}
                  </p>
                </div>
                {canManage !== false && (healthy
                  ? <Button variant="ghost" size="sm" onClick={() => setDisconnecting({ id: account.id, handle: account.handle })}>Disconnect</Button>
                  : <Button variant={disconnected ? "secondary" : "primary"} size="sm" loading={busy} loadingLabel="Opening…" onClick={() => void connect()}>Reconnect</Button>)}
              </div>
            </li>
          );
        })}
      </ul>
      {canManage !== false && connected < limit && (
        <>
          <Divider />
          <button type="button" onClick={() => void connect()} disabled={busy} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-inset disabled:opacity-60 md:px-5">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-tint text-recovered"><Plus aria-hidden size={18} /></span>
            <span className="text-[15px] font-semibold text-brand">Connect {settings.accounts.length ? "another" : "an"} Instagram account</span>
          </button>
        </>
      )}
      <div className="border-t border-hairline bg-inset/50 px-4 py-3 text-caption text-ink-2 md:px-5">
        {settings.humanAgentEnabled
          ? "You can reply up to 7 days after someone's last message. After 24 hours, replies are marked as sent by a person."
          : "Instagram lets you reply within 24 hours of someone's last message. After that, reply in the Instagram app."}
      </div>
      <ConfirmDialog open={disconnecting !== null} onClose={() => setDisconnecting(null)} title={`Disconnect @${disconnecting?.handle ?? ""}?`} confirmLabel="Disconnect" destructive busy={busy} busyLabel="Disconnecting…" onConfirm={() => void disconnect()}>
        DealDock stops reading new DMs and deletes its access to this account. Conversations, revenue and voice stay here, and you can reconnect any time.
      </ConfirmDialog>
    </Group>
  );
}

/* ── Notifications ────────────────────────────────────────────────────── */

function NotificationsSection() {
  const prefs = useNotificationPrefs();
  const [canPush, setCanPush] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setCanPush(pushConfigured()), []);
  const data = prefs.data;
  const set = (key: "notifyHighValue" | "notifyNudge" | "notifyWeeklySummary", value: boolean) =>
    void toastAction(() => appStore.setNotificationPrefs({ [key]: value }), { fallback: "Couldn't save that. Try again." });
  const enable = async () => {
    setBusy(true);
    await toastAction(async () => { await enablePush(); await appStore.loadNotificationPrefs(); }, { success: "Notifications are on for this device.", fallback: "Couldn't turn on notifications." });
    setBusy(false);
  };

  return (
    <Group id="notifications" title="Notifications" description="Quiet from 11pm to 8am in your time zone.">
      <Row
        icon={Bell}
        tile="bg-danger"
        title="This device"
        detail={data?.subscribed ? "Gets DealDock notifications." : canPush ? "Not getting notifications yet." : "Push notifications are not configured or supported on this device."}
        trailing={canPush ? <Button size="sm" variant={data?.subscribed ? "ghost" : "primary"} loading={busy} loadingLabel="Turning on…" onClick={() => void enable()}>{data?.subscribed ? "Enable or reconnect this device" : "Enable notifications on this device"}</Button> : undefined}
      />
      <Divider />
      {!data ? <div className="p-4"><Skeleton className="h-24" /></div> : (
        <div className="flex flex-col gap-4 px-4 py-4 md:px-5">
          <Switch checked={data.notifyHighValue} onChange={(value) => set("notifyHighValue", value)} label="Big money DMs" description="A brand or high-value lead messages you." />
          <Switch checked={data.notifyNudge} onChange={(value) => set("notifyNudge", value)} label="Follow-up reminders" description="Someone hasn't replied and it's time to check in." />
          <Switch checked={data.notifyWeeklySummary} onChange={(value) => set("notifyWeeklySummary", value)} label="Weekly summary" description="Mondays: what you recovered and what's still waiting." />
        </div>
      )}
    </Group>
  );
}

/* ── Region & follow-ups ──────────────────────────────────────────────── */

function RegionSection() {
  const settings = useSettings().data!;
  const canManage = useCan("manage_settings") !== false;
  const zones = useMemo(() => {
    let list: string[] = FALLBACK_ZONES;
    try { list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? FALLBACK_ZONES; } catch { /* older browsers */ }
    return list.includes(settings.timezone) ? list : [settings.timezone, ...list];
  }, [settings.timezone]);
  const update = (body: Parameters<typeof appStore.updateRegion>[0], done: string) => void toastAction(() => appStore.updateRegion(body), { success: done, fallback: "Couldn't save that. Try again." });
  const delay = [2, 3, 5, 7].includes(settings.nudgeDelayDays) ? String(settings.nudgeDelayDays) : "3";

  return (
    <Group id="region" title="Follow-ups & region">
      <div className="flex flex-col gap-4 px-4 py-4 md:px-5">
        <div className="flex flex-col gap-1.5">
          <span className="text-label text-ink">Remind me to follow up after</span>
          <Segmented
            label="Remind me to follow up after"
            value={delay}
            disabled={!canManage}
            onChange={(value) => update({ nudgeDelayDays: Number(value) }, `Follow-up reminders after ${value} days.`)}
            options={["2", "3", "5", "7"].map((value) => ({ value, label: `${value} days` }))}
            className="self-start"
          />
          <p className="text-caption text-ink-3">DealDock drafts a friendly nudge when a deal goes quiet. You still approve it.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Time zone" value={settings.timezone} disabled={!canManage} onChange={(event) => update({ timezone: event.target.value }, "Time zone saved.")}>
            {zones.map((zone) => <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>)}
          </Select>
          <Select label="Number format" value={settings.locale} disabled={!canManage} onChange={(event) => update({ locale: event.target.value }, "Number format saved.")}>
            {(LOCALES.some((item) => item.value === settings.locale) ? LOCALES : [{ value: settings.locale, label: settings.locale }, ...LOCALES]).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </Select>
        </div>
      </div>
      <Divider />
      <Row icon={Globe2} tile="bg-info" title="Currency" detail="Fixed for this workspace so past revenue never changes meaning." trailing={<span className="text-[15px] font-semibold text-ink">{settings.currencyCode} · {CURRENCY_SYMBOL[settings.currencyCode]}</span>} />
    </Group>
  );
}

/* ── Goal ──────────────────────────────────────────────────────────────── */

function GoalSection() {
  const goal = useSettings().data!.monthlyGoalMinor;
  const editor = useGoalEditor(goal);
  return (
    <Group id="goal" title="Monthly goal" description="Today and Revenue show how close you are.">
      <form className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start md:px-5" onSubmit={(event) => { event.preventDefault(); void editor.save(); }}>
        <GoalField editor={editor} className="flex-1" />
        <div className="flex gap-2 sm:pt-7">
          <Button type="submit" variant="primary" icon={Target} loading={editor.busy} loadingLabel="Saving…">Save goal</Button>
          {goal !== null && <Button variant="ghost" onClick={() => void editor.save(true)} disabled={editor.busy}>Remove</Button>}
        </div>
      </form>
    </Group>
  );
}

/* ── People to skip ───────────────────────────────────────────────────── */

function SkipSection() {
  const list = useIgnoreList();
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const handles = list.data ?? [];
  const save = (next: string[], done: string) => void toastAction(() => appStore.setIgnoreList(next), { success: done, fallback: "Couldn't save the list. Try again." });
  const add = () => {
    const clean = handle.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(clean)) { setError("Enter an Instagram handle, like cousin.aarav"); return; }
    if (handles.includes(clean)) { setError(`@${clean} is already on the list.`); return; }
    setError(null);
    setHandle("");
    save([...handles, clean], `DMs from @${clean} will be skipped.`);
  };

  return (
    <Group id="skip" title="People to skip" description="Friends and family. Their DMs never get drafts or show up as money.">
      <div className="px-4 py-4 md:px-5">
        {handles.length > 0 ? (
          <ul className="mb-4 flex flex-wrap gap-2">
            {handles.map((item) => (
              <li key={item} className="inline-flex h-9 items-center gap-1 rounded-full bg-inset pl-3 pr-1 text-[14px] font-semibold text-ink">
                @{item}
                <button type="button" aria-label={`Stop skipping @${item}`} onClick={() => save(handles.filter((entry) => entry !== item), `@${item} removed from the list.`)} className="dd-press flex h-7 w-7 items-center justify-center rounded-full text-ink-3 hover:bg-fill hover:text-ink">
                  <X aria-hidden size={15} />
                </button>
              </li>
            ))}
          </ul>
        ) : list.data && <p className="mb-4 text-body text-ink-2">Nobody yet.</p>}
        <form className="flex items-start gap-2" onSubmit={(event) => { event.preventDefault(); add(); }}>
          <TextField label="Instagram handle" hideLabel placeholder="@handle" value={handle} autoCapitalize="none" autoCorrect="off" onChange={(event) => setHandle(event.target.value)} error={error} className="flex-1" />
          <Button type="submit" variant="secondary" icon={AtSign}>Add</Button>
        </form>
      </div>
    </Group>
  );
}

/* ── Team ──────────────────────────────────────────────────────────────── */

function TeamSection() {
  const settings = useSettings().data!;
  const seats = useSeats();
  const me = useMe();
  const canManage = useCan("manage_seats");
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const limit = TIER_LIMITS[settings.tier].seats;
  const count = seats.data?.length ?? 0;
  const full = limit !== null && count >= limit;

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    if (await toastAction(() => appStore.removeSeat(removing.id), { success: `${removing.label} no longer has access.`, fallback: "Couldn't remove them. Try again." })) setRemoving(null);
    setBusy(false);
  };

  return (
    <Group
      id="team"
      title="Team"
      description={limit === null ? "Add managers and assistants for every creator." : `${count} of ${limit} ${pluralize(limit, "seat")} on the ${tierText(settings.tier)} plan`}
      action={canManage && !full ? <Button variant="ghost" size="sm" icon={UserPlus} onClick={() => setInviting(true)}>Invite</Button> : undefined}
    >
      {!seats.data ? <div className="p-4"><Skeleton className="h-16" /></div> : (
        <ul>
          {seats.data.map((seat, index) => {
            const label = seat.name ?? seat.email;
            const isMe = me.data?.email === seat.email;
            return (
              <li key={seat.id}>
                {index > 0 && <Divider />}
                <div className="flex items-center gap-3 px-4 py-3 md:px-5">
                  <Avatar handle={seat.email} name={seat.name} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold text-ink">{label}{isMe && <span className="font-normal text-ink-3"> (you)</span>}</p>
                    <p className="truncate text-caption text-ink-3">{roleText(seat.role)}{seat.name ? ` · ${seat.email}` : ""}</p>
                  </div>
                  {!seat.activated && <Tag tone="waiting">Invited</Tag>}
                  {canManage && seat.role !== "creator" && !isMe && (
                    <Button variant="ghost" size="sm" onClick={() => setRemoving({ id: seat.id, label })}>Remove</Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {full && canManage && <p className="border-t border-hairline px-4 py-3 text-caption text-ink-2 md:px-5">Your plan is full. <a href="#plan" className="font-semibold text-brand">Change plan</a> to add more people.</p>}
      <InviteSheet open={inviting} onClose={() => setInviting(false)} />
      <ConfirmDialog open={removing !== null} onClose={() => setRemoving(null)} title={`Remove ${removing?.label ?? ""}?`} confirmLabel="Remove" destructive busy={busy} busyLabel="Removing…" onConfirm={() => void remove()}>
        They lose access right away. Everything they sent stays in Activity.
      </ConfirmDialog>
    </Group>
  );
}

const ROLE_HELP: Record<"assistant" | "manager", string> = {
  assistant: "Replies, sorts messages and records sales. Can't change settings or export data.",
  manager: "Works across every creator, manages the team and exports reports. Can't change billing or delete the account.",
};

function InviteSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"assistant" | "manager">("assistant");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) { setEmail(""); setName(""); setRole("assistant"); setError(null); } }, [open]);

  const send = async () => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { setError("Enter their email address."); return; }
    setBusy(true);
    setError(null);
    try {
      await appStore.inviteSeat({ email: email.trim(), name: name.trim() || undefined, role });
      toast(`Invite sent to ${email.trim()}.`, { tone: "success" });
      onClose();
    } catch (failure) {
      setError(errorMessage(failure, "Couldn't send the invite. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Invite someone"
      dirty={Boolean(email || name) && !busy}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" icon={UserPlus} onClick={() => void send()} loading={busy} loadingLabel="Sending…">Send invite</Button></>}
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <TextField label="Email" type="email" autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} error={error} />
        <TextField label="Name, optional" value={name} onChange={(event) => setName(event.target.value)} />
        <div className="flex flex-col gap-1.5">
          <span className="text-label text-ink">Role</span>
          <Segmented label="Role" value={role} onChange={setRole} options={[{ value: "assistant", label: "Assistant" }, { value: "manager", label: "Manager" }]} className="self-start" />
          <p className="text-caption text-ink-3">{ROLE_HELP[role]}</p>
        </div>
        <p className="text-caption text-ink-3">Every reply still needs a person to approve it, and Activity shows who sent what.</p>
      </form>
    </Sheet>
  );
}

/* ── Plan ──────────────────────────────────────────────────────────────── */

function PlanSection() {
  const billing = useBilling();
  const settings = useSettings().data!;
  const canBill = useCan("manage_billing");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const data = billing.data;
  const date = (at: string | null) => (at ? formatDate(at, settings.locale, settings.timezone) : null);
  const status = !data ? null
    : data.status === "active" ? { text: data.currentPeriodEnd ? `Active · renews ${date(data.currentPeriodEnd)}` : "Active", tone: "money" as const }
    : data.status === "past_due" ? { text: "Payment due", tone: "danger" as const }
    : data.status === "cancelled" ? { text: data.currentPeriodEnd ? `Cancelled · access until ${date(data.currentPeriodEnd)}` : "Cancelled", tone: "neutral" as const }
    : data.status === "pilot_manual" ? { text: "Pilot · billed by invoice", tone: "info" as const }
    : data.status === "pending_first_invoice" ? { text: "First invoice coming", tone: "info" as const }
    : { text: data.status, tone: "neutral" as const };

  const cancel = async () => {
    setBusy(true);
    if (await toastAction(() => appStore.cancelBilling(), { success: "Cancelled. You keep access until the end of the paid period.", fallback: "Couldn't cancel right now. Try again." })) setConfirm(false);
    setBusy(false);
  };

  return (
    <Group id="plan" title="Plan">
      <Row
        icon={CreditCard}
        tile="bg-brand"
        title={`${tierText(data?.tier ?? settings.tier)} plan`}
        detail={status ? <span className={cx(status.tone === "danger" && "font-semibold text-danger")}>{status.text}{data?.rail ? ` · ${data.rail === "razorpay" ? "Razorpay" : "Paddle"}` : ""}</span> : <Skeleton className="h-4 w-40" />}
        trailing={data?.checkoutUrl ? <a href={data.checkoutUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses({ variant: "primary", size: "sm" })}>{data.status === "past_due" ? "Pay now" : "Payment page"}</a> : undefined}
      />
      {canBill && data && data.status !== "cancelled" && data.rail && (
        <>
          <Divider />
          <div className="flex items-center justify-between gap-3 px-4 py-3 md:px-5">
            <p className="text-caption text-ink-3">Cancel any time. Your revenue history stays available to export.</p>
            <Button variant="danger-ghost" size="sm" className="shrink-0" onClick={() => setConfirm(true)}>Cancel plan</Button>
          </div>
        </>
      )}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title="Cancel your plan?" confirmLabel="Cancel plan" cancelLabel="Keep plan" destructive busy={busy} busyLabel="Cancelling…" onConfirm={() => void cancel()}>
        You keep everything until the end of the period you&apos;ve paid for. After that DealDock stops reading new DMs, and your revenue ledger stays available to download.
      </ConfirmDialog>
    </Group>
  );
}

/* ── Appearance ───────────────────────────────────────────────────────── */

function AppearanceSection() {
  const prefs = useUiPrefs();
  return (
    <Group id="appearance" title="Appearance & sending">
      <div className="flex flex-col gap-4 px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex items-center gap-3 text-body text-ink"><span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-ink text-canvas"><Moon aria-hidden size={16} /></span>Theme</span>
          <Segmented<ThemePreference> label="Theme" value={prefs.theme} onChange={(value) => setUiPref("theme", value)} options={[{ value: "system", label: "Auto" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-body text-ink">Time to undo a send</p>
            <p className="text-caption text-ink-3">Replies wait this long before going to Instagram.</p>
          </div>
          <Segmented<"5" | "10" | "20"> label="Time to undo a send" value={String(prefs.undoSeconds) as "5" | "10" | "20"} onChange={(value) => setUiPref("undoSeconds", Number(value) as UndoSeconds)} options={[{ value: "5", label: "5 sec" }, { value: "10", label: "10 sec" }, { value: "20", label: "20 sec" }]} />
        </div>
        <Switch checked={prefs.singleKeyShortcuts} onChange={(value) => setUiPref("singleKeyShortcuts", value)} label="Single-key shortcuts" description="Like E to edit or W to move to waiting, on a keyboard." />
      </div>
    </Group>
  );
}

function ActivityLink() {
  return (
    <Link href="/activity" className="dd-press hidden items-center gap-3 rounded-[20px] bg-surface px-4 py-3.5 shadow-card hover:bg-inset md:px-5 lg:flex">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-review text-white"><Activity aria-hidden size={17} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-ink">Activity</span>
        <span className="block text-caption text-ink-3">Who sent what, and every change to settings.</span>
      </span>
      <ChevronRight aria-hidden size={18} className="text-ink-3" />
    </Link>
  );
}

/* ── Your data ─────────────────────────────────────────────────────────── */

function DataSection() {
  const settings = useSettings().data!;
  const summary = useDataSummary();
  const me = useMe();
  const canExport = useCan("export_data");
  const isCreator = me.data?.role === "creator";
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<"json" | "csv" | "delete" | "cancel" | null>(null);
  const requested = settings.deletionRequestedAt;
  const deletesOn = requested ? formatDate(Date.parse(requested) + 7 * 24 * 60 * 60 * 1000, settings.locale, settings.timezone) : null;
  const data = summary.data;

  const download = async (kind: "json" | "csv") => {
    setBusy(kind);
    await toastAction(() => (kind === "json" ? appStore.download("/settings/export", "dealdock-export.json") : appStore.download("/ledger/export.csv", "dealdock-revenue.csv")), { success: kind === "json" ? "Your archive is downloading." : "Your revenue is downloading.", fallback: "The download didn't start. Try again." });
    setBusy(null);
  };
  const schedule = async () => {
    setBusy("delete");
    if (await toastAction(() => appStore.scheduleDeletion(), { success: "Deletion scheduled. You can cancel it for 7 days.", fallback: "Couldn't schedule deletion. Try again." })) setConfirm(false);
    setBusy(null);
  };
  const cancel = async () => {
    setBusy("cancel");
    await toastAction(() => appStore.cancelDeletion(), { success: "Deletion cancelled. Nothing was removed.", fallback: "Couldn't cancel deletion. Try again." });
    setBusy(null);
  };

  return (
    <Group id="data" title="Your data" description="Everything DealDock keeps, and how to take it with you.">
      {requested && (
        <div className="flex flex-wrap items-center gap-3 border-b border-hairline bg-danger-tint px-4 py-3 md:px-5">
          <AlertTriangle aria-hidden size={18} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-[14px] font-semibold text-danger">Everything will be deleted on {deletesOn}.</p>
          {isCreator && <Button size="sm" variant="secondary" loading={busy === "cancel"} loadingLabel="Cancelling…" onClick={() => void cancel()}>Cancel deletion</Button>}
        </div>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-4 md:px-5">
        {([["Messages read", data?.messagesProcessed], ["Drafts written", data?.draftsGenerated], ["Sales recorded", data?.ledgerEntries], ["Activity entries", data?.auditRows]] as const).map(([label, value]) => (
          <div key={label}>
            <dt className="text-caption text-ink-3">{label}</dt>
            <dd className="mt-0.5 text-[20px] font-semibold tabular-nums text-ink">{value === undefined ? <Skeleton className="h-6 w-12" /> : value.toLocaleString(settings.locale)}</dd>
          </div>
        ))}
      </dl>
      {data?.storingSince && <p className="px-4 pb-3 text-caption text-ink-3 md:px-5">Storing since {formatDate(data.storingSince, settings.locale, settings.timezone)}. Messages are kept only as long as you&apos;re a customer.</p>}
      {canExport !== false && (
        <>
          <Divider />
          <div className="flex flex-wrap gap-2 px-4 py-3 md:px-5">
            <Button variant="secondary" size="sm" icon={Download} loading={busy === "json"} loadingLabel="Preparing…" onClick={() => void download("json")}>Download everything</Button>
            <Button variant="secondary" size="sm" icon={Database} loading={busy === "csv"} loadingLabel="Preparing…" onClick={() => void download("csv")}>Download revenue (CSV)</Button>
          </div>
        </>
      )}
      {isCreator && !requested && (
        <>
          <Divider />
          <div className="flex items-center justify-between gap-3 px-4 py-3 md:px-5">
            <p className="text-caption text-ink-3">Deletes your workspace, messages and revenue after a 7-day grace period.</p>
            <Button variant="danger-ghost" size="sm" icon={Trash2} className="shrink-0" onClick={() => setConfirm(true)}>Delete account</Button>
          </div>
        </>
      )}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title="Delete your account and data?" confirmLabel="Schedule deletion" destructive busy={busy === "delete"} busyLabel="Scheduling…" onConfirm={() => void schedule()}>
        DealDock stops reading DMs now and deletes everything in 7 days: conversations, drafts, your voice and revenue. Sign in before then to cancel. Download your data first if you want a copy.
      </ConfirmDialog>
    </Group>
  );
}
