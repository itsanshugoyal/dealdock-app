"use client";

import { useId, type ComponentPropsWithRef, type ReactNode } from "react";
import { CURRENCY_SYMBOL, DEAL_TYPES, isDealType, moneyInputValue, parseMoneyInput, type DealType } from "@dealdock/core";
import { ChevronDown, TriangleAlert } from "lucide-react";
import { dealTypeText } from "../../lib/format";
import { useMoneyContext } from "../../lib/use-demo";
import { cx } from "./cx";
import { MoneyValue, type MoneyKind } from "./money-value";

interface FieldChrome {
  /** Visible label (never a placeholder). May include the currency symbol: "Amount · ₹". */
  label: ReactNode;
  helper?: ReactNode;
  error?: string | null;
  /** Visually hide the label (it stays the accessible name). */
  hideLabel?: boolean;
  className?: string;
}

function useFieldIds(id: string | undefined, helper: unknown, error: unknown) {
  const auto = useId();
  const fieldId = id ?? auto;
  const helperId = `${fieldId}-helper`;
  const errorId = `${fieldId}-error`;
  const describedBy = [helper ? helperId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return { fieldId, helperId, errorId, describedBy };
}

function Chrome({ fieldId, helperId, errorId, label, helper, error, hideLabel, className, children }: FieldChrome & { fieldId: string; helperId: string; errorId: string; children: ReactNode }) {
  return (
    <div className={className}>
      <label htmlFor={fieldId} className={cx("mb-1.5 block text-label text-ink", hideLabel && "sr-only")}>{label}</label>
      {children}
      {helper && <p id={helperId} className="mt-1.5 text-caption text-ink-3">{helper}</p>}
      {error && (
        <p id={errorId} className="mt-1.5 flex items-center gap-1.5 text-caption text-danger">
          <TriangleAlert size={16} className="shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

/** Text input with label above, helper and linked error (DESIGN §3.3). */
export function TextField({ label, helper, error, hideLabel, className, id, ...input }: FieldChrome & ComponentPropsWithRef<"input">) {
  const ids = useFieldIds(id, helper, error);
  return (
    <Chrome {...ids} label={label} helper={helper} error={error} hideLabel={hideLabel} className={className}>
      <input id={ids.fieldId} aria-invalid={error ? true : undefined} aria-describedby={ids.describedBy} className="dd-input" {...input} />
    </Chrome>
  );
}

export function TextArea({ label, helper, error, hideLabel, className, id, ...input }: FieldChrome & ComponentPropsWithRef<"textarea">) {
  const ids = useFieldIds(id, helper, error);
  return (
    <Chrome {...ids} label={label} helper={helper} error={error} hideLabel={hideLabel} className={className}>
      <textarea id={ids.fieldId} aria-invalid={error ? true : undefined} aria-describedby={ids.describedBy} className="dd-input min-h-24 resize-y" {...input} />
    </Chrome>
  );
}

/** Native <select> (keeps platform pickers; e2e uses selectOption). */
export function Select({ label, helper, error, hideLabel, className, id, children, ...select }: FieldChrome & ComponentPropsWithRef<"select">) {
  const ids = useFieldIds(id, helper, error);
  return (
    <Chrome {...ids} label={label} helper={helper} error={error} hideLabel={hideLabel} className={className}>
      <div className="relative">
        <select id={ids.fieldId} aria-invalid={error ? true : undefined} aria-describedby={ids.describedBy} className="dd-input" {...select}>
          {children}
        </select>
        <ChevronDown size={16} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-2" />
      </div>
    </Chrome>
  );
}

/** "Offer type" picker: every deal type in @dealdock/core, in words. */
export function DealTypeSelect({ value, onChange, label = "Offer type", ...select }: Omit<FieldChrome, "label"> & Omit<ComponentPropsWithRef<"select">, "value" | "onChange" | "children"> & {
  label?: ReactNode;
  value: DealType;
  onChange: (type: DealType) => void;
}) {
  return (
    <Select label={label} value={value} onChange={(event) => { if (isDealType(event.target.value)) onChange(event.target.value); }} {...select}>
      {DEAL_TYPES.map((type) => <option key={type} value={type}>{dealTypeText(type)}</option>)}
    </Select>
  );
}

/** The one message for a typed amount that isn't money yet (or is zero where it can't be). */
export const MONEY_INPUT_ERROR = "Enter an amount like 45000 or 1200.50.";

/** An amount as editable text: "45000", or "1200.50" when it has paise or cents. */
export function moneyFieldText(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return "";
  try {
    return moneyInputValue(minor).replace(/\.00$/, "");
  } catch {
    return "";
  }
}

export interface MoneyFieldProps extends Omit<ComponentPropsWithRef<"input">, "value" | "defaultValue" | "onChange" | "type" | "size" | "inputMode"> {
  /** Words before the currency symbol: "Amount" reads "Amount (₹)". */
  label: string;
  /** Adds ", optional" after the symbol. */
  optional?: boolean;
  /** The text as typed. */
  value: string;
  /** Gets digits and one dot only, plus the amount in minor units (null while it isn't one). */
  onChange: (text: string, minor: number | null) => void;
  helper?: ReactNode;
  /** A sentence around the typed amount once it is above zero ("Records ₹45,000 as …"); it replaces `helper`. */
  preview?: (amount: ReactNode) => ReactNode;
  previewKind?: MoneyKind;
  error?: string | null;
  hideLabel?: boolean;
  /** "lg": the one amount a sheet is about. "inline": a narrow box with the symbol inside, for price rows; its label is read, not shown. */
  size?: "md" | "lg" | "inline";
  className?: string;
}

const MONEY_INPUT: Record<NonNullable<MoneyFieldProps["size"]>, string> = {
  md: "",
  lg: "h-14 text-[24px] font-semibold tracking-[-0.02em]",
  inline: "h-11 text-right font-semibold tabular-nums",
};

/**
 * Every typed amount (DESIGN §3.3): the label names the workspace currency, only
 * digits and one dot get in, and the parent gets integer minor units from
 * parseMoneyInput, never a float.
 */
export function MoneyField({ label, optional = false, value, onChange, helper, preview, previewKind = "neutral", error, hideLabel, size = "md", className, id, ...input }: MoneyFieldProps) {
  const { money } = useMoneyContext();
  const symbol = CURRENCY_SYMBOL[money.currency].trim();
  const minor = value ? parseMoneyInput(value) : null;
  const note = preview && minor ? preview(<MoneyValue minor={minor} mode="exact" kind={previewKind} className="font-semibold" />) : helper;
  const ids = useFieldIds(id, note, error);
  const inline = size === "inline";
  const field = (
    <input
      id={ids.fieldId}
      inputMode="decimal"
      autoComplete="off"
      aria-invalid={error ? true : undefined}
      aria-describedby={ids.describedBy}
      className={cx("dd-input", MONEY_INPUT[size], inline && (symbol.length > 1 ? "pl-12" : "pl-8"))}
      value={value}
      onChange={(event) => {
        const text = event.target.value.replace(/[^\d.]/g, "");
        onChange(text, text ? parseMoneyInput(text) : null);
      }}
      {...input}
    />
  );
  return (
    <Chrome {...ids} label={`${label} (${symbol})${optional ? ", optional" : ""}`} helper={note} error={error} hideLabel={hideLabel ?? inline} className={cx(inline && "w-[118px]", className)}>
      {inline ? (
        <div className="relative">
          <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] font-semibold text-ink-3">{symbol}</span>
          {field}
        </div>
      ) : field}
    </Chrome>
  );
}

/** Switch (DESIGN §3.3): <button role="switch">, label left, description below, 44 px hit area. */
export function Switch({ checked, onChange, label, description, disabled, id, className }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const auto = useId();
  const switchId = id ?? auto;
  const descriptionId = `${switchId}-description`;
  return (
    <div className={cx("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <label htmlFor={switchId} className="text-body text-ink">{label}</label>
        {description && <p id={descriptionId} className="mt-0.5 text-caption text-ink-3">{description}</p>}
      </div>
      <button
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? descriptionId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "dd-hit relative h-[30px] w-[50px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40",
          checked ? "bg-brand" : "bg-fill",
        )}
      >
        <span aria-hidden className={cx("absolute left-[2px] top-[2px] h-[26px] w-[26px] rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.22)] transition-transform duration-200 [transition-timing-function:var(--ease-dd-spring)]", checked && "translate-x-5")} />
      </button>
    </div>
  );
}
