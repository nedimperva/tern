// List-Unsubscribe, read the same way wherever Tern offers to unsubscribe: in a conversation and in Settings →
// Who writes most.

import type { Mailto } from "./api";

/** Where List-Unsubscribe points: a web page opens in the browser, an address gets a mail to send. */
export function unsubscribeTarget(header: string | null): { web: string } | { mail: Mailto } | null {
  const links = [...(header ?? "").matchAll(/<([^>]+)>/g)].map((x) => x[1].trim());
  const web = links.find((l) => /^https?:\/\//i.test(l));
  if (web) return { web };
  const mail = links.find((l) => /^mailto:/i.test(l));
  if (!mail) return null;
  const [addr, query = ""] = mail.slice("mailto:".length).split("?");
  const q = new URLSearchParams(query);
  return { mail: { to: [decodeURIComponent(addr)], cc: [], bcc: [], subject: q.get("subject") ?? "Unsubscribe", body: q.get("body") ?? "" } };
}
