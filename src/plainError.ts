/** What a server's refusal means, in a sentence, and the code it came with, small after it (idea 40). The raw text
 * stays the tooltip. Unknown errors are shown as they are. */
export function plainError(raw: string): { said: string; code: string } {
  const t = raw.toLowerCase();
  const reply = /\b([45]\d\d)\b/.exec(raw)?.[1] ?? "";
  const enhanced = /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(raw)?.[1] ?? "";
  const code = [reply, enhanced].filter(Boolean).join(" ");
  const said = (s: string) => ({ said: s, code });
  if (/no such user|user unknown|recipient address rejected|unknown recipient|mailbox unavailable|does not exist|5\.1\.1/.test(t))
    return said("The server says there is no such address. Check who it goes to, then send it again.");
  if (/mailbox full|over quota|quota exceeded|5\.2\.2/.test(t)) return said("The person's mailbox is full. Try again later.");
  if (/too large|size exceeds|message size|5\.3\.4/.test(t)) return said("The message is too large for the server. Send the files another way.");
  if (/spam|policy|blocked|5\.7\.1|blacklist|blocklist/.test(t)) return said("The server refused it as possible spam, or against its rules.");
  if (/authenticat|535|password|credentials/.test(t)) return said("The server refused the sign-in. Check the password in Settings.");
  if (/trycreate|nonexistent|no such mailbox|mailbox doesn't exist|folder.*not found/.test(t))
    return said("The folder is gone on the server.");
  if (/handed over|may have been sent/.test(t)) return said("The connection broke after the message was handed over.");
  if (/timed out|timeout/.test(t)) return said("The server took too long to answer.");
  if (/connection|broken pipe|reset by peer|eof/.test(t)) return said("The connection broke.");
  return { said: raw, code: "" };
}
