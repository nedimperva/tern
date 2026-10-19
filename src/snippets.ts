// Snippets (package 07): text typed after `;` in compose, with places filled in for the person written to.

/** The places a snippet can hold, in the order settings offers them. `{cursor}` is where typing goes on. */
export const PLACES = [
  { key: "first_name", label: "first name" },
  { key: "name", label: "name" },
  { key: "email", label: "email" },
  { key: "subject", label: "subject" },
  { key: "my_name", label: "my name" },
  { key: "date", label: "date" },
  { key: "cursor", label: "cursor here" },
] as const;

/** A snippet's text with its places filled: `{first_name}`, `{name}` and `{email}` of the first person it goes to,
 * `{subject}`, `{my_name}` and `{date}`. `{cursor}` stays for the editor; unknown places stay as typed. */
export function fillSnippet(
  body: string,
  to: { email: string; name: string } | null,
  subject: string,
  myName: string,
  now = new Date(),
): string {
  const name = to?.name.trim() ?? "";
  // Without a name, a local part such as "ada" or "ada.lovelace" still gives a first name.
  const local = to?.email.split("@")[0].split(/[._-]/)[0] ?? "";
  const first = name.split(/\s+/)[0] || (/^\p{L}+$/u.test(local) ? local[0].toUpperCase() + local.slice(1) : "");
  const values: Record<string, string> = {
    first_name: first,
    name: name || to?.email || "",
    email: to?.email ?? "",
    subject: subject.replace(/^((re|fwd?|aw|sv):\s*)+/i, ""),
    my_name: myName,
    date: now.toLocaleDateString(undefined, { dateStyle: "long" }),
  };
  return body.replace(/\{(\w+)\}/g, (place, key: string) => values[key] ?? place);
}
