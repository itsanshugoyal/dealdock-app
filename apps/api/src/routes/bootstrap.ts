import type { FastifyInstance } from "fastify";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { asOrgId, provisionOrganization } from "@dealdock/db";
import { z } from "zod";
import { bearerToken, organizationAdminClaim, organizationClaim, verifiedPrimaryEmail } from "../clerk-claims";

const Body = z.object({currencyCode:z.enum(["INR","USD","GBP","EUR","AED"]),locale:z.string().min(2).max(20),timezone:z.string().min(3).max(80)});
export async function bootstrapRoutes(app:FastifyInstance) {
  app.post("/organizations/bootstrap",async(req,reply)=>{
    const secretKey=process.env.CLERK_SECRET_KEY;
    if(!secretKey) return reply.code(503).send({error:"auth_not_configured"});
    const token=bearerToken(req.headers.authorization);
    if(!token) return reply.code(401).send({error:"unauthenticated"});
    const body=Body.safeParse(req.body);
    if(!body.success) return reply.code(400).send({error:"invalid_body"});
    let claims;
    try { claims=await verifyToken(token,{secretKey}); } catch { return reply.code(401).send({error:"invalid_token"}); }
    const orgId=organizationClaim(claims as Record<string,unknown>);
    if(!orgId||!organizationAdminClaim(claims as Record<string,unknown>)) return reply.code(403).send({error:"organization_admin_required"});
    try { new Intl.DateTimeFormat(body.data.locale,{timeZone:body.data.timezone}).format(); } catch { return reply.code(400).send({error:"invalid_region"}); }
    const clerk=createClerkClient({secretKey});
    const [user,org]=await Promise.all([clerk.users.getUser(claims.sub),clerk.organizations.getOrganization({organizationId:orgId})]);
    const email=verifiedPrimaryEmail(user);
    if(email===null) return reply.code(403).send({error:"verified_email_required"});
    const result=await provisionOrganization(asOrgId(orgId),{...body.data,name:org.name,clerkUserId:claims.sub,email});
    return reply.code(result.created?201:200).send(result);
  });
}
