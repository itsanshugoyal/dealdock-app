/** Fixed-tenant localhost bridge for real integration tests, never a deployed auth bypass. */
const API_ROOTS=new Set(["onboarding","inbox","review-queue","dashboard","threads","classifications","ledger","settings","notifications","billing","account","me","seats","roster","ig","voice","offers","insights","audit","drafts","media","metrics","organizations"]);
async function proxy(request:Request,context:{params:Promise<{path:string[]}>}) {
  if(process.env.NODE_ENV!=="development"||process.env.DEALDOCK_DISABLE_AUTH!=="true"||!process.env.DEALDOCK_DEV_ORG_ID||!process.env.DEALDOCK_API_URL) return new Response(null,{status:404});
  const incoming=new URL(request.url),origin=request.headers.get("origin");
  if(origin&&origin!==incoming.origin||request.headers.get("sec-fetch-site")==="cross-site") return new Response(null,{status:403});
  const base=new URL(process.env.DEALDOCK_API_URL);
  if(base.protocol!=="http:"||!["localhost","127.0.0.1","[::1]"].includes(base.hostname)) return new Response(null,{status:503});
  const {path}=await context.params;
  if(!path.length||path.some(segment=>!segment||segment==="."||segment===".."||!/^[a-zA-Z0-9._-]+$/.test(segment))||!API_ROOTS.has(path[0]!)) return new Response(null,{status:404});
  const target=new URL('/'+path.map(encodeURIComponent).join('/'),base);target.search=incoming.search;
  const headers=new Headers({"x-demo-org":process.env.DEALDOCK_DEV_ORG_ID});
  for(const name of ["content-type","idempotency-key"])if(request.headers.has(name))headers.set(name,request.headers.get(name)!);
  const response=await fetch(target,{method:request.method,headers,body:["GET","HEAD"].includes(request.method)?undefined:await request.arrayBuffer(),cache:"no-store",redirect:"manual",signal:AbortSignal.timeout(20_000)});
  // Bodies stream through untouched, so /media audio bytes reach <audio> byte-exact with their content-type.
  const responseHeaders=new Headers({"Cache-Control":"no-store"});
  for(const name of ["content-type","content-disposition"])if(response.headers.has(name))responseHeaders.set(name,response.headers.get(name)!);
  return new Response(response.body,{status:response.status,headers:responseHeaders});
}
export {proxy as GET,proxy as POST,proxy as PUT,proxy as PATCH,proxy as DELETE};
