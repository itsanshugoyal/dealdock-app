import Link from "next/link";
import { Logo } from "../components/kit";
import { buttonClasses } from "../components/ui/button-classes";

/** Unknown routes only. /thread/[id] never calls notFound(): unknown threads render a 200 client state. */
export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[70dvh] max-w-md flex-col items-center justify-center px-4 py-12 text-center">
      <Logo size={52} />
      <h1 className="mt-6 text-display text-ink">This page isn&apos;t here.</h1>
      <p className="mt-2 text-body text-ink-2">The link may be old, or the page moved. Your conversations and sales are right where you left them.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link href="/" className={buttonClasses({ variant: "primary" })}>Go to Today</Link>
        <Link href="/inbox" className={buttonClasses({ variant: "secondary" })}>Open inbox</Link>
      </div>
    </div>
  );
}
