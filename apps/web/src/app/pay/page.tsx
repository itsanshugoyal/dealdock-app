import type { Metadata } from "next";
import { PaddleCheckout } from "../../components/paddle-checkout";

export const metadata: Metadata = {
  title: "Checkout",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
};

/** Paddle's default payment link (checkout and card updates). Public: Paddle emails it to payers who may be signed out. */
export default function PayPage() {
  return <PaddleCheckout />;
}
