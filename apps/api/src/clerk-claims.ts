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
