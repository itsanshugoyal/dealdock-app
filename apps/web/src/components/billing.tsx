"use client";

import { useState, type ReactNode } from "react";
import { BillingProfileInputSchema, formatInvoiceNumber, INDIAN_STATES, invoiceNumberYear, isValidGstin, type BillingProfileDto, type CurrencyCode, type TaxKind } from "@dealdock/core";
import { Pencil, Plus } from "lucide-react";
import { apiFieldErrors, billingForm, billingInput, countryName, countryOptions, issueErrors, withGstin, type BillingForm } from "../lib/billing";
import { errorMessage } from "../lib/snapshot";
import { appStore, useBillingProfile, useCan, useMe, useMoneyContext, useSettings } from "../lib/use-demo";
import { Group } from "./kit";
import { STATE_OPTIONS } from "./invoices";
import { Disclosure, SaveError } from "./sheet-parts";
import { Button } from "./ui/button";
import { ErrorState, Skeleton } from "./ui/feedback";
import { Select, TextArea, TextField } from "./ui/field";
import { Segmented } from "./ui/selection";
import { Sheet } from "./ui/sheet";
import { toast } from "./ui/toast";

/** Where a new workspace's billing address most likely is, from its currency; euro workspaces pick. */
const HOME_COUNTRY: Record<CurrencyCode, string> = { INR: "IN", USD: "US", GBP: "GB", EUR: "", AED: "AE" };

/**
 * Billing details: who the creator is on an invoice, their tax registration
 * and how brands pay them. One workspace profile; on Roster a creator can
 * have their own, and one without uses the workspace's.
 */
export function BillingSection() {
  const settings = useSettings().data!;
  const canManage = useCan("manage_settings");
  const roster = settings.tier === "roster" && settings.accounts.length > 1;
  const [scope, setScope] = useState("");
  const creator = roster ? settings.accounts.find((account) => account.id === scope) ?? null : null;
  const billing = useBillingProfile(creator?.id, canManage === true);
  const [editing, setEditing] = useState(false);
  const data = billing.data;
  const profile = data?.profile ?? null;
  const inherited = Boolean(creator && data?.inherited);
  return (
    <Group
      id="billing"
      title="Billing details"
      description="Printed on every invoice: who you are, your tax registration and how brands pay you."
      action={canManage && profile && !inherited ? <Button variant="ghost" size="sm" icon={Pencil} aria-label={creator ? `Edit billing details for @${creator.handle}` : "Edit billing details"} onClick={() => setEditing(true)}>Edit</Button> : undefined}
    >
      {canManage === false ? (
        <p className="px-4 py-4 text-[14px] text-ink-2 md:px-5">Only the workspace&apos;s creator can see and change billing details.</p>
      ) : billing.status === "error" && !data ? (
        <ErrorState thing="your billing details" reason={billing.error} onRetry={() => void appStore.loadBillingProfile(creator?.id)} />
      ) : !data ? <div className="p-4"><Skeleton className="h-24" /></div> : (
        <>
          {roster && (
            <div className="border-b border-hairline px-4 pb-3 pt-3 md:px-5">
              <Select label="Details for" value={scope} onChange={(event) => setScope(event.target.value)} helper={creator ? "Invoices for this creator print these details." : "Every creator uses these unless they have their own."}>
                <option value="">Workspace (all creators)</option>
                {settings.accounts.map((account) => <option key={account.id} value={account.id}>@{account.handle}</option>)}
              </Select>
            </div>
          )}
          {!profile ? (
            <div className="flex flex-col items-start gap-3 px-4 py-4 md:px-5">
              <div>
                <p className="text-[15px] font-semibold leading-5 text-ink">Add your billing details to make invoices.</p>
                <p className="mt-0.5 text-caption text-ink-3">DealDock prints them on every invoice and works out GST or VAT from them.</p>
              </div>
              <Button variant="primary" size="sm" icon={Plus} onClick={() => setEditing(true)}>Add billing details</Button>
            </div>
          ) : (
            <>
              {inherited && creator && (
                <div className="flex flex-wrap items-center gap-3 border-b border-hairline px-4 py-3 md:px-5">
                  <p className="min-w-0 flex-1 text-[14px] text-ink-2"><b className="font-semibold text-ink">Uses workspace details.</b> Invoices for @{creator.handle} print the workspace&apos;s details below.</p>
                  <Button variant="secondary" size="sm" icon={Plus} onClick={() => setEditing(true)}>Add their own</Button>
                </div>
              )}
              <ProfileFacts profile={profile} />
            </>
          )}
        </>
      )}
      {editing && (
        <BillingSheet
          profile={inherited ? null : profile}
          country={profile?.country}
          creator={creator}
          onClose={() => setEditing(false)}
        />
      )}
    </Group>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-3 md:px-5">
      <dt className="text-[15px] font-semibold leading-5 text-ink">{term}</dt>
      <dd className="min-w-0 break-words text-right text-[14px] text-ink-2">{children}</dd>
    </div>
  );
}

/** The profile at a glance: name and place, tax, how to pay, and the next invoice number. */
function ProfileFacts({ profile }: { profile: BillingProfileDto }) {
  const { tax, payment } = profile;
  const place = [profile.city, profile.state && profile.country === "IN" ? INDIAN_STATES[profile.state] ?? profile.state : profile.state, countryName(profile.country)].filter(Boolean).join(", ");
  const paid = [payment.upiId && `UPI ${payment.upiId}`, payment.accountNumber && `${payment.bankName ?? "Bank"} ••${payment.accountNumber.slice(-4)}`, payment.paymentLink && "Payment link"].filter(Boolean);
  return (
    <dl className="divide-y divide-hairline">
      <Fact term="Legal name"><span className="block font-medium text-ink">{profile.legalName}</span>{place && <span className="block text-caption text-ink-3">{place}</span>}</Fact>
      <Fact term="Tax">{tax.kind === "gst_in" ? `GST · ${tax.number}` : tax.kind === "vat" ? `VAT ${tax.ratePercent}% · ${tax.number}` : "Not registered"}{profile.pan && <span className="block text-caption text-ink-3">PAN {profile.pan}</span>}</Fact>
      <Fact term="Getting paid">{paid.length ? paid.join(" · ") : <span className="font-semibold text-waiting">Add how brands pay you</span>}</Fact>
      <Fact term="Next invoice"><span className="font-medium tabular-nums text-ink">{profile.nextInvoiceNumber}</span></Fact>
    </dl>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend className="mb-1 text-heading text-ink">{title}</legend>
      {children}
    </fieldset>
  );
}

/**
 * The billing details form, grouped by what it's for, showing only what the
 * country and tax registration need. Core's schema checks it before it is
 * sent; the API checks it again. A creator's own details (Roster) start
 * empty: they are another person's name, tax numbers and bank account.
 */
function BillingSheet({ profile, country, creator, onClose }: {
  profile: BillingProfileDto | null;
  /** Where a new profile starts: the workspace's country. */
  country?: string;
  creator: { id: string; handle: string } | null;
  onClose: () => void;
}) {
  const { money, timezone } = useMoneyContext();
  const me = useMe();
  const [initial] = useState<BillingForm>(() => {
    const form = billingForm(profile, { country: country ?? HOME_COUNTRY[money.currency], email: creator ? null : me.data?.email });
    // Invoice numbers are unique per workspace, so a creator's own profile needs its own prefix.
    return !profile && creator ? { ...form, prefix: creator.handle.replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase() || "INV" } : form;
  });
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [moreTax, setMoreTax] = useState(Boolean(initial.lutArn || initial.udyam));
  const [abroad, setAbroad] = useState(Boolean(initial.swift) && initial.country === "IN");
  const india = form.country === "IN";
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = <K extends keyof BillingForm>(key: K, value: BillingForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    const field = FIELD_OF[key];
    if (errors[field]) setErrors(({ [field]: _fixed, ...rest }) => rest);
  };
  const kinds: Array<{ value: TaxKind; label: string }> = [{ value: "none", label: "Not registered" }, india ? { value: "gst_in", label: "GST registered" } : { value: "vat", label: "VAT registered" }];
  const taxKind: TaxKind = kinds.some((item) => item.value === form.taxKind) ? form.taxKind : "none";

  // The number the next invoice gets: the sequence carries on unless the numbering year changes with the country.
  const now = new Date();
  const year = invoiceNumberYear(now, timezone, form.country || "IN");
  const sequence = profile && invoiceNumberYear(now, timezone, profile.country) === year ? Number(profile.nextInvoiceNumber.split("-").at(-1)) || 1 : 1;
  const prefix = form.prefix.trim().toUpperCase();
  const nextNumber = formatInvoiceNumber(prefix || "INV", year, sequence);

  const save = async () => {
    const checked = BillingProfileInputSchema.safeParse(billingInput({ ...form, taxKind }));
    if (!checked.success) {
      const next = issueErrors(checked.error.issues);
      if (next.country) next.country = "Pick your country.";
      setErrors(next);
      if (next["tax.lutArn"] || next.udyamNumber) setMoreTax(true);
      if (next["payment.swift"] && india) setAbroad(true);
      setSaveError("Check the highlighted details.");
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      await appStore.saveBillingProfile(checked.data, creator?.id);
      toast(creator ? `Billing details saved for @${creator.handle}. Their new invoices use them.` : "Billing details saved. New invoices use them.", { tone: "success" });
      onClose();
    } catch (failure) {
      const fields = apiFieldErrors(failure);
      if ((failure as { code?: unknown }).code === "invoice_prefix_in_use") fields.invoicePrefix = errorMessage(failure);
      setErrors(fields);
      setSaveError(errorMessage(failure, "Your billing details didn't save. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={creator ? `Billing details for @${creator.handle}` : "Billing details"}
      description="Printed on every invoice. Invoices already made keep the details they were issued with."
      dirty={dirty && !busy}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} loadingLabel="Saving…" onClick={() => void save()}>Save</Button></>}
    >
      <form className="flex flex-col gap-7 pb-2" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Section title="Your details">
          <TextField label="Legal name" value={form.legalName} maxLength={120} autoComplete="name" error={errors.legalName && "Add the name invoices should show."} helper="You, or your business, as invoices should name you." onChange={(event) => set("legalName", event.target.value)} />
          <TextArea label="Address, optional" rows={2} maxLength={480} value={form.address} error={errors.addressLines} helper="Street, area and postal code, one per line." onChange={(event) => set("address", event.target.value)} />
          <Select label="Country" value={form.country} error={errors.country} onChange={(event) => setForm((current) => ({ ...current, country: event.target.value, state: "" }))}>
            {!form.country && <option value="">Choose…</option>}
            {countryOptions().map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
          </Select>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="City, optional" value={form.city} maxLength={80} autoComplete="address-level2" error={errors.city} onChange={(event) => set("city", event.target.value)} />
            {india ? (
              <Select label="State" value={form.state} error={errors.state} onChange={(event) => set("state", event.target.value)}>
                <option value="">Not set</option>
                {STATE_OPTIONS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </Select>
            ) : <TextField label="State or region, optional" value={form.state} maxLength={80} error={errors.state} onChange={(event) => set("state", event.target.value)} />}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Email, optional" type="email" value={form.email} maxLength={254} autoComplete="email" error={errors.email} onChange={(event) => set("email", event.target.value)} />
            <TextField label="Phone, optional" type="tel" value={form.phone} maxLength={20} autoComplete="tel" error={errors.phone} onChange={(event) => set("phone", event.target.value)} />
          </div>
        </Section>

        <Section title="Tax">
          <div className="flex flex-col gap-1.5">
            <span className="text-label text-ink">Registration</span>
            <Segmented label="Registration" value={taxKind} options={kinds} onChange={(kind) => set("taxKind", kind)} className="self-start" />
          </div>
          {taxKind === "gst_in" && (
            <>
              <TextField
                label="GSTIN"
                value={form.taxNumber}
                maxLength={20}
                autoCapitalize="characters"
                error={errors["tax.number"]}
                helper="Your state and PAN fill in from it."
                onChange={(event) => { const typed = event.target.value.toUpperCase(); setForm((current) => withGstin(current, typed)); setErrors(({ "tax.number": _gstin, state: _state, pan: _pan, ...rest }) => rest); }}
                onBlur={() => { const number = form.taxNumber.replace(/\s+/g, ""); if (number && !isValidGstin(number)) setErrors((current) => ({ ...current, "tax.number": "This GSTIN doesn't look right. Check the 15 characters." })); }}
              />
              <TextField label="SAC code, optional" inputMode="numeric" value={form.sac} maxLength={8} error={errors.sacCode} helper="Printed on each invoice line. 998361 is advertising services." onChange={(event) => set("sac", event.target.value.replace(/\D/g, ""))} />
            </>
          )}
          {taxKind === "vat" && (
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
              <TextField
                label="VAT number"
                value={form.taxNumber}
                maxLength={30}
                autoCapitalize="characters"
                error={errors["tax.number"]}
                onChange={(event) => set("taxNumber", event.target.value.toUpperCase())}
                onBlur={() => { const number = form.taxNumber.replace(/\s+/g, ""); if (number && !/^[A-Z0-9-]{4,20}$/.test(number)) setErrors((current) => ({ ...current, "tax.number": "Enter the VAT number as it's registered, letters and digits only." })); }}
              />
              <TextField label="VAT rate (%)" inputMode="decimal" value={form.vatRate} maxLength={6} error={errors["tax.ratePercent"]} onChange={(event) => set("vatRate", event.target.value.replace(/[^\d.]/g, ""))} />
            </div>
          )}
          {india && <TextField label={taxKind === "gst_in" ? "PAN" : "PAN, optional"} value={form.pan} maxLength={10} autoCapitalize="characters" error={errors.pan} helper={taxKind === "gst_in" ? "From your GSTIN." : "Brands need it to deduct TDS."} onChange={(event) => set("pan", event.target.value.toUpperCase())} />}
          {india && (
            <Disclosure summary={taxKind === "gst_in" ? "Exports and MSME" : "MSME (Udyam) number"} open={moreTax} onToggle={setMoreTax}>
              {taxKind === "gst_in" && (
                <TextField label="LUT ARN, optional" value={form.lutArn} maxLength={20} autoCapitalize="characters" error={errors["tax.lutArn"]} helper="For export invoices to brands outside India: with a Letter of Undertaking they go out without IGST." onChange={(event) => set("lutArn", event.target.value.toUpperCase())} />
              )}
              <TextField label="Udyam number, optional" value={form.udyam} maxLength={24} autoCapitalize="characters" placeholder="UDYAM-MH-01-0001234" error={errors.udyamNumber} helper="If you're registered as an MSME." onChange={(event) => set("udyam", event.target.value.toUpperCase())} />
            </Disclosure>
          )}
        </Section>

        <Section title="Getting paid">
          {india && <TextField label="UPI ID, optional" value={form.upiId} maxLength={256} autoCapitalize="none" placeholder="name@bank" error={errors["payment.upiId"]} helper="Invoices to brands in India get a QR code to scan and pay." onChange={(event) => set("upiId", event.target.value.trim())} />}
          <TextField label="Account name, optional" value={form.accountName} maxLength={120} error={errors["payment.accountName"]} onChange={(event) => set("accountName", event.target.value)} />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Account number, optional" inputMode={india ? "numeric" : undefined} value={form.accountNumber} maxLength={34} autoCapitalize="characters" error={errors["payment.accountNumber"]} onChange={(event) => set("accountNumber", event.target.value.toUpperCase())} />
            {india
              ? <TextField label="IFSC, optional" value={form.ifsc} maxLength={11} autoCapitalize="characters" placeholder="HDFC0001234" error={errors["payment.ifsc"]} onChange={(event) => set("ifsc", event.target.value.toUpperCase())} />
              : <TextField label="IBAN, optional" value={form.iban} maxLength={34} autoCapitalize="characters" error={errors["payment.iban"]} onChange={(event) => set("iban", event.target.value.toUpperCase())} />}
          </div>
          <TextField label="Bank name, optional" value={form.bankName} maxLength={80} error={errors["payment.bankName"]} onChange={(event) => set("bankName", event.target.value)} />
          {!india && <TextField label="SWIFT/BIC, optional" value={form.swift} maxLength={11} autoCapitalize="characters" error={errors["payment.swift"]} onChange={(event) => set("swift", event.target.value.toUpperCase())} />}
          <TextField label="Payment link, optional" type="url" value={form.paymentLink} maxLength={500} placeholder="https://" error={errors["payment.paymentLink"]} helper="A page to pay you online, like a Razorpay or Stripe link." onChange={(event) => set("paymentLink", event.target.value.trim())} />
          {india && (
            <Disclosure summary="Payments from abroad" open={abroad} onToggle={setAbroad}>
              <TextField label="SWIFT/BIC, optional" value={form.swift} maxLength={11} autoCapitalize="characters" error={errors["payment.swift"]} helper="Brands outside India pay with it." onChange={(event) => set("swift", event.target.value.toUpperCase())} />
            </Disclosure>
          )}
        </Section>

        <Section title="Invoice numbers">
          <TextField
            label="Prefix"
            value={form.prefix}
            maxLength={india ? 4 : 10}
            autoCapitalize="characters"
            error={errors.invoicePrefix}
            helper={<>Your next invoice: <span className="font-semibold tabular-nums text-ink-2">{nextNumber}</span>{india ? ". Up to 4 letters or digits, so numbers fit GST's 16 characters." : "."}</>}
            onChange={(event) => set("prefix", event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          />
        </Section>
        <SaveError message={saveError} />
      </form>
    </Sheet>
  );
}

/** The schema path each form field reports its errors under. */
const FIELD_OF: Record<keyof BillingForm, string> = {
  legalName: "legalName", address: "addressLines", city: "city", state: "state", country: "country", email: "email", phone: "phone",
  taxKind: "tax.kind", taxNumber: "tax.number", vatRate: "tax.ratePercent", gstRate: "tax.ratePercent", lutArn: "tax.lutArn", pan: "pan", udyam: "udyamNumber", sac: "sacCode",
  upiId: "payment.upiId", bankName: "payment.bankName", accountName: "payment.accountName", accountNumber: "payment.accountNumber", ifsc: "payment.ifsc", swift: "payment.swift", iban: "payment.iban", paymentLink: "payment.paymentLink",
  prefix: "invoicePrefix",
};
