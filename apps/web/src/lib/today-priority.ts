import { isClosingSoon } from "@dealdock/core";
import { byValueDesc, needsYou, replyWindowInfo } from "./format";
import type { DemoThread } from "./types";

/** A recommendation for a person to review; it never approves or sends anything. */
export function nextReply(
  threads: readonly DemoThread[],
  accounts: ReadonlyArray<{ id: string; status: string }>,
  now: number,
): { thread: DemoThread; reason: "closing_soon" | "highest_value" } | null {
  const actionable = threads.filter((thread) => {
    const account = accounts.find((item) => item.id === thread.igAccountId);
    const window = replyWindowInfo(thread.replyWindow, now, "header");
    return needsYou(thread) && !thread.sendInFlight && account?.status === "active" &&
      window.visible && !window.closed;
  });
  const closing = actionable.filter((thread) => isClosingSoon(thread.replyWindow, now))
    .sort((a, b) => Date.parse(a.replyWindow.standardClosesAt!) - Date.parse(b.replyWindow.standardClosesAt!) || byValueDesc(a, b));
  if (closing[0]) return { thread: closing[0], reason: "closing_soon" };
  const biggest = actionable.sort(byValueDesc)[0];
  return biggest ? { thread: biggest, reason: "highest_value" } : null;
}
