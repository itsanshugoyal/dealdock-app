import { SignIn } from "@clerk/nextjs";
import { AudioLines, IndianRupee, ShieldCheck } from "lucide-react";
import { HeroCard, Logo } from "../../../components/kit";

const CLERK_ENABLED = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

const POINTS = [
  { icon: IndianRupee, text: "Finds the brand deals and paying leads buried in your DMs." },
  { icon: AudioLines, text: "With your permission, uses your writing style to draft replies you can review." },
  { icon: ShieldCheck, text: "Nothing is ever sent without you approving it." },
];

/** Sign in: brand panel on desktop, a compact header on phones, Clerk's form styled to match. */
export default function SignInPage() {
  return (
    // The shell already provides <main>; this page is its content.
    <div className="flex flex-1 bg-canvas">
      <HeroCard as="div" flat glow="both" glowSize="lg" aria-hidden className="hidden w-[43%] max-w-[580px] flex-col justify-between p-12 lg:flex">
        <div className="flex items-center gap-2.5">
          <Logo size={34} />
          <span className="text-[19px] font-semibold tracking-[-0.02em]">DealDock</span>
        </div>
        <div>
          <p className="max-w-md text-[38px] font-bold leading-[44px] tracking-[-0.035em]">Money in your DMs, answered in your voice.</p>
          <ul className="mt-8 flex max-w-md flex-col gap-4">
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex gap-3 text-[16px] leading-6 text-on-hero/75">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-on-hero/10 text-hero-money"><Icon size={16} /></span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-caption text-on-hero/50">For creators, coaches and the teams behind them.</p>
      </HeroCard>

      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10">
        <div className="mb-8 flex flex-col items-center text-center lg:hidden">
          <Logo size={48} />
          <p className="mt-4 max-w-xs text-[24px] font-bold leading-8 tracking-[-0.03em] text-ink">Money in your DMs, answered in your voice.</p>
        </div>
        {CLERK_ENABLED ? (
          <>
            <h1 className="sr-only">Sign in to DealDock</h1>
            <SignIn
              appearance={{
                // Clerk's card stays white in both themes, so its text is the near-black token that never switches.
                variables: { colorPrimary: "#077A51", colorText: "#0B0B10", borderRadius: "14px", fontFamily: "var(--font-geist-sans), system-ui, sans-serif" },
                elements: { card: "shadow-none", rootBox: "w-full max-w-[400px]" },
              }}
            />
          </>
        ) : (
          <div className="w-full max-w-[400px] rounded-[20px] bg-surface shadow-card p-8 text-center">
            <h1 className="text-title text-ink">Sign-in is unavailable</h1>
            <p className="mt-2 text-body text-ink-2">
              Please try again later or contact your workspace owner for help. Your conversations stay protected.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
