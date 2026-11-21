/**
 * First-run onboarding: which steps a person walks, in what order, and when
 * the app sends a new user there. Pure, so both paths are unit-tested.
 */

export type Step = "welcome" | "region" | "connect" | "email" | "business" | "voice" | "scan" | "reveal" | "done";

/** Every step, in walking order. */
export const STEPS: Step[] = ["welcome", "region", "connect", "email", "business", "voice", "scan", "reveal", "done"];

const LABELS: Partial<Record<Step, string>> = { region: "Region", connect: "Instagram", email: "Email", business: "Business", voice: "Voice", scan: "Scan" };

/** `instagram`: an account is connected (or still on the way); `gmail`: this deployment can connect Gmail. */
export interface FlowContext { instagram: boolean; gmail: boolean }

/**
 * The steps this person walks. Gmail inboxes belong to an Instagram account,
 * and voice and the Leak Scan read Instagram DMs, so without Instagram setup
 * ends on "done".
 */
export function flowSteps({ instagram, gmail }: FlowContext): Step[] {
  if (!instagram) return ["welcome", "region", "connect", "business", "done"];
  return ["welcome", "region", "connect", ...(gmail ? (["email"] as const) : []), "business", "voice", "scan", "reveal"];
}

/** What the progress bar counts and labels (welcome and the final screen sit outside it). */
export function progressSteps(context: FlowContext): Array<{ step: Step; label: string }> {
  return flowSteps(context).flatMap((step) => (LABELS[step] ? [{ step, label: LABELS[step] }] : []));
}

/** The step after this one on this person's path; a step not on it (Gmail just turned out unavailable) moves on too. */
export function nextStep(step: Step, context: FlowContext): Step {
  const path = flowSteps(context);
  return STEPS.slice(STEPS.indexOf(step) + 1).find((candidate) => path.includes(candidate)) ?? step;
}

/** The `step` query param; Instagram's callback returns with only `connected` or `error`, which means the Connect step. */
export function stepFromQuery(requested: string | null | undefined, fromInstagram: boolean): Step {
  if (requested && (STEPS as string[]).includes(requested)) return requested as Step;
  return fromInstagram ? "connect" : "welcome";
}

/** Signing in, and Settings (where a workspace is managed), keep the setup card instead of redirecting. */
const NO_SETUP_REDIRECT = ["/onboarding", "/sign-in", "/sign-up", "/settings"];

/** A signed-in person with no workspace yet goes straight to onboarding; demo mode always has one. */
export function shouldRedirectToSetup({ demo, setupNeeded, pathname }: { demo: boolean; setupNeeded: boolean; pathname: string }): boolean {
  return !demo && setupNeeded && !NO_SETUP_REDIRECT.some((prefix) => pathname.startsWith(prefix));
}

export const PILOT_CONTACT = "hello@dealdock.io";

/**
 * "Before you connect", shown until Meta grants Advanced Access
 * (`instagramOpenAccess`): only accounts added as Instagram Testers can
 * connect, and Meta's own screen doesn't say why others fail.
 */
export function connectChecklist(openAccess: boolean): Array<{ title: string; body: string }> {
  if (openAccess) return [];
  return [
    { title: "A Creator or Business account", body: "On a personal account? Switching is free and takes about two minutes: Instagram → Settings → Account type and tools → Switch to professional account." },
    { title: "We add you as a tester", body: `During the private pilot, message your Instagram username to ${PILOT_CONTACT}. We'll add you within a day.` },
    { title: "Accept the invite", body: "Instagram → Settings → Apps and websites → Tester invites. It's easiest on instagram.com." },
  ];
}

/** Instagram connection failures (the callback's `error`, or POST /ig/connect's code) in plain words. */
export function friendlyConnectError(code: string): string {
  if (/meta_app_not_configured/.test(code)) return "Instagram connections open soon. You can finish setup and connect later.";
  if (/no_instagram_account/.test(code)) return "No Instagram account was shared. Reconnect and choose your professional account.";
  if (/personal/i.test(code)) return "That's a personal account. Switch it to Creator or Business, then try again.";
  if (/denied|cancel/i.test(code)) return "Instagram didn't give access. Try again when you're ready.";
  if (/ig_account_limit/.test(code)) return "Your plan's Instagram accounts are all connected. Disconnect one in Settings, or change plan, to add another.";
  if (/invalid_state/.test(code)) return "That connection link expired. Start again here.";
  return "Instagram didn't finish connecting. Try again.";
}

/** Google sends people back with ?email_error=<code>; each gets a plain sentence (Settings and onboarding). */
export const EMAIL_ERRORS: Record<string, string> = {
  access_denied: "Google access wasn't allowed, so no inbox was connected.",
  oauth_failed: "Google couldn't finish connecting. Try again.",
  invalid_state: "That connection link expired. Start again here.",
  scopes_missing: "DealDock needs permission to read and send email. Connect again and keep both boxes ticked.",
  connection_failed: "Gmail couldn't be connected. Try again.",
  email_account_limit: "Your plan can't connect another inbox. Disconnect one first.",
  email_connected_to_other_creator: "That inbox is already connected for another creator.",
  account_connected_to_other_org: "That inbox is connected to another DealDock workspace.",
  ig_account_not_in_org: "That creator isn't in this workspace any more.",
};
