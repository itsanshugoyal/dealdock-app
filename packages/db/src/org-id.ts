/** Marker for the org-scoping convention: first arg of every repo function (ADR-7). */
export type OrgId = string & { readonly __brand: "OrgId" };

export function asOrgId(id: string): OrgId {
  return id as OrgId;
}
