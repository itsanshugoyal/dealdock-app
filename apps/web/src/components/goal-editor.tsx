"use client";

import { useEffect, useState } from "react";
import { parseMoneyInput } from "@dealdock/core";
import { errorMessage } from "../lib/snapshot";
import { appStore, useMoneyContext } from "../lib/use-demo";
import { Button } from "./ui/button";
import { MONEY_INPUT_ERROR, MoneyField, moneyFieldText } from "./ui/field";
import { formatMoney } from "./ui/money-value";
import { Sheet } from "./ui/sheet";
import { toast } from "./ui/toast";

/**
 * The monthly goal editor behind Settings (inline) and Revenue (a sheet): the
 * typed amount, its check, and saving or removing the goal. It starts again
 * from `current` whenever that or `resetKey` (a sheet's `open`) changes.
 */
export function useGoalEditor(current: number | null, resetKey?: unknown) {
  const { money } = useMoneyContext();
  const [text, setText] = useState(() => moneyFieldText(current));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setText(moneyFieldText(current));
    setError(null);
  }, [current, resetKey]);

  /** Resolves true once the goal is saved (or removed with `clear`). */
  const save = async (clear = false): Promise<boolean> => {
    const minor = clear ? null : parseMoneyInput(text);
    if (!clear && (!minor || minor <= 0)) { setError(MONEY_INPUT_ERROR); return false; }
    setBusy(true);
    setError(null);
    try {
      await appStore.setGoal(minor);
      toast(minor === null ? "Goal removed." : `Monthly goal set to ${formatMoney(minor, null, "exact", money)}. Today shows your progress.`, { tone: "success" });
      return true;
    } catch (failure) {
      setError(errorMessage(failure, "Couldn't save the goal. Try again."));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { text, setText, error, busy, save };
}
export type GoalEditor = ReturnType<typeof useGoalEditor>;

/** The goal amount, with the monthly read-back once it is a real amount. */
export function GoalField({ editor, size, className }: { editor: GoalEditor; size?: "md" | "lg"; className?: string }) {
  return (
    <MoneyField
      label="Goal"
      size={size}
      value={editor.text}
      onChange={(text) => editor.setText(text)}
      error={editor.error}
      placeholder="500000"
      helper="Only confirmed sales count toward it."
      preview={(amount) => <>That&apos;s {amount} a month.</>}
      className={className}
    />
  );
}

/** Revenue's goal sheet (the hero's ring or "Set a goal"). */
export function GoalSheet({ open, onClose, current }: { open: boolean; onClose: () => void; current: number | null }) {
  const editor = useGoalEditor(current, open);
  const save = async (clear = false) => { if (await editor.save(clear)) onClose(); };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Monthly goal"
      description="Today and Revenue show your progress and pace toward it."
      placement="dialog"
      footer={
        <div className="flex w-full flex-col gap-2">
          <Button variant="money" size="lg" fullWidth loading={editor.busy} loadingLabel="Saving…" onClick={() => void save()}>Save goal</Button>
          {current ? <Button variant="ghost" fullWidth disabled={editor.busy} onClick={() => void save(true)}>Remove goal</Button> : null}
        </div>
      }
    >
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <GoalField editor={editor} size="lg" />
      </form>
    </Sheet>
  );
}
