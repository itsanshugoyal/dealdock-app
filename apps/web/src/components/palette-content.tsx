"use client";

import { useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Command } from "cmdk";
import {
  AudioLines, Banknote, CircleHelp, Command as CommandIcon, Download, HandCoins, Hourglass, Inbox, Keyboard, Monitor, Moon, Pause,
  Play, RefreshCw, Search, Settings, Stamp, Sun, Tag, Target, Users, type LucideIcon,
} from "lucide-react";
import { dispatchCommand } from "../lib/commands";
import { accountBigOneThreshold, byValueDesc, isBigOne, needsYou, toCheck } from "../lib/format";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../lib/settings-sections";
import { setUiPref, useUiPrefs } from "../lib/ui-prefs";
import { appStore, useApp, useSettings, type DemoThread } from "../lib/use-demo";
import { Kbd } from "./ui/kbd";
import { LabelChip } from "./ui/label-chip";
import { MoneyValue } from "./ui/money-value";
import { toastAction } from "./ui/toast";

const GROUP = "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-ink-3";
const ITEM = "flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-3 text-body text-ink data-[selected=true]:bg-inset data-[disabled=true]:opacity-45 [@media(pointer:coarse)]:min-h-11";

function Item({ icon: Icon, value, keywords, kbd, onSelect, children }: { icon?: LucideIcon; value: string; keywords?: string[]; kbd?: string; onSelect: () => void; children: ReactNode }) {
  return (
    <Command.Item value={value} keywords={keywords} onSelect={onSelect} className={ITEM}>
      {Icon && <Icon size={16} className="shrink-0 text-ink-2" />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {kbd && <Kbd keys={kbd} />}
    </Command.Item>
  );
}

/** Other words people search for a settings section by. */
const SECTION_KEYWORDS: Partial<Record<SettingsSectionId, string[]>> = {
  instagram: ["accounts", "connect"],
  team: ["seats", "invite"],
  plan: ["billing", "subscription"],
  appearance: ["theme", "undo"],
  data: ["export", "delete account"],
};

/** Palette body (lazy-loaded with cmdk). Conversations search the loaded inbox and review rows. */
export default function PaletteContent({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const { threads, money, offers } = useApp();
  const settings = useSettings();
  const prefs = useUiPrefs();
  const [search, setSearch] = useState("");
  const threadId = pathname.startsWith("/thread/") ? decodeURIComponent(pathname.split("/")[2] ?? "") : null;
  const current = threadId ? threads.find((thread) => thread.id === threadId) ?? null : null;
  const roster = settings.data?.tier === "roster";

  const go = (href: string) => { onClose(); router.push(href); };
  const run = (action: () => void) => { onClose(); action(); };

  // The inbox's "Big ones" rule; offers count once they are loaded, the palette never fetches them.
  const nextBigOne = useMemo(() => {
    const bigOne = (thread: DemoThread) => isBigOne(thread, accountBigOneThreshold(money.currency, offers.data, thread.igAccountId));
    return threads.filter((thread) => needsYou(thread) && bigOne(thread) && thread.id !== threadId).sort(byValueDesc)[0] ?? null;
  }, [threads, money.currency, offers.data, threadId]);
  const reviewCount = threads.filter(toCheck).length;

  return (
    <Command label="Search or jump to" loop className="flex max-h-[inherit] min-h-0 flex-1 flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline px-4">
        <Search aria-hidden size={20} className="shrink-0 text-ink-2" />
        <Command.Input
          autoFocus
          value={search}
          onValueChange={setSearch}
          aria-label="Search or jump to"
          placeholder="Search conversations, actions, settings"
          className="h-full min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-3"
        />
        <button type="button" onClick={onClose} className="text-label text-ink-2 hover:text-ink md:hidden">Close</button>
      </div>
      <Command.List className={`min-h-0 flex-1 overflow-y-auto p-2 md:max-h-[60vh] ${GROUP}`}>
        <Command.Empty className="px-3 py-8 text-center text-body text-ink-2">No matches for “{search}”.</Command.Empty>

        {search.trim() && (
          <Command.Group heading="Conversations">
            {threads.map((thread) => (
              <Command.Item
                key={`${thread.routedTo}-${thread.id}`}
                value={`conversation ${thread.id} @${thread.handle}`}
                keywords={[thread.participant.name ?? "", thread.preview]}
                onSelect={() => go(thread.routedTo === "review_queue" ? "/review" : `/thread/${encodeURIComponent(thread.id)}`)}
                className={ITEM}
              >
                <span className="min-w-0 flex-1 truncate"><bdi>@{thread.handle}</bdi>{thread.participant.name && <span className="ml-2 text-ink-3">{thread.participant.name}</span>}</span>
                {thread.topLabel && <LabelChip label={thread.topLabel} />}
                {thread.estValueMaxMinor !== null && <MoneyValue minor={thread.estValueMinMinor ?? thread.estValueMaxMinor} maxMinor={thread.estValueMaxMinor} mode="range" kind="estimate" size="row" />}
              </Command.Item>
            ))}
          </Command.Group>
        )}

        <Command.Group heading="Actions">
          {nextBigOne && <Item icon={HandCoins} value="Go to the next big one" onSelect={() => go(`/thread/${encodeURIComponent(nextBigOne.id)}`)}>Go to the next big one · <bdi>@{nextBigOne.handle}</bdi></Item>}
          {reviewCount > 0 && <Item icon={CircleHelp} value="Check these review" onSelect={() => go("/review")}>Check these ({reviewCount})</Item>}
          {threadId && (
            <>
              <Item icon={Stamp} value="Record a sale" kbd="c" onSelect={() => run(() => dispatchCommand("record-sale", threadId))}>Record a sale…</Item>
              {current?.state === "waiting"
                ? <Item icon={Hourglass} value="Back to open" kbd="w" onSelect={() => run(() => dispatchCommand("toggle-waiting", threadId))}>Back to open</Item>
                : current?.state !== "closed" && <Item icon={Hourglass} value="Move to waiting" kbd="w" onSelect={() => run(() => dispatchCommand("toggle-waiting", threadId))}>Move to waiting</Item>}
              <Item icon={RefreshCw} value="Regenerate draft" kbd="r" onSelect={() => run(() => dispatchCommand("regenerate-draft", threadId))}>Regenerate draft</Item>
            </>
          )}
          <Item icon={Download} value="Export revenue CSV" onSelect={() => run(() => void toastAction(() => appStore.download("/ledger/export.csv", "dealdock-revenue.csv"), { fallback: "Couldn't export your revenue." }))}>Export revenue CSV</Item>
          <Item icon={Target} value="Set monthly goal" onSelect={() => go("/settings#goal")}>Set monthly goal…</Item>
          <Item icon={Tag} value="Add an offer" onSelect={() => go("/offers#new")}>Add an offer…</Item>
          <Item icon={Pause} value="Pause learning" onSelect={() => run(() => void toastAction(() => appStore.setLearningPaused(true), { success: "Learning paused. Drafts still use what's already here.", fallback: "Couldn't pause learning." }))}>Pause learning</Item>
          <Item icon={Play} value="Resume learning" onSelect={() => run(() => void toastAction(() => appStore.setLearningPaused(false), { success: "Learning resumed.", fallback: "Couldn't resume learning." }))}>Resume learning</Item>
          <Item icon={Keyboard} value="Keyboard shortcuts" kbd="?" onSelect={() => run(() => dispatchCommand("open-shortcuts"))}>Keyboard shortcuts</Item>
        </Command.Group>

        <Command.Group heading="Go to">
          <Item icon={Sun} value="Today" kbd="g t" onSelect={() => go("/")}>Today</Item>
          <Item icon={Inbox} value="Inbox" kbd="g i" onSelect={() => go("/inbox")}>Inbox</Item>
          <Item icon={Banknote} value="Revenue ledger" kbd="g r" onSelect={() => go("/ledger")}>Revenue</Item>
          <Item icon={AudioLines} value="Your voice" kbd="g v" onSelect={() => go("/voice")}>Your voice</Item>
          <Item icon={Tag} value="Offers" kbd="g o" onSelect={() => go("/offers")}>Offers</Item>
          <Item icon={Settings} value="Settings" kbd="g s" onSelect={() => go("/settings")}>Settings</Item>
          <Item icon={CommandIcon} value="Activity audit" onSelect={() => go("/activity")}>Activity</Item>
          {roster && <Item icon={Users} value="Roster" onSelect={() => go("/roster")}>Roster</Item>}
          {SETTINGS_SECTIONS.map((section) => (
            <Item key={section.id} icon={Settings} value={`Settings ${section.label}`} keywords={SECTION_KEYWORDS[section.id]} onSelect={() => go(`/settings#${section.id}`)}>Settings › {section.label}</Item>
          ))}
        </Command.Group>

        <Command.Group heading="Theme">
          <Item icon={Sun} value="Light theme" onSelect={() => run(() => setUiPref("theme", "light"))}>Light theme{prefs.theme === "light" ? " · on" : ""}</Item>
          <Item icon={Moon} value="Dark theme" onSelect={() => run(() => setUiPref("theme", "dark"))}>Dark theme{prefs.theme === "dark" ? " · on" : ""}</Item>
          <Item icon={Monitor} value="Match system theme" onSelect={() => run(() => setUiPref("theme", "system"))}>Match system theme{prefs.theme === "system" ? " · on" : ""}</Item>
        </Command.Group>
      </Command.List>
    </Command>
  );
}
