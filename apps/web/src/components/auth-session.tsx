"use client";

import { OrganizationList, useAuth, useClerk } from "@clerk/nextjs";
import { createContext, useContext, useLayoutEffect, useMemo } from "react";
import { apiStore } from "../lib/api-store";

/** Account actions the shell can offer; absent outside Clerk (local integration, keyless CI). */
export interface AuthActions { signOut?: () => void }
const AuthActionsContext = createContext<AuthActions>({});
export const useAuthActions = () => useContext(AuthActionsContext);

/** Keeps the API token memory-only and resets data before a Clerk identity changes. */
export function AuthSession({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, userId, orgId, getToken } = useAuth();
  const clerk = useClerk();
  useLayoutEffect(() => {
    apiStore.authenticate(isSignedIn && userId && orgId ? `${userId}:${orgId}` : null, isSignedIn ? () => getToken() : null);
  }, [getToken, isLoaded, isSignedIn, orgId, userId]);
  const actions = useMemo<AuthActions>(() => ({ signOut: () => void clerk.signOut({ redirectUrl: "/sign-in" }) }), [clerk]);
  if (isLoaded && isSignedIn && !orgId) {
    return (
      <main id="main-content" tabIndex={-1} className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-canvas p-5 outline-none">
        <h1 className="text-title text-ink">Choose a workspace</h1>
        <OrganizationList hidePersonal afterSelectOrganizationUrl="/onboarding" afterCreateOrganizationUrl="/onboarding" />
      </main>
    );
  }
  return <AuthActionsContext.Provider value={actions}>{children}</AuthActionsContext.Provider>;
}
