// What the keyboard asks of AI (package 10). Shift+S in a conversation summarizes it, or opens and closes the
// summary already there; Q asks for suggested replies, and 1–3 start a reply with one. The components under the
// subject and above the reply row answer.

import { createSignal } from "solid-js";

const [summons, setSummons] = createSignal(0);
/** Changes each time Shift+S asks; the open conversation's summary watches it. */
export { summons };
export const summon = () => setSummons((n) => n + 1);

const [replyAsks, setReplyAsks] = createSignal(0);
/** Changes each time Q asks for suggested replies. */
export { replyAsks };
export const askReplies = () => setReplyAsks((n) => n + 1);

/** The suggestions on show, for the 1–3 keys; empty when there are none. */
export const [suggestions, setSuggestions] = createSignal<string[]>([]);
