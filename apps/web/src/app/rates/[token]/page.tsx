import type { Metadata } from "next";
import { RateCardView } from "../../../components/rate-card-view";

// A private link: never indexed or followed, whatever the root layout says.
export const metadata: Metadata = {
  title: "Rate card",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
};

/** A creator's rate card behind their private link: public, read-only, and gone once they turn it off. */
export default async function RateCardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <RateCardView token={decodeURIComponent(token)} />;
}
