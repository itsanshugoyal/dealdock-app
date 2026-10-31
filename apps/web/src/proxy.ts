import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);

/**
 * Next 16 proxy (formerly middleware.ts). Auth is ON by default and fails CLOSED. It's disabled only when
 * DEALDOCK_DISABLE_AUTH is the explicit string "true" — a server-only var read
 * at runtime, NOT a NEXT_PUBLIC_ flag. NEXT_PUBLIC_ values are inlined at
 * `next build`, so gating on one lets a build made before secrets are injected
 * permanently ship with auth off, silently (F7). With this flag absent in a
 * real deploy, clerkMiddleware runs and throws per-request if misconfigured —
 * fail closed, not open.
 */
const AUTH_DISABLED = process.env.NODE_ENV !== "production" && process.env.DEALDOCK_DISABLE_AUTH === "true";

export default AUTH_DISABLED
  ? () => NextResponse.next()
  : clerkMiddleware(async (auth, req) => {
      if (!isPublicRoute(req)) {
        await auth.protect();
      }
    });

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
