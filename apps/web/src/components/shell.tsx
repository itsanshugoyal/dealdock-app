"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, type ReactNode } from "react";
import { LucideProvider } from "lucide-react";
import {
  AudioLines, ChartNoAxesCombined, ChevronsUpDown, CircleUser, House, Keyboard, LogOut, MessagesSquare, Monitor, Moon, Settings, Sun, Tag, TriangleAlert, UsersRound, type LucideIcon,
} from "lucide-react";
import { dispatchCommand } from "../lib/commands";
import { needsYou, roleText, tierText, toCheck } from "../lib/format";
import { setUiPref, useUiPrefs } from "../lib/ui-prefs";
import { cancelPendingActions, flushPendingActions } from "../lib/undo";
import { appStore, IS_DEMO_MODE, useApp, useMe, useSettings, type DemoThread } from "../lib/use-demo";
import { useAuthActions } from "./auth-session";
import { CommandPalette, SearchButton } from "./command-palette";
import { Logo } from "./kit";
import { KeyboardShortcuts } from "./shortcuts";
import { Button, buttonClasses } from "./ui/button";
import { cx } from "./ui/cx";
import { EmptyState, OfflineBanner } from "./ui/feedback";
import { Menu } from "./ui/menu";
import { Avatar } from "./ui/sender";
import { Toaster, toast } from "./ui/toast";

interface NavItem { href: string; label: string; icon: LucideIcon; match: (path: string) => boolean }

const PRIMARY: NavItem[] = [
  { href: "/", label: "Today", icon: House, match: (path) => path === "/" },
  { href: "/inbox", label: "Inbox", icon: MessagesSquare, match: (path) => path.startsWith("/inbox") || path.startsWith("/thread") || path.startsWith("/review") },
  { href: "/ledger", label: "Revenue", icon: ChartNoAxesCombined, match: (path) => path.startsWith("/ledger") },
];
const STUDIO: NavItem[] = [
  { href: "/voice", label: "Your voice", icon: AudioLines, match: (path) => path.startsWith("/voice") },
  { href: "/offers", label: "Offers", icon: Tag, match: (path) => path.startsWith("/offers") },
];
const CREATORS: NavItem = { href: "/roster", label: "All creators", icon: UsersRound, match: (path) => path.startsWith("/roster") };
const SETTINGS: NavItem = { href: "/settings", label: "Settings", icon: Settings, match: (path) => path.startsWith("/settings") || path.startsWith("/activity") };
const TABS: NavItem[] = [
  PRIMARY[0]!, PRIMARY[1]!, PRIMARY[2]!,
  { href: "/settings", label: "You", icon: CircleUser, match: (path) => ["/settings", "/voice", "/offers", "/activity", "/roster"].some((prefix) => path.startsWith(prefix)) },
];

/** Routes rendered without chrome. */
const CHROMELESS = ["/onboarding", "/sign-in", "/sign-up"];
/** Focused routes hide the phone tab bar (the conversation owns the bottom edge). */
const NO_TABS = ["/thread", "/review"];

/** The Inbox badge: conversations that need a reply plus messages to check (the inbox's own view filters). */
function needsYouCount(threads: DemoThread[]): number {
  return threads.filter(needsYou).length + threads.filter(toCheck).length;
}

/**
 * App shell: a desktop sidebar (icons at md, full at lg) and phone tab bar
 * (Today · Inbox · Revenue · You), the skip link to <main id="main-content">,
 * offline and error banners, the ⌘K palette, keyboard layer and toasts.
 * Screens render inside <main> and never render their own <main>.
 */
export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const { threads, state, error, workspaceName } = useApp();
  const chromeless = CHROMELESS.some((prefix) => pathname.startsWith(prefix));
  const badge = needsYouCount(threads);

  useShellEffects(pathname, workspaceName);

  const skip = (
    <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-full focus:bg-primary focus:px-4 focus:py-2 focus:text-label focus:text-on-primary">
      Skip to content
    </a>
  );
  const globals = (
    <>
      <Toaster />
      <CommandPalette />
      <KeyboardShortcuts />
    </>
  );

  if (chromeless) {
    return (
      <LucideProvider strokeWidth={1.9} size={20}>
        {skip}
        <main id="main-content" tabIndex={-1} className="min-h-dvh bg-canvas outline-none">{children}</main>
        {globals}
      </LucideProvider>
    );
  }

  const setupNeeded = !IS_DEMO_MODE && state === "error" && Boolean(error?.includes("needs setup"));
  const showTabs = !NO_TABS.some((prefix) => pathname.startsWith(prefix));
  return (
    <LucideProvider strokeWidth={1.9} size={20}>
      {skip}
      <div className="flex min-h-dvh bg-canvas">
        <Suspense fallback={<div className="hidden w-[76px] shrink-0 md:block lg:w-[var(--dd-sidebar-w)]" />}>
          <Sidebar pathname={pathname} badge={badge} />
        </Suspense>
        <div className={cx("flex min-w-0 flex-1 flex-col", showTabs && "pb-[calc(var(--dd-tabbar-h)+env(safe-area-inset-bottom))] md:pb-0")}>
          <OfflineBanner className="md:px-8" />
          {!IS_DEMO_MODE && state === "error" && !setupNeeded && (
            <div role="alert" className="mx-4 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-danger-tint px-4 py-3 text-body text-ink md:mx-8">
              <TriangleAlert aria-hidden size={18} className="shrink-0 text-danger" />
              <span className="min-w-0 flex-1">{error}</span>
              {error?.includes("session") && !IS_DEMO_MODE
                ? <Link href="/sign-in" className={buttonClasses({ size: "sm", variant: "primary" })}>Sign in</Link>
                : <Button size="sm" variant="primary" onClick={() => void appStore.refresh()}>Try again</Button>}
            </div>
          )}
          <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 outline-none">
            {setupNeeded ? (
              <EmptyState
                as="h1"
                title="Let's set up your workspace."
                description="Choose your currency and connect Instagram. It takes about four minutes."
                action={<Link href="/onboarding" className={buttonClasses({ variant: "primary", size: "lg" })}>Start setup</Link>}
                className="min-h-[60dvh] justify-center"
              />
            ) : children}
          </main>
        </div>
        {showTabs && <TabBar pathname={pathname} badge={badge} />}
      </div>
      {globals}
    </LucideProvider>
  );
}

/** Route changes flush pending non-send undo actions; account switches cancel them and say so. */
function useShellEffects(pathname: string, workspaceName: string | null) {
  const previousPath = useRef(pathname);
  const previousWorkspace = useRef<string | null>(null);
  useEffect(() => {
    if (previousPath.current !== pathname) flushPendingActions();
    previousPath.current = pathname;
  }, [pathname]);
  const { epoch } = useApp();
  const previousEpoch = useRef(epoch);
  useEffect(() => {
    if (previousEpoch.current !== epoch) cancelPendingActions("account");
    previousEpoch.current = epoch;
  }, [epoch]);
  useEffect(() => {
    if (!workspaceName) return;
    if (previousWorkspace.current && previousWorkspace.current !== workspaceName) toast(`Switched to ${workspaceName}.`);
    previousWorkspace.current = workspaceName;
  }, [workspaceName]);
}

function CountBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span aria-hidden className={cx("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1.5 text-[11px] font-bold leading-none text-on-danger tabular-nums", className)}>
      {count > 99 ? "99+" : count}
    </span>
  );
}
/** The count is part of the link's accessible name, never hidden behind aria-label. */
function needsYouText(count: number) {
  return count > 0 ? `, ${count > 99 ? "99+" : count} need you` : "";
}

function Sidebar({ pathname, badge }: { pathname: string; badge: number }) {
  const settings = useSettings();
  const { threads } = useApp();
  const search = useSearchParams();
  const roster = settings.data?.tier === "roster";
  const accounts = settings.data?.accounts ?? [];
  const activeAccount = search?.get("account") ?? null;

  const link = (item: NavItem, count = 0) => {
    const active = item.match(pathname) && !(item.href === "/inbox" && activeAccount);
    return (
      <Link
        key={item.href + item.label}
        href={item.href}
        aria-current={active ? "page" : undefined}
        title={item.label}
        className={cx(
          "dd-press relative flex h-10 items-center gap-3 rounded-xl px-3 text-[14px] font-medium",
          "max-lg:justify-center max-lg:px-0",
          active ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:bg-inset hover:text-ink",
        )}
      >
        <item.icon aria-hidden size={19} className={cx("shrink-0", active && "text-brand")} />
        <span className="max-lg:sr-only lg:flex-1">{item.label}<span className="sr-only">{needsYouText(count)}</span></span>
        <CountBadge count={count} className="max-lg:absolute max-lg:right-1 max-lg:top-0.5" />
      </Link>
    );
  };

  return (
    <aside className="sticky top-0 hidden h-dvh w-[76px] shrink-0 flex-col border-r border-hairline bg-canvas px-3 py-4 md:flex lg:w-[var(--dd-sidebar-w)] lg:px-4">
      <div className="flex items-center gap-2.5 px-1 max-lg:justify-center">
        <Link href="/" aria-label="DealDock, Today" className="rounded-[10px]"><Logo size={30} /></Link>
        <span className="text-[17px] font-semibold tracking-[-0.02em] text-ink max-lg:hidden">DealDock</span>
        {IS_DEMO_MODE && <span role="note" className="ml-auto rounded-full bg-review-tint px-2 py-0.5 text-[11px] font-semibold text-review max-lg:hidden">Demo</span>}
      </div>
      <div className="mt-4 flex flex-col gap-2">
        <WorkspaceMenu />
        <SearchButton variant="rail" className="max-lg:hidden" />
        <SearchButton variant="rail-compact" className="lg:hidden" />
      </div>
      <nav aria-label="Main" className="mt-4 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {PRIMARY.map((item) => link(item, item.href === "/inbox" ? badge : 0))}
        <p className="mt-5 mb-1 px-3 text-micro uppercase text-ink-3 max-lg:hidden">Studio</p>
        <div className="max-lg:mt-4 flex flex-col gap-0.5">{STUDIO.map((item) => link(item))}</div>
        {roster && (
          <>
            <p className="mt-5 mb-1 px-3 text-micro uppercase text-ink-3 max-lg:hidden">Creators</p>
            <div className="max-lg:mt-4 flex flex-col gap-0.5">
              {link(CREATORS)}
              {accounts.map((account) => {
                const waiting = threads.filter((thread) => thread.igAccountId === account.id && needsYou(thread)).length;
                const active = pathname.startsWith("/inbox") && activeAccount === account.id;
                return (
                  <Link
                    key={account.id}
                    href={`/inbox?account=${encodeURIComponent(account.id)}`}
                    aria-current={active ? "page" : undefined}
                    title={`@${account.handle}`}
                    className={cx(
                      "dd-press relative flex h-10 items-center gap-3 rounded-xl px-2.5 text-[14px] font-medium max-lg:justify-center max-lg:px-0",
                      active ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:bg-inset hover:text-ink",
                    )}
                  >
                    <Avatar handle={account.handle} size={24} />
                    <span className="truncate max-lg:sr-only lg:flex-1">@{account.handle}<span className="sr-only">{needsYouText(waiting)}</span></span>
                    {account.status !== "active"
                      ? <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-waiting max-lg:absolute max-lg:right-2 max-lg:top-1" title="Needs reconnecting" />
                      : waiting > 0 && <span aria-hidden className="text-caption font-semibold text-ink-3 tabular-nums max-lg:hidden">{waiting}</span>}
                  </Link>
                );
              })}
            </div>
          </>
        )}
        <div className="mt-auto flex flex-col gap-0.5 pt-4">
          {link(SETTINGS)}
          <button
            type="button"
            onClick={() => dispatchCommand("open-shortcuts")}
            title="Keyboard shortcuts"
            className="dd-press flex h-10 items-center gap-3 rounded-xl px-3 text-[14px] font-medium text-ink-2 hover:bg-inset hover:text-ink max-lg:justify-center max-lg:px-0"
          >
            <Keyboard aria-hidden size={19} className="shrink-0" />
            <span className="max-lg:sr-only lg:flex-1 lg:text-left">Shortcuts</span>
            <kbd className="dd-kbd rounded-md bg-inset px-1.5 text-kbd text-ink-3 max-lg:hidden">?</kbd>
          </button>
        </div>
      </nav>
    </aside>
  );
}

function WorkspaceMenu() {
  const { workspaceName } = useApp();
  const me = useMe();
  const settings = useSettings();
  const prefs = useUiPrefs();
  const { signOut } = useAuthActions();
  const name = workspaceName ?? "Your workspace";
  const role = me.data?.role ? roleText(me.data.role) : null;
  const tier = settings.data?.tier ? `${tierText(settings.data.tier)} plan` : null;
  return (
    <Menu
      label="Workspace, account and appearance"
      align="start"
      header={<><span className="block text-label font-semibold text-ink">{name}</span>{[role, tier].filter(Boolean).join(" · ")}</>}
      items={[
        { label: "Keyboard shortcuts", icon: Keyboard, kbd: "?", onSelect: () => dispatchCommand("open-shortcuts") },
        { label: "Light", icon: Sun, checked: prefs.theme === "light", onSelect: () => setUiPref("theme", "light") },
        { label: "Dark", icon: Moon, checked: prefs.theme === "dark", onSelect: () => setUiPref("theme", "dark") },
        { label: "Match system", icon: Monitor, checked: prefs.theme === "system", onSelect: () => setUiPref("theme", "system") },
        ...(signOut ? [{ label: "Sign out", icon: LogOut, destructive: true, onSelect: signOut }] : []),
      ]}
      trigger={(props) => (
        <button type="button" {...props} className="dd-press flex w-full items-center gap-2.5 rounded-xl p-1.5 text-left hover:bg-inset max-lg:justify-center">
          <Avatar handle={name} name={name} size={32} />
          <span className="min-w-0 flex-1 max-lg:hidden">
            <span className="block truncate text-[14px] font-semibold leading-5 text-ink">{name}</span>
            <span className="block truncate text-caption text-ink-3">{tier ?? role ?? "Workspace"}</span>
          </span>
          <ChevronsUpDown aria-hidden size={16} className="shrink-0 text-ink-3 max-lg:hidden" />
        </button>
      )}
    />
  );
}

function TabBar({ pathname, badge }: { pathname: string; badge: number }) {
  return (
    <nav aria-label="Main" className="dd-glass fixed inset-x-0 bottom-0 z-40 border-t border-hairline pb-[env(safe-area-inset-bottom)] md:hidden">
      <ul className="mx-auto flex h-[var(--dd-tabbar-h)] max-w-lg items-stretch px-2">
        {TABS.map((tab) => {
          const active = tab.match(pathname);
          const count = tab.href === "/inbox" ? badge : 0;
          return (
            <li key={tab.label} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cx("dd-press relative flex h-full flex-col items-center justify-center gap-1 text-[11px] font-semibold tracking-[0.005em]", active ? "text-brand" : "text-ink-2")}
              >
                <span className="relative">
                  <tab.icon aria-hidden size={24} strokeWidth={active ? 2.2 : 1.9} />
                  <CountBadge count={count} className="absolute -right-3 -top-1.5" />
                </span>
                <span>{tab.label}<span className="sr-only">{needsYouText(count)}</span></span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
