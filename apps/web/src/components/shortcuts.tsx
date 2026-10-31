"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useCommand } from "../lib/commands";
import { isTypingTarget } from "../lib/keyboard";
import { getUiPrefs } from "../lib/ui-prefs";
import { Kbd } from "./ui/kbd";
import { Sheet } from "./ui/sheet";

const GO: Record<string, string> = { t: "/", i: "/inbox", r: "/ledger", v: "/voice", o: "/offers", s: "/settings" };

/** Everything the `?` sheet lists (DESIGN §4.4). Screens implement their own groups' keys. */
export const SHORTCUT_GROUPS: Array<{ title: string; keys: Array<[string, string]> }> = [
  { title: "Anywhere", keys: [["mod+k", "Search or jump to"], ["?", "Keyboard shortcuts"], ["g t", "Go to Today"], ["g i", "Go to Inbox"], ["g r", "Go to Revenue"], ["g v", "Go to Your voice"], ["g o", "Go to Offers"], ["g s", "Go to Settings"], ["escape", "Close a sheet or menu"], ["z", "Undo (while Undo shows)"]] },
  { title: "Lists (Today, Inbox)", keys: [["j", "Next conversation"], ["k", "Previous conversation"], ["enter", "Open the conversation"], ["/", "Search"], ["w", "Move to waiting"], ["x", "Not a deal"]] },
  { title: "Conversation", keys: [["e", "Edit the draft"], ["r", "Regenerate draft"], ["w", "Move to waiting / back to open"], ["c", "Record a sale"], ["mod+enter", "Approve & send (with time to undo)"]] },
  { title: "Check these", keys: [["y", "Confirm the best guess"], ["n", "Change label"], ["1", "Brand deal"], ["2", "Coaching"], ["3", "Course"], ["4", "Other sale"], ["5", "Fan"], ["6", "Personal"], ["7", "Spam"], ["8", "Not sure either — skip"], ["u", "Undo the last decision"]] },
];

/**
 * Global keyboard layer: `?` opens the shortcuts sheet and `g` then a letter
 * navigates. Single keys never fire inside text fields, while a sheet is open,
 * or when the creator switched single-key shortcuts off.
 */
export function KeyboardShortcuts() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const pendingG = useRef<number | null>(null);
  useCommand("open-shortcuts", () => setOpen(true));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (!getUiPrefs().singleKeyShortcuts || isTypingTarget(event.target) || document.querySelector("dialog[open]")) return;
      const key = event.key.toLowerCase();
      if (pendingG.current !== null) {
        window.clearTimeout(pendingG.current);
        pendingG.current = null;
        const href = GO[key];
        if (href) { event.preventDefault(); router.push(href); }
        return;
      }
      if (key === "g") { pendingG.current = window.setTimeout(() => { pendingG.current = null; }, 1_200); return; }
      if (event.key === "?") { event.preventDefault(); setOpen(true); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return (
    <Sheet open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" placement="side" initialFocus="title"
      description="Single-key shortcuts work outside text fields. Turn them off in Settings › Appearance.">
      <div className="grid gap-6 pt-2">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} aria-label={group.title}>
            <h3 className="mb-2 text-subheading text-ink">{group.title}</h3>
            <dl className="grid gap-1.5">
              {group.keys.map(([keys, label]) => (
                <div key={`${keys}-${label}`} className="flex items-center justify-between gap-4 text-body">
                  <dt className="text-ink-2">{label}</dt>
                  <dd><Kbd keys={keys} decorative={false} /></dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Sheet>
  );
}
