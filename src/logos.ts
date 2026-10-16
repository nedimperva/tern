// Sender logos (Settings → Reading, off by default). The engine keeps them; the first look at a sender asks for
// theirs in the background, and the avatar fills in when "logo" says one arrived.
import { createSignal, type Setter } from "solid-js";
import { api } from "./api";
import { settings } from "./settings";

type Entry = { get: () => string | null; set: Setter<string | null>; found: boolean };
const known = new Map<string, Entry>();

function ask(addr: string, entry: Entry) {
  void api.senderLogo(addr).then(
    (uri) => {
      if (uri) (entry.found = true), entry.set(uri);
    },
    () => {},
  );
}

// A fetch finished somewhere: ask again for everyone still without one (few, and answered from the cache).
api.onLogo(() => {
  for (const [addr, entry] of known) if (!entry.found) ask(addr, entry);
});

/** The logo for an address, or null for initials. Reactive: it fills in once fetched. */
export function logoFor(addr: string): string | null {
  if (!settings.senderLogos) return null;
  const key = addr.toLowerCase();
  let entry = known.get(key);
  if (!entry) {
    const [get, set] = createSignal<string | null>(null);
    entry = { get, set, found: false };
    known.set(key, entry);
    ask(key, entry);
  }
  return entry.get();
}
