import {expect,it} from "vitest";
import {isTrustedPushEndpoint} from "../src/push-endpoint";
it.each(["https://fcm.googleapis.com/fcm/send/test","https://web.push.apple.com/test","https://updates.push.services.mozilla.com/wpush/v2/test","https://s1.notify.windows.com/test"])("accepts supported push endpoint %s",url=>expect(isTrustedPushEndpoint(url)).toBe(true));
it.each(["http://fcm.googleapis.com/test","https://127.0.0.1/test","https://[::1]/test","https://169.254.169.254/latest/meta-data","https://fcm.googleapis.com.evil.test/test","https://fcm.googleapis.com@evil.test/test","https://evil.test/fcm.googleapis.com","https://fcm.googleapis.com:8443/test","file:///etc/passwd","not a URL"])("rejects SSRF or lookalike endpoint %s",url=>expect(isTrustedPushEndpoint(url)).toBe(false));
