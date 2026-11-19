// A conversation in a window of its own (idea 123, Shift+Enter): to keep it beside another mail, or on a second
// screen. Read only here; Reply hands over to the main window, where compose lives. It follows changes as the main
// window does, from the same database.

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { api, type ThreadMessage } from "../api";
import { isMine } from "../app/actions";
import { setAccounts } from "../app/state";
import { loadSettings } from "../settings";
import { AttachmentViewer } from "./AttachmentViewer";
import { ConversationView } from "./ConversationView";

/** The message id a conversation window was opened for, from its address; null in the main window. */
export const ownWindowId = (): number | null => {
  const m = location.hash.match(/^#window=(\d+)$/);
  return m ? Number(m[1]) : null;
};

export function OwnWindow(props: { id: number }) {
  const [messages, setMessages] = createSignal<ThreadMessage[]>([]);
  const [focused, setFocused] = createSignal(0);
  const [viewing, setViewing] = createSignal<{ message: ThreadMessage; index: number } | null>(null);
  const [gone, setGone] = createSignal(false);
  const read = async () => {
    try {
      const got = (await api.thread(props.id)).filter((m) => m.draftId == null);
      if (!got.length) return setGone(true);
      setMessages(got);
      setFocused((f) => Math.min(f, got.length - 1) || got.length - 1);
      document.title = got[0].subject || "(no subject)";
    } catch {
      setGone(true);
    }
  };
  const closeWindow = () => void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().close()).catch(() => window.close());
  const reply = () => void api.replyInMain(messages()[messages().length - 1]?.id ?? props.id);
  const onKey = (e: KeyboardEvent) => {
    if (viewing() || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "Escape") closeWindow();
    else if (e.key === "r" || e.key === "Enter") reply();
    else if (e.key === "n" || e.key === "j") setFocused(Math.min(messages().length - 1, focused() + 1));
    else if (e.key === "p" || e.key === "k") setFocused(Math.max(0, focused() - 1));
    else return;
    e.preventDefault();
  };
  onMount(() => {
    void loadSettings();
    void api.accounts().then(setAccounts, () => {});
    void read();
    api.onChange(() => void read());
    window.addEventListener("keydown", onKey);
  });
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="window own-window">
      <Show when={!gone()} fallback={<p class="own-gone">This conversation is no longer here.</p>}>
        <Show when={messages().length}>
          <section class="conversation-pane">
            <ConversationView
              messages={messages()}
              labels={[]}
              focused={focused()}
              expanded={() => true}
              mine={isMine}
              replying={false}
              onToggle={setFocused}
              onReply={() => reply()}
              onView={(message, index) => setViewing({ message, index })}
              onDone={closeWindow}
              onClose={closeWindow}
              onQuote={reply}
              shelf={{ on: false, toggle: () => {} }}
              onSnoozeUntil={() => {}}
              menu={() => []}
              person={{ write: () => {}, search: () => {}, open: () => {} }}
            />
          </section>
        </Show>
      </Show>
      <Show when={viewing()}>{(v) => <AttachmentViewer message={v().message} index={v().index} onClose={() => setViewing(null)} />}</Show>
    </div>
  );
}
