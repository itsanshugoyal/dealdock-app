import {afterEach,describe,expect,it,vi} from "vitest";
import {ApiStore} from "../src/lib/api-store";
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks()});
const at=()=>new Date().toISOString();
const participant=(handle:string)=>({handle,name:null,avatarUrl:null,followerCount:null,verified:null,followsYou:null,closedTotalMinor:0,closedDeals:0,fetchedAt:null});
const inboxRow=(tenant:string)=>({threadId:`${tenant}-thread`,igAccountId:`${tenant}-ig`,participantHandle:tenant,participant:participant(tenant),state:"open",lastMessageAt:at(),lastInboundAt:at(),topLabel:"coaching_lead",estValueMinMinor:null,estValueMaxMinor:null,estCurrencyCode:null,preview:"Coaching?",previewOutbound:false,messageCount:1,unreplied:true,waitingSince:null,nudgeDue:false,draftReady:false,hasAudio:false,dealSignal:false,source:"dm",replyWindow:{status:"open",lastInboundAt:at(),standardClosesAt:null,extendedClosesAt:null,humanAgentEnabled:false}});
const data=(path:string,tenant:string)=>path==="/dashboard"?{org:{currencyCode:"USD",locale:"en-US"},mtdRecoveredMinor:12345,biggestMinor:9000,avgMinor:6173,mtdDealCount:2}:path==="/inbox"?{rows:[inboxRow(tenant)]}:path==="/review-queue"?{rows:[{classificationId:`${tenant}-classification`,threadId:`${tenant}-review`,igAccountId:`${tenant}-ig`,handle:"review",text:"Unsure",sentAt:at(),bestGuess:"uncertain",confidence:0.2,rationale:"Needs a person"}]}:path==="/ledger"?{entries:[]}:path==="/onboarding"?{complete:true}:{rows:[]};
describe("authenticated browser store",()=>{
  it("never requests data without an authenticated identity",async()=>{
    vi.stubGlobal("navigator",{onLine:true});vi.stubEnv("NEXT_PUBLIC_API_URL","https://api.example.test");
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    await expect(new ApiStore().request("/inbox")).rejects.toThrow("session is unavailable");expect(fetch).not.toHaveBeenCalled();
  });
  it("starts a new tenant load immediately and never publishes a late old-tenant response",async()=>{
    vi.stubGlobal("navigator",{onLine:true});vi.stubEnv("NEXT_PUBLIC_API_URL","https://api.example.test");
    const oldResponses:Array<()=>void>=[];
    vi.stubGlobal("fetch",vi.fn((url:string,init:RequestInit)=>{
      const tenant=new Headers(init.headers).get("Authorization")!.slice(7),path=new URL(url).pathname+new URL(url).search;
      const respond=()=>Response.json(data(path,tenant));
      if(tenant==="old")return new Promise<Response>(resolve=>oldResponses.push(()=>resolve(respond())));
      return Promise.resolve(respond());
    }));
    const store=new ApiStore();store.authenticate("old",async()=>"old");
    await vi.waitFor(()=>expect(oldResponses).toHaveLength(6));
    store.authenticate("new",async()=>"new");
    expect(store.getSnapshot().threads).toEqual([]);
    await vi.waitFor(()=>expect(store.getSnapshot().state).toBe("ready"));
    expect(store.getSnapshot().threads[0]).toMatchObject({id:"new-thread",igAccountId:"new-ig"});
    oldResponses.forEach(resolve=>resolve());await Promise.resolve();await Promise.resolve();
    expect(store.getSnapshot().threads.every(thread=>thread.id.startsWith("new"))).toBe(true);
    expect(store.getSnapshot().money.currency).toBe("USD");
    expect(store.getSnapshot().dashboard).toEqual({mtdRecoveredMinor:12345,biggestMinor:9000,avgMinor:6173,mtdDealCount:2});
    const review=store.getSnapshot().threads.find(thread=>thread.id==="new-review");
    expect(review?.messages[0]?.classification?.id).toBe("new-classification");
  });
  it("deduplicates simultaneous refreshes instead of flooding the API",async()=>{
    vi.stubGlobal("navigator",{onLine:true});vi.stubEnv("NEXT_PUBLIC_API_URL","https://api.example.test");
    const fetch=vi.fn(async(url:string)=>Response.json(data(new URL(url).pathname,"actor")));vi.stubGlobal("fetch",fetch);
    const store=new ApiStore();store.authenticate("actor",async()=>"actor");
    await Promise.all([store.refresh(),store.refresh(),store.init()]);
    expect(fetch).toHaveBeenCalledTimes(6);expect(store.getSnapshot().state).toBe("ready");
  });
  it("does not download an old tenant export when the account changes while the body loads", async()=>{
    vi.stubGlobal("navigator",{onLine:true}); vi.stubEnv("NEXT_PUBLIC_API_URL","https://api.example.test");
    let resolveBlob!: (blob: Blob) => void;
    let exportSignal: AbortSignal | undefined;
    const click=vi.fn(); const createObjectURL=vi.fn(()=>"blob:test");
    vi.stubGlobal("document",{createElement:()=>({click})});
    vi.stubGlobal("URL",Object.assign(URL,{createObjectURL,revokeObjectURL:vi.fn()}));
    vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{
      const path=new URL(url).pathname;
      if(path==="/ledger/export.csv") { exportSignal=init.signal as AbortSignal; return {ok:true,blob:()=>new Promise<Blob>(resolve=>{resolveBlob=resolve})}; }
      const tenant=new Headers(init.headers).get("Authorization")!.slice(7);
      return Response.json(data(path,tenant));
    }));
    const store=new ApiStore(); store.authenticate("old",async()=>"old");
    await vi.waitFor(()=>expect(store.getSnapshot().state).toBe("ready"));
    const download=store.download("/ledger/export.csv","ledger.csv");
    await vi.waitFor(()=>expect(resolveBlob).toBeDefined());
    store.authenticate("new",async()=>"new");
    expect(exportSignal?.aborted).toBe(true);
    resolveBlob(new Blob(["old tenant data"]));
    await expect(download).rejects.toThrow("Account changed");
    expect(createObjectURL).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled();
  });

  it("unsubscribes the previous workspace before allowing explicit push opt-in and rejects stale registration", async()=>{
    vi.stubEnv("NEXT_PUBLIC_API_URL","https://api.example.test");
    const storage=new Map([["dealdock.push.owner","old"]]);
    vi.stubGlobal("localStorage",{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)});
    let finishUnsubscribe!:()=>void;
    const unsubscribe=vi.fn(()=>new Promise<void>(resolve=>{finishUnsubscribe=resolve}));
    vi.stubGlobal("navigator",{onLine:true,serviceWorker:{getRegistration:async()=>({pushManager:{getSubscription:async()=>({unsubscribe})}})}});
    vi.stubGlobal("fetch",vi.fn(async(url:string)=>Response.json(data(new URL(url).pathname,"actor"))));
    const store=new ApiStore();store.authenticate("old",async()=>"old");
    const oldIdentity=await store.preparePush();
    store.authenticate("new",async()=>"new");
    let prepared=false;const preparation=store.preparePush().then(identity=>{prepared=true;return identity});
    await vi.waitFor(()=>expect(unsubscribe).toHaveBeenCalledTimes(1));
    expect(prepared).toBe(false);expect(()=>store.confirmPushIdentity(oldIdentity)).toThrow("Account changed");
    finishUnsubscribe();expect(await preparation).toBe("new");
    expect(storage.has("dealdock.push.owner")).toBe(false);
    store.confirmPushIdentity("new");expect(storage.get("dealdock.push.owner")).toBe("new");
  });

});
