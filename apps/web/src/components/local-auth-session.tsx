"use client";
import { useLayoutEffect } from "react";
import { apiStore } from "../lib/api-store";
/** Explicit local integration mode; this component is never mounted in production. */
export function LocalAuthSession({children}:{children:React.ReactNode}) {
  useLayoutEffect(()=>{apiStore.setLocalDevelopment(true);return()=>apiStore.setLocalDevelopment(false)},[]);
  return <><div role="status" className="bg-review-tint px-4 py-1.5 text-center text-caption text-review">Local integration mode · fixed test workspace · real local API and database</div>{children}</>;
}
