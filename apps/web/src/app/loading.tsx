import { Skeleton } from "../components/ui/feedback";

/** Route-level loading: a quiet page-shaped skeleton (title, hero card, grouped rows), never a spinner-only screen. */
export default function Loading() {
  return (
    <div aria-busy="true" className="mx-auto w-full max-w-[1240px] px-4 pt-6 md:px-8 md:pt-10">
      <span role="status" className="sr-only">Loading…</span>
      <Skeleton className="h-4 w-28 rounded-full" />
      <Skeleton className="mt-2 h-9 w-56 rounded-xl" />
      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)]">
        <div className="flex flex-col gap-5">
          <Skeleton className="h-[220px] rounded-[26px]" />
          <Skeleton className="h-[280px] rounded-[20px]" />
        </div>
        <Skeleton className="hidden h-[320px] rounded-[20px] lg:block" />
      </div>
    </div>
  );
}
