"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { CURRENCY_SYMBOL, DEFAULT_LOCALE, TIER_LIMITS, parseMoneyInput } from "@dealdock/core";
import { Activity, AlertTriangle, AtSign, AudioLines, Bell, ChevronRight, CreditCard, Database, Download, Globe2, LogOut, Mail, Moon, MoreHorizontal, Pencil, Plus, Tags, Target, Trash2, Unplug, UserPlus, UsersRound, X, type LucideIcon } from "lucide-react";
import { businessFacts, creatorAnswers, profileFor, withCreatorProfile, type BusinessFacts } from "../../lib/business-profile";
import { agoText, formatDate, pluralize, roleText, tierText } from "../../lib/format";
import { useMinuteClock } from "../../lib/keyboard";
import { SETTINGS_SECTIONS } from "../../lib/settings-sections";
import { errorMessage } from "../../lib/snapshot";
import { appStore, useApp, useBilling, useCan, useDataSummary, useEmailAccounts, useIgnoreList, useMe, useMoneyContext, useNotificationPrefs, useOnboarding, useSeats, useSettings } from "../../lib/use-demo";
import type { EmailAccountView } from "../../lib/types";
import { setUiPref, useUiPrefs, type ThemePreference, type UndoSeconds } from "../../lib/ui-prefs";
import { useAuthActions } from "../../components/auth-session";
import { BillingSection } from "../../components/billing";
import { CommentKeywordsSection } from "../../components/comment-leads";
import { LeadSourcesSection } from "../../components/lead-sources";
import { GoalField, useGoalEditor } from "../../components/goal-editor";
import { Group, LargeTitle, Tag } from "../../components/kit";
import { enablePush, pushConfigured } from "../../components/pwa";
import { Button, buttonClasses } from "../../components/ui/button";
import { cx } from "../../components/ui/cx";
import { ErrorState, Skeleton } from "../../components/ui/feedback";
import { MONEY_INPUT_ERROR, MoneyField, Select, Switch, TextField, moneyFieldText } from "../../components/ui/field";
import { Menu } from "../../components/ui/menu";
import { MoneyValue } from "../../components/ui/money-value";
import { Chip, Segmented } from "../../components/ui/selection";
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
  const [activeSection, setActiveSection] = useState("");
  const sectionsReady = Boolean(settings.data);

  useEffect(() => {
    const syncSection = () => {
      const id = window.location.hash.slice(1);
      setActiveSection(SETTINGS_SECTIONS.some((section) => section.id === id) ? id : "");
    };
    syncSection();
    window.addEventListener("hashchange", syncSection);
    return () => window.removeEventListener("hashchange", syncSection);
  }, []);
  useEffect(() => {
    if (sectionsReady && activeSection) document.getElementById(activeSection)?.scrollIntoView({ block: "start" });
  }, [sectionsReady, activeSection]);

  return (
    <div className="mx-auto w-full max-w-[1100px] pb-16">
      <LargeTitle title="Settings" subtitle="Manage your workspace, preferences and data." />
      <div className="px-4 md:px-8 lg:grid lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-10">
        <div className="mb-5 lg:hidden">
          <Select label="Jump to a setting" value={activeSection} disabled={!sectionsReady} onChange={(event) => {
            const id = event.target.value;
            if (!SETTINGS_SECTIONS.some((section) => section.id === id)) return;
            window.history.replaceState(null, "", `#${id}`);
            setActiveSection(id);
          }}>
            <option value="" disabled>Choose a section…</option>
            {SETTINGS_SECTIONS.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
          </Select>
        </div>
        <nav aria-label="Settings sections" className="hidden lg:block">
          <div className="sticky top-6"><ul className="flex flex-col gap-0.5">
            {SETTINGS_SECTIONS.map((section) => (
              <li key={section.id}><a href={`#${section.id}`} aria-current={activeSection === section.id ? "location" : undefined} className={cx("flex min-h-11 items-center rounded-xl px-3 py-2 text-[14px] font-medium text-ink-2 hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-info", activeSection === section.id && "bg-surface text-ink shadow-card hover:bg-surface")}>{section.label}</a></li>
            ))}
            <li><Link href="/activity" className="flex min-h-11 items-center rounded-xl px-3 py-2 text-[14px] font-medium text-ink-2 hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-info">Activity</Link></li>
          </ul></div>
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
              <EmailSection />
              <CommentKeywordsSection />
              <BusinessSection />
              <BillingSection />
              <LeadSourcesSection />
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
    <div className={cx("flex min-h-14 flex-wrap items-center gap-3 px-4 py-3 md:px-5", className)}>
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
    <section aria-label="Your profile" className="flex flex-wrap items-center gap-3 rounded-[24px] bg-surface p-4 shadow-card md:gap-4 md:p-5">
      {me.data ? <Avatar handle={name ?? "you"} name={name} size={56} /> : <Skeleton className="h-14 w-14 rounded-full" />}
      <div className="min-w-[150px] flex-1">
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

/* ── Email ─────────────────────────────────────────────────────────────── */

/** Google sends people back with ?email_error=<code>; each gets a plain sentence. */
const EMAIL_ERRORS: Record<string, string> = {
  access_denied: "Google access wasn't allowed, so no inbox was connected.",
  oauth_failed: "Google couldn't finish connecting. Try again.",
  invalid_state: "That connection link expired. Start again here.",
  scopes_missing: "DealDock needs permission to read and send email. Connect again and keep both boxes ticked.",
  connection_failed: "Gmail couldn't be connected. Try again.",
  email_account_limit: "Your plan can't connect another inbox. Disconnect one first.",
  email_connected_to_other_creator: "That inbox is already connected for another creator.",
  account_connected_to_other_org: "That inbox is connected to another DealDock workspace.",
  ig_account_not_in_org: "That creator isn't in this workspace any more.",
};

/**
 * Gmail inboxes, each belonging to a creator. Connecting goes to Google and
 * comes back here; on Roster the creator is chosen first. Hidden once the API
 * says email isn't set up for this deployment.
 */
function EmailSection() {
  const router = useRouter();
  const settings = useSettings().data!;
  const inboxes = useEmailAccounts();
  const canManage = useCan("manage_settings");
  const now = useMinuteClock();
  const { locale, timezone } = useMoneyContext();
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<EmailAccountView | null>(null);
  const roster = settings.tier === "roster" && settings.accounts.length > 1;
  const creators = settings.accounts.filter((account) => account.status !== "disconnected");
  const creatorOf = (id: string | null) => settings.accounts.find((account) => account.id === id)?.handle;

  // Back from Google: say what happened once, then drop the flag from the address.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("email_error");
    if (params.get("email") !== "connected" && !error) return;
    if (error) toast(EMAIL_ERRORS[error] ?? "Gmail couldn't be connected. Try again.", { tone: "error" });
    else toast("Gmail connected. Its emails show up in your inbox in a few minutes.", { tone: "success" });
    router.replace("/settings#email", { scroll: false });
  }, [router]);

  const connect = async (igAccountId?: string) => {
    setBusy(igAccountId ?? "new");
    try {
      const { authorizeUrl } = await appStore.connectEmail(igAccountId);
      window.location.assign(authorizeUrl);
    } catch (failure) {
      toast(errorMessage(failure, "Couldn't open Google. Try again."), { tone: "error" });
      setBusy(null);
    }
  };
  const disconnect = async () => {
    if (!disconnecting) return;
    setBusy(disconnecting.id);
    if (await toastAction(() => appStore.disconnectEmail(disconnecting.id), { success: `${disconnecting.address} disconnected.`, fallback: "Couldn't disconnect. Try again." })) setDisconnecting(null);
    setBusy(null);
  };

  if (inboxes.data?.available === false) return null;
  const accounts = inboxes.data?.accounts ?? [];
  const addRow = (label: string) => (
    <>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-tint text-recovered"><Plus aria-hidden size={18} /></span>
      <span className="text-[15px] font-semibold text-brand">{label}</span>
    </>
  );
  const addLabel = accounts.length ? "Connect another Gmail inbox" : "Connect Gmail";
  return (
    <Group id="email" title="Email" description="Bring brand emails into the same inbox. DealDock reads your primary inbox and sends only the replies you approve.">
      {inboxes.status === "error" && !inboxes.data ? (
        <ErrorState thing="your email inboxes" reason={inboxes.error} onRetry={() => void appStore.loadEmailAccounts()} />
      ) : !inboxes.data ? <div className="p-4"><Skeleton className="h-12" /></div> : (
        <>
          <ul>
            {accounts.map((inbox, index) => {
              const healthy = inbox.status === "active";
              const creator = roster ? creatorOf(inbox.ownerAccountId) : null;
              return (
                <li key={inbox.id}>
                  {index > 0 && <Divider />}
                  <div className="flex items-center gap-3 px-4 py-3 md:px-5">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-info-tint text-info"><Mail aria-hidden size={18} /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-semibold text-ink"><bdi>{inbox.address}</bdi></p>
                      <p className="text-caption">
                        {creator && <span className="text-ink-2">For @{creator} · </span>}
                        {healthy
                          ? <><span className="font-semibold text-recovered">Connected</span>{inbox.lastSyncedAt && now > 0 && <span className="text-ink-3"> · synced {agoText(Date.parse(inbox.lastSyncedAt), now, locale, timezone)}</span>}</>
                          : <span className="inline-flex items-center gap-1 font-semibold text-waiting"><AlertTriangle aria-hidden size={13} />Reconnect needed</span>}
                      </p>
                    </div>
                    {canManage !== false && !healthy && <Button variant="primary" size="sm" loading={busy === inbox.ownerAccountId} loadingLabel="Opening…" onClick={() => void connect(inbox.ownerAccountId ?? undefined)}>Reconnect</Button>}
                    {canManage !== false && <Menu label={`More for ${inbox.address}`} icon={MoreHorizontal} items={[{ label: "Disconnect", icon: Unplug, destructive: true, onSelect: () => setDisconnecting(inbox) }]} />}
                  </div>
                </li>
              );
            })}
          </ul>
          {canManage !== false && creators.length > 0 && (
            <>
              {accounts.length > 0 && <Divider />}
              {roster ? (
                <Menu
                  label={addLabel}
                  header="Whose inbox is it?"
                  items={creators.map((account) => ({ label: `@${account.handle}`, onSelect: () => void connect(account.id) }))}
                  trigger={({ "aria-label": _name, ...props }) => (
                    <button type="button" {...props} disabled={busy !== null} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-inset disabled:opacity-60 md:px-5">{addRow(addLabel)}</button>
                  )}
                />
              ) : (
                <button type="button" onClick={() => void connect()} disabled={busy !== null} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-inset disabled:opacity-60 md:px-5">{addRow(addLabel)}</button>
              )}
            </>
          )}
          {creators.length === 0 && <p className="px-4 py-3 text-caption text-ink-2 md:px-5">Connect Instagram first: each inbox belongs to a creator.</p>}
        </>
      )}
      <ConfirmDialog open={disconnecting !== null} onClose={() => setDisconnecting(null)} title={`Disconnect ${disconnecting?.address ?? "this inbox"}?`} confirmLabel="Disconnect" destructive busy={busy !== null} busyLabel="Disconnecting…" onConfirm={() => void disconnect()}>
        DealDock stops reading this inbox and deletes its access. Email conversations already here stay, and you can reconnect any time.
      </ConfirmDialog>
    </Group>
  );
}

/* ── What you sell ────────────────────────────────────────────────────── */

/** The same choices onboarding offers; values saved earlier stay selectable even if they differ. */
const SELLS = ["Brand collaborations", "1:1 coaching", "Group programs", "Courses or cohorts", "Workshops and talks", "Consulting", "Products"];


/**
 * What the workspace sells and its usual prices: set in onboarding, editable here. Estimates for new
 * conversations use it; exact prices for drafts live in Offers. One profile per workspace for now.
 */
function BusinessSection() {
  const onboarding = useOnboarding();
  const settings = useSettings().data!;
  const canManage = useCan("manage_settings");
  const [editing, setEditing] = useState(false);
  // Roster only: a creator's own profile, or "" for the workspace's.
  const roster = settings.tier === "roster" && settings.accounts.length > 1;
  const [scope, setScope] = useState("");
  const creator = roster ? settings.accounts.find((account) => account.id === scope) ?? null : null;
  const context = onboarding.data?.businessContext ?? null;
  const facts = profileFor(context, creator?.id ?? null);
  const fromWorkspace = (key: keyof BusinessFacts) => facts.inherited.has(key);
  const rows = [
    { key: "brand", label: "Brand deal", hint: "Per campaign", range: facts.brand },
    { key: "coaching", label: "Coaching", hint: "Per package", range: facts.coaching },
    { key: "course", label: "Course", hint: "Per seat", range: facts.course },
  ] as const;
  return (
    <Group
      id="business"
      title="What you sell"
      description={<>How DealDock recognises your leads and estimates new conversations. Drafts quote the exact prices in <Link href="/offers" className="font-medium text-ink underline decoration-separator underline-offset-2 hover:decoration-ink-3">Offers</Link>.</>}
      action={canManage && onboarding.data ? <Button variant="ghost" size="sm" icon={Pencil} aria-label={creator ? `Edit what @${creator.handle} sells` : undefined} onClick={() => setEditing(true)}>Edit</Button> : undefined}
    >
      {onboarding.status === "error" && !onboarding.data ? (
        <ErrorState thing="what you sell" reason={onboarding.error} onRetry={() => void appStore.loadOnboarding()} />
      ) : !onboarding.data ? <div className="p-4"><Skeleton className="h-24" /></div> : (
        <>
          {roster && (
            <>
              <div className="px-4 pb-3 pt-3 md:px-5">
                <Select label="Profile for" value={scope} onChange={(event) => setScope(event.target.value)} helper={creator ? "Anything this creator leaves empty uses the workspace's answer." : "Every creator uses these unless they have their own."}>
                  <option value="">Workspace (all creators)</option>
                  {settings.accounts.map((account) => <option key={account.id} value={account.id}>@{account.handle}</option>)}
                </Select>
              </div>
              <Divider />
            </>
          )}
          <div className="px-4 py-3 md:px-5">
            <p className="text-[15px] leading-5 text-ink">{facts.summary || <span className="text-ink-3">No description yet.</span>}</p>
            {facts.sells.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{facts.sells.map((item) => <Tag key={item}>{item}</Tag>)}</div>}
            {creator && (fromWorkspace("summary") || fromWorkspace("sells")) && <p className="mt-2 text-caption text-ink-3">{fromWorkspace("summary") && fromWorkspace("sells") ? "From the workspace profile" : fromWorkspace("summary") ? "Description from the workspace profile" : "Offerings from the workspace profile"}</p>}
          </div>
          {rows.map((row) => (
            <Fragment key={row.label}>
              <Divider />
              <Row
                title={row.label}
                detail={creator && row.range && fromWorkspace(row.key) ? `${row.hint} · workspace price` : row.hint}
                trailing={row.range
                  ? <MoneyValue minor={row.range.min} maxMinor={row.range.max === row.range.min ? undefined : row.range.max} mode={row.range.max === row.range.min ? "exact" : "range"} className="text-[15px] font-semibold text-ink" />
                  : <span className="text-label text-ink-3">Not set</span>}
              />
            </Fragment>
          ))}
        </>
      )}
      {editing && <BusinessSheet context={context} creator={creator} onClose={() => setEditing(false)} />}
    </Group>
  );
}

/** The workspace profile, or one creator's own answers on Roster (empty means "use the workspace's"). */
function BusinessSheet({ context, creator, onClose }: { context: Record<string, unknown> | null; creator: { id: string; handle: string } | null; onClose: () => void }) {
  const { money, timezone } = useApp();
  const workspace = businessFacts(context);
  const facts = creator ? businessFacts(creatorAnswers(context, creator.id)) : workspace;
  const initial = {
    summary: facts.summary,
    sells: facts.sells,
    brandMin: moneyFieldText(facts.brand?.min),
    brandMax: moneyFieldText(facts.brand && facts.brand.max !== facts.brand.min ? facts.brand.max : null),
    coaching: moneyFieldText(facts.coaching?.min),
    course: moneyFieldText(facts.course?.min),
  };
  // A creator's empty field shows the workspace's answer it falls back to.
  const fallback = creator ? {
    summary: workspace.summary,
    brandMin: moneyFieldText(workspace.brand?.min),
    brandMax: moneyFieldText(workspace.brand && workspace.brand.max !== workspace.brand.min ? workspace.brand.max : null),
    coaching: moneyFieldText(workspace.coaching?.min),
    course: moneyFieldText(workspace.course?.min),
  } : null;
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<"brandMin" | "brandMax" | "coaching" | "course", string>>>({});
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const choices = [...SELLS, ...[...facts.sells, ...workspace.sells].filter((item, index, all) => !SELLS.includes(item) && all.indexOf(item) === index)];
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }));

  const save = async () => {
    const parsed = {
      brandMin: form.brandMin ? parseMoneyInput(form.brandMin) : null,
      brandMax: form.brandMax ? parseMoneyInput(form.brandMax) : null,
      coaching: form.coaching ? parseMoneyInput(form.coaching) : null,
      course: form.course ? parseMoneyInput(form.course) : null,
    };
    const next: typeof errors = {};
    for (const key of ["brandMin", "brandMax", "coaching", "course"] as const) if (form[key] && !parsed[key]) next[key] = MONEY_INPUT_ERROR;
    if (parsed.brandMax && !parsed.brandMin) next.brandMin = "Add the starting price too.";
    if (parsed.brandMin && parsed.brandMax && parsed.brandMax < parsed.brandMin) next.brandMax = "This should be at least the starting price.";
    setErrors(next);
    if (Object.keys(next).length) return;
    const single = (minor: number | null) => (minor ? { min: minor, max: minor } : null);
    const brand = parsed.brandMin ? { min: parsed.brandMin, max: parsed.brandMax ?? parsed.brandMin } : null;
    let businessContext: Record<string, unknown>;
    if (creator) {
      businessContext = withCreatorProfile(context, creator.id, { summary: form.summary, sells: form.sells, brand, coaching: single(parsed.coaching), course: single(parsed.course) });
    } else {
      // Keeps any other answers onboarding saved (creators' own profiles included); only these fields change.
      businessContext = {
        ...(context ?? {}),
        businessSummary: form.summary.trim() || "Creator selling " + (form.sells.join(", ").toLowerCase() || "brand collaborations") + ".",
        sells: form.sells,
        typicalBrandDealMinor: brand,
        typicalCoachingMinor: single(parsed.coaching),
        typicalCourseMinor: single(parsed.course),
      };
    }
    setBusy(true);
    try {
      await appStore.saveOnboarding({
        businessContext,
        currencyCode: money.currency,
        locale: money.locale ?? DEFAULT_LOCALE[money.currency],
        timezone,
      });
      toast(creator ? `Saved for @${creator.handle}. Their new conversations are estimated with these answers.` : "Saved. New conversations are estimated with these prices.", { tone: "success" });
      onClose();
    } catch (failure) {
      toast(errorMessage(failure, "Couldn't save that. Try again."), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={creator ? `What @${creator.handle} sells` : "What you sell"}
      description={creator ? "Only what's different for this creator. Anything left empty uses the workspace's answer." : "Used to recognise your leads and estimate new conversations. Drafts quote exact prices from Offers."}
      dirty={dirty && !busy}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} loadingLabel="Saving…" onClick={() => void save()}>Save</Button></>}
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div role="group" aria-label="What you sell" className="flex flex-wrap gap-1.5">
          {choices.map((item) => {
            const on = form.sells.includes(item);
            return <Chip key={item} pressed={on} onClick={() => set("sells", on ? form.sells.filter((value) => value !== item) : [...form.sells, item])}>{item}</Chip>;
          })}
        </div>
        {creator && form.sells.length === 0 && workspace.sells.length > 0 && <p className="-mt-2 text-caption text-ink-3">None picked: uses the workspace&apos;s ({workspace.sells.join(", ")}).</p>}
        <TextField label={creator ? "In one line, what do they do?" : "In one line, what do you do?"} value={form.summary} maxLength={160} placeholder={fallback?.summary || undefined} onChange={(event) => set("summary", event.target.value)} helper={creator ? "Empty uses the workspace description." : "Like “Fitness coach with a 12-week program and a strength course”."} />
        <fieldset className="rounded-2xl border border-separator p-3">
          <legend className="px-1 text-label font-semibold text-ink">Usual prices</legend>
          <div className="grid grid-cols-2 gap-3">
            <MoneyField label="Brand deal from" optional value={form.brandMin} placeholder={fallback?.brandMin || undefined} onChange={(text) => set("brandMin", text)} error={errors.brandMin} />
            <MoneyField label="Up to" optional value={form.brandMax} placeholder={fallback?.brandMax || undefined} onChange={(text) => set("brandMax", text)} error={errors.brandMax} />
            <MoneyField label="Coaching package" optional value={form.coaching} placeholder={fallback?.coaching || undefined} onChange={(text) => set("coaching", text)} error={errors.coaching} />
            <MoneyField label="Course seat" optional value={form.course} placeholder={fallback?.course || undefined} onChange={(text) => set("course", text)} error={errors.course} />
          </div>
          <p className="mt-2 text-caption text-ink-3">{creator ? "Empty prices use the workspace's (shown faded). Conversations already estimated keep their estimate." : "Leave a price empty if you don't sell it. Conversations already estimated keep their estimate."}</p>
        </fieldset>
      </form>
    </Sheet>
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
        tile={canPush ? "bg-danger" : "bg-ink-3"}
        title="This device"
        detail={data?.subscribed ? "Gets DealDock notifications." : canPush ? "Not getting notifications yet." : "Push notifications are not configured or supported on this device."}
        trailing={canPush ? <Button size="sm" variant={data?.subscribed ? "ghost" : "primary"} loading={busy} loadingLabel="Turning on…" onClick={() => void enable()}>{data?.subscribed ? "Enable or reconnect this device" : "Enable notifications on this device"}</Button> : undefined}
      />
      <Divider />
      {!data ? <div className="p-4"><Skeleton className="h-24" /></div> : (
        <div className="flex flex-col gap-4 px-4 py-4 md:px-5">
          <Switch checked={data.notifyHighValue} onChange={(value) => set("notifyHighValue", value)} label="Big money DMs" description="A brand or high-value lead messages you." />
          <Switch checked={data.notifyNudge} onChange={(value) => set("notifyNudge", value)} label="Follow-up reminders" description="Someone hasn't replied and it's time to check in." />
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
        {([["Messages read", data?.messagesProcessed], ["Drafts written", data?.draftsGenerated], ["Sales recorded", data?.ledgerEntries], ["Deals", data?.deals], ["Invoices", data?.invoices], ["Billing details", data?.billingProfiles], ["Activity entries", data?.auditRows]] as const).map(([label, value]) => (
          <div key={label}>
            <dt className="text-caption text-ink-3">{label}</dt>
            <dd className="mt-0.5 text-[20px] font-semibold tabular-nums text-ink">{value === undefined ? <Skeleton className="h-6 w-12" /> : value.toLocaleString(settings.locale)}</dd>
          </div>
        ))}
      </dl>
      {data && data.emailInboxes.length > 0 && (
        <div className="px-4 pb-3 md:px-5">
          <p className="text-caption text-ink-3">Email inboxes</p>
          <ul className="mt-1 flex flex-col gap-1">
            {data.emailInboxes.map((inbox) => (
              <li key={inbox.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[14px]">
                <bdi className="min-w-0 break-all font-medium text-ink">{inbox.address}</bdi>
                <span className="text-caption text-ink-3">{inbox.status === "active" ? "Connected" : inbox.status === "token_expired" ? "Needs reconnecting" : "Disconnected"} · since {formatDate(inbox.connectedAt, settings.locale, settings.timezone)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
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
