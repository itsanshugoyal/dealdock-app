/** Clerk supports both legacy and compact v2 organization session claims. */
export function organizationClaim(claims: Record<string, unknown>): string | undefined {
  const compact = claims.o as {id?:unknown}|undefined;
  const id = claims.org_id ?? compact?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
export function organizationAdminClaim(claims: Record<string, unknown>): boolean {
  const compact = claims.o as {rol?:unknown}|undefined;
  return claims.org_role === "org:admin" || compact?.rol === "admin" || compact?.rol === "adm";
}
/** The session token of a `Bearer` Authorization header. */
export function bearerToken(authorization: string | undefined): string | undefined {
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
}
/** The Clerk user's primary email address, only when Clerk reports it verified. */
export function verifiedPrimaryEmail(user: { primaryEmailAddress: { emailAddress: string; verification: { status: string } | null } | null }): string | null {
  const primary = user.primaryEmailAddress;
  return primary?.verification?.status === "verified" ? primary.emailAddress : null;
}
/**
 * Options for Clerk's verifyToken. In production a session token must also
 * come from the one web origin (its `azp` claim), as Clerk advises when the
 * app and the API sit on sibling subdomains. A missing or invalid
 * WEB_APP_URL throws, so the caller answers 401 instead of skipping the check.
 */
export function clerkVerifyOptions(secretKey: string): { secretKey: string; authorizedParties?: string[] } {
  if (process.env.NODE_ENV !== "production") return { secretKey };
  return { secretKey, authorizedParties: [new URL(process.env.WEB_APP_URL ?? "").origin] };
}
