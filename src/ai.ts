// What the keyboard asks of AI (package 10): Shift+S in a conversation summarizes it, or opens and closes the
// summary already there. The summary under the subject answers.

import { createSignal } from "solid-js";

const [summons, setSummons] = createSignal(0);
/** Changes each time Shift+S asks; the open conversation's summary watches it. */
export { summons };
export const summon = () => setSummons((n) => n + 1);
