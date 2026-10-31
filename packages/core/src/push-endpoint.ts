/** Pilot-supported browser push services. Arbitrary subscription URLs are SSRF. */
export function isTrustedPushEndpoint(value:string):boolean {
  try {
    const url=new URL(value);
    if(url.protocol!=="https:"||url.username||url.password||(url.port&&url.port!=="443")||value.length>4096) return false;
    return ["fcm.googleapis.com","updates.push.services.mozilla.com","web.push.apple.com"].includes(url.hostname)||url.hostname.endsWith(".push.apple.com")||url.hostname.endsWith(".notify.windows.com");
  } catch { return false; }
}
