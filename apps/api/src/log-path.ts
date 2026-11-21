/**
 * The path a request log records: never the query string, and never a
 * booking or payment tool's secret address token (/webhooks/leads/<token>),
 * which works like a password for that tool's reports.
 */
export function loggedPath(url: string): string {
  return url.split("?")[0]!.replace(/^\/webhooks\/leads\/[^/#]+/, "/webhooks/leads/:token");
}
