// Opening compose: new mail, replies and forwards, saved drafts, `mailto:` links and notifications; and what
// happens when it sends, closes or is discarded.

import { batch, createEffect, on } from "solid-js";
import { api, type Draft, type DraftRecord, type Mailto, type NewMail, type ReplyKind, type SendOptions, type ThreadMessage } from "../api";
import { defaultSignature } from "../components/Compose";
import { until } from "../components/ConversationRow";
import type { PersonActions } from "../components/PersonCard";
import { takeQuote } from "../components/ConversationView";
import { settings } from "../settings";
import { act } from "./actions";
import { close, open } from "./conversation";
import { load, loadSignatures } from "./list";
import { asRow } from "./rows";
import {
  accounts,
  compose,
  home,
  messageFocus,
  messages,
  openRow,
  rows,
  setCompose,
  setComposeMin,
  setFocus,
  setPalette,
  setQuery,
  setReviewing,
  setSettingsOpen,
  setSheet,
  setTarget,
  settingsOpen,
  signatures,
} from "./state";
import { showToast, UNDO_MS } from "./toast";

/** Compose's signature for new mail or a reply from `accountId`: the account's own for that kind, if any, with
 * whatever is quoted. Compose puts the three together. */
const signing = (accountId: number | undefined, kind: "new" | "reply", quote = "", below = false) => ({
  id: defaultSignature(signatures(), accountId ?? accounts()[0]?.id, kind)?.id ?? null,
  kind,
  quote,
  below,
});

/** Compose's own effects; App runs this once. */
export function watchCompose() {
  createEffect(on(compose, () => setComposeMin(false), { defer: true }));
}

/** Opens a reply, reply-all or forward to `m`, set up by the engine from the message's headers. Replies sit
 * under the open conversation; a forward is a new message in its own dialog. */
export async function respond(m: ThreadMessage | undefined, kind: ReplyKind, only?: string, text?: string) {
  if (!m) return;
  const init = await api.replyInit(m.id, kind);
  // Quick quote: with text selected in the message, the reply quotes just that.
  if (only) init.quoteText = only;
  const date = new Date(init.quoteDate * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const quote =
    kind === "forward"
      ? [
          "",
          "",
          "---------- Forwarded message ----------",
          `From: ${init.quoteFrom}`,
          `Date: ${date}`,
          `Subject: ${m.subject}`,
          `To: ${init.quoteTo}`,
          ...(init.quoteCc ? [`Cc: ${init.quoteCc}`] : []),
          "",
          init.quoteText,
        ].join("\n")
      : `\n\nOn ${date}, ${init.quoteFrom} wrote:\n${init.quoteText
          .split("\n")
          .map((l) => (l.startsWith(">") ? `>${l}` : `> ${l}`))
          .join("\n")}`;
  // The signature goes above what is quoted or forwarded, unless set to go below a quote.
  setCompose({
    accountId: init.accountId,
    from: init.from,
    to: init.to,
    cc: init.cc,
    subject: init.subject,
    body: text ?? "",
    signature: signing(init.accountId, "reply", quote, kind !== "forward" && settings.signatureBelow),
    inReplyTo: init.inReplyTo,
    references: init.references,
    focus: kind === "forward" ? "to" : "body",
    quoteOpen: only !== undefined,
    inline: kind !== "forward" && openRow() !== null,
    forwardOf: init.forwardOf,
    forwardFiles: init.forwardOf ? m.attachments : undefined,
  });
}

/** r: continues this conversation's draft if it has one, else replies to the focused message. */
export async function reply() {
  const picked = takeQuote();
  const from = picked && messages.find((m) => m.id === picked.id);
  if (from) return void respond(from, "reply", picked!.text);
  const pending = messages.find((m) => m.draftId != null);
  const record = pending && (await api.draft(pending.draftId!));
  if (record) resume(record, true);
  else void respond(messages[messageFocus()], "reply");
}

/** Opens a saved draft in compose, under its conversation when one is open. */
export function resume(record: DraftRecord, inline = false) {
  const d = record.draft;
  setCompose({
    accountId: record.accountId,
    from: d.from ?? null,
    to: d.to,
    cc: d.cc ?? [],
    bcc: d.bcc ?? [],
    subject: d.subject,
    body: d.body,
    html: d.html ?? null,
    inReplyTo: d.inReplyTo ?? null,
    references: d.references ?? [],
    draftId: record.id,
    attachments: d.attachments ?? [],
    forwardOf: d.forwardOf ?? null,
    htmlSignature: d.htmlSignature ?? null,
    focus: d.to.length ? "body" : "to",
    inline,
  });
}

/** Queues the message (it leaves after the undo window); with `done`, the conversation it answers is marked done. */
export async function send(accountId: number, draft: Draft, done: boolean, draftId: number | null, options: SendOptions = {}) {
  const sending = compose();
  const answering = sending?.inline ? openRow() : null;
  setCompose(null);
  try {
    const token = await api.send(accountId, draft, settings.sendDelay, draftId, options);
    const doneToken = done && answering ? await act("archive", [answering], false) : [];
    const text = options.at
      ? `Sends ${until(options.at)}`
      : settings.sendDelay > 0
        ? "Sending…"
        : "Sent";
    // Undo brings the message back into compose, as it was.
    const reopen = () => setCompose({ ...sending, accountId, ...draft, draftId, focus: "body", unsaved: true });
    // Undo send can wait up to 20 s (Settings), longer than other changes.
    const undoMs = Math.max(UNDO_MS, settings.sendDelay * 1000);
    showToast(done && answering ? `${text} and marked done` : text, [...token, ...doneToken], reopen, undefined, undoMs);
  } catch (e) {
    showToast(String(e), []);
  }
}

export const composeClosed = (saved: number | null) => {
  setCompose(null);
  if (saved != null) showToast("Draft saved", []);
};

export const composeDiscarded = (draftId: number | null) => {
  const was = compose();
  setCompose(null);
  if (draftId == null) return;
  showToast("Draft discarded", [], undefined, async () => {
    if (await api.undoDiscard(draftId)) {
      const record = await api.draft(draftId);
      if (record) resume(record, was?.inline ?? false);
    }
  });
};

export const newMessage = () => setCompose({ body: "", signature: signing(undefined, "new") });

/** What a person's card in the conversation can do. */
export const person: PersonActions = {
  write: (email) => setCompose({ to: [email], body: "", signature: signing(undefined, "new"), focus: "body" }),
  search: (email) => batch(() => (close(), setQuery(`from:${email}`))),
  open: (m) => void open(asRow(m), true),
};

/** A `mailto:` link: compose, filled in from it. */
export function fromLink(m: Mailto) {
  setCompose({
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    body: m.body,
    signature: signing(undefined, "new"),
    focus: m.to.length ? "body" : "to",
  });
}

/** A clicked notification: the inbox, with that conversation open. False when it is no longer there. */
export async function openMail(m: NewMail) {
  // Whatever was over the list goes, or the conversation opens out of sight behind it.
  if (settingsOpen() != null) (setSettingsOpen(null), loadSignatures());
  batch(() => (close(), setQuery(""), setTarget(home()), setPalette(false), setReviewing(false), setSheet(false)));
  await load();
  const i = rows().findIndex((r) => r.accountId === m.accountId && r.threadId === m.threadId);
  if (i < 0) return false;
  setFocus(i);
  await open(rows()[i]);
  return true;
}

/** A notification's Reply: the conversation open, replying to its newest message. */
export async function replyToMail(m: NewMail) {
  if (await openMail(m)) void respond(messages[messages.length - 1], "reply");
}
