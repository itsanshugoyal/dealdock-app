"use client"; // Error boundaries must be Client Components

import Link from "next/link";
import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { Logo } from "../components/kit";
import { Button, buttonClasses } from "../components/ui/button";

/** Error boundary: calm, says the data is safe, offers Reload and Today. */
export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto flex min-h-[70dvh] max-w-md flex-col items-center justify-center px-4 py-12 text-center">
      <Logo size={52} />
      <h1 className="mt-6 text-display text-ink">Something broke on our side.</h1>
      <p className="mt-2 text-body text-ink-2">Your replies, drafts and sales are safe. Nothing was sent.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button variant="primary" icon={RefreshCw} onClick={() => retry()}>Reload</Button>
        <Link href="/" className={buttonClasses({ variant: "secondary" })}>Go to Today</Link>
      </div>
    </div>
  );
}
