import { batch, createMemo, lazy, onCleanup, onMount, Show, Suspense } from "solid-js";
import { api } from "./api";
import { AccountSetup } from "./components/AccountSetup";
import { CommandBar } from "./components/CommandBar";
import { Compose } from "./components/Compose";
import { ConversationView } from "./components/ConversationView";
import { ListPane } from "./components/ListPane";
import { ProblemsDialog } from "./components/Problems";
import { Rail } from "./components/Rail";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { LabelPicker } from "./components/LabelPicker";
import { SnoozePicker } from "./components/SnoozePicker";
import { AttachmentViewer } from "./components/AttachmentViewer";
import { PerfOverlay } from "./components/PerfOverlay";
import { DayDeck } from "./components/DayDeck";
import { DayScreen } from "./components/DayScreen";
import { timeKey } from "./perf";
import { loadSettings, settings } from "./settings";
import { deck, screen, start, startDay } from "./day";
import { keyHandler } from "./keys";
import { hitWords } from "./hits";
import { act, label, labelsOf, onShelf, shelve, snoozeThen, snoozeUntil, targets } from "./app/actions";
import { bindings as allBindings, commands as allCommands, menu } from "./app/bindings";
import { close, toggleMessage, watchConversation } from "./app/conversation";
import {
  composeClosed,
  composeDiscarded,
  fromLink,
  newMessage,
  openMail,
  person,
  reply,
  replyToMail,
  respond,
  resume,
  send,
  watchCompose,
} from "./app/composing";
import { closeDeck, deckRows, doneUpdates, firstName, runDeck } from "./app/deck";
import { forgetSearch, isTarget, go, loadSignatures, onChange, readProgress, refresh, runSearch, watchList } from "./app/list";
import { keyOf } from "./app/rows";
import {
  accounts,
  compose,
  composeMin,
  context,
  dialog,
  expanded,
  focusMode,
  folders,
  labeling,
  messageFocus,
  messages,
  online,
  openRow,
  palette,
  paletteStart,
  perf,
  problems,
  query,
  rail,
  ready,
  reviewing,
  rows,
  searching,
  settingsOpen,
  setAccounts,
  setComposeMin,
  setIdle,
  setLabeling,
  setOnline,
  setPalette,
  setPaletteStart,
  setProgress,
  setRail,
  setReviewing,
  setSettingsOpen,
  setSetup,
  setSheet,
  setSnoozing,
  setSyncStates,
  setUpdate,
  setViewing,
  setWaiting,
  setup,
  setWidth,
  sheet,
  signatures,
  snoozing,
  syncStates,
  viewing,
  width,
} from "./app/state";
import { clock, held, late, scheduled, watchStatus } from "./app/status";
import { showToast } from "./app/toast";
// Settings open seldom: their page is a chunk of its own.
const SettingsPage = lazy(() => import("./components/SettingsPage").then((m) => ({ default: m.SettingsPage })));

/** With the "auto" open mode, from this width an open conversation sits beside the list; narrower, it covers it. */
const SPLIT_WIDTH = 1200;
/** Below this width there is no room for the list beside a conversation, whatever the setting (§3). */
const MIN_SPLIT_WIDTH = 960;

/** The main window. Its state and what the keys do live in src/app; this lays them out and starts them. */
export default function App() {
  watchList();
  watchConversation();
  watchCompose();
  watchStatus();

  const hits = createMemo(() => (searching() ? hitWords(query()) : undefined));
  /** Conversations that need the person, for the dot in their rows. */
  const needsYou = createMemo(() => new Set((start()?.needYou ?? []).map(keyOf)));
  const bindings = createMemo(allBindings);
  const commands = createMemo(() => allCommands(bindings()));

  onMount(() => {
    void api.syncProgress().then(setProgress, () => {});
    api.onSyncState((id, state) => {
      setSyncStates({ ...syncStates(), [id]: state });
      readProgress();
      // A lost connection can put work back in the queue without a mail change.
      void api.waiting().then(setWaiting);
    });
    void api.syncStates().then((s) => setSyncStates({ ...s, ...syncStates() }));
    api.onChange(onChange);
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
    // The system knows before a dead connection times out; reconnect now rather than after the retry wait.
    const onOnline = () => (setOnline(true), api.networkBack());
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    onCleanup(() => (window.removeEventListener("online", onOnline), window.removeEventListener("offline", onOffline)));
    void loadSettings().then(startDay);
    void refresh();
    // The tray, the system's links and notifications. Closing the window leaves Tern in the tray unless turned off.
    api.keepRunningWhen(() => settings.background);
    api.onDesktop({
      compose: newMessage,
      mailto: fromLink,
      openMail: (m) => void openMail(m),
      reply: (m) => void replyToMail(m),
      // A notification about scheduled sends waiting: the list they wait in.
      waiting: () => batch(() => (setSettingsOpen(null), setReviewing(true))),
    });
    void api.takeMailto().then((m) => m && fromLink(m));
    // Said once as it arrives; the status strip keeps offering it after.
    api.onUpdateReady((v) => (setUpdate(v), showToast(`Tern ${v} is ready. Restart to update from the status bar.`, [])));
    void api.updateReady().then((v) => v && setUpdate(v));
    // Fetch the compose editor while the person reads, so the first "c" opens at once.
    const warm = () => void import("./components/Editor");
    if ("requestIdleCallback" in window) requestIdleCallback(warm);
    else setTimeout(warm, 1500);
  });

  const handleKey = keyHandler(bindings, context, dialog);
  let idleTimer: number | undefined;
  const onKeyDown = (e: KeyboardEvent) => {
    timeKey(e);
    setIdle(false);
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => setIdle(true), 2000);
    if (composeMin() && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "m") {
      e.preventDefault();
      setComposeMin(false);
      return;
    }
    handleKey(e);
  };
  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    idleTimer = window.setTimeout(() => setIdle(true), 2000);
  });
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  const roomForSplit = () =>
    focusMode() || settings.openMode === "full"
      ? false
      : width() >= (settings.openMode === "split" ? MIN_SPLIT_WIDTH : SPLIT_WIDTH);
  const split = () => openRow() !== null && roomForSplit();

  return (
    <div class="app" classList={{ split: split(), full: openRow() !== null && !roomForSplit() }}>
      <ListPane split={split()} hits={hits()} needsYou={needsYou()} />

      <Show when={openRow()}>
        <section class="conversation-pane">
          <ConversationView
            messages={messages}
            hits={hits()}
            labels={rows().find((r) => keyOf(r) === keyOf(openRow()!))?.labels ?? openRow()?.labels ?? []}
            focused={messageFocus()}
            expanded={(id) => expanded().has(id)}
            mine={(addr) => accounts().some((a) => a.email.toLowerCase() === addr.toLowerCase())}
            replying={!!compose()?.inline}
            onToggle={toggleMessage}
            onReply={(m, kind, text) => respond(m, kind, undefined, text)}
            onView={(message, index) => setViewing({ message, index })}
            onMailto={fromLink}
            onDone={() => act("archive")}
            onClose={close}
            onQuote={() => void reply()}
            shelf={{ on: onShelf(), toggle: () => void shelve() }}
            onSnoozeUntil={(due) => {
              if (!targets().length) return;
              setSnoozing(targets());
              void snoozeUntil(due);
            }}
            menu={() => menu(bindings())}
            person={person}
          />
          <Show when={compose()?.inline ? compose() : null}>
            {(init) => (
              <div class="inline-reply">
                <Compose accounts={accounts()} signatures={signatures()} init={init()} onSend={send} onClose={composeClosed} onDiscard={composeDiscarded} />
              </div>
            )}
          </Show>
        </section>
      </Show>

      <Show when={rail()}>
        <Rail
          accounts={accounts()}
          folders={folders()}
          syncStates={syncStates()}
          isTarget={isTarget}
          onGo={go}
          onAddAccount={() => setSetup(true)}
          onClose={() => setRail(false)}
          searches={settings.savedSearches}
          searching={query().trim()}
          onSearch={runSearch}
          onForget={forgetSearch}
        />
      </Show>
      <Show when={reviewing()}>
        <ProblemsDialog
          problems={problems()}
          waiting={[...held(), ...late()]}
          scheduled={scheduled()}
          onSendNow={(id) => void api.sendNow(id).then(() => refresh())}
          offline={!online() || Object.values(syncStates()).includes("offline")}
          now={clock()}
          onDiscardWaiting={(id) =>
            void api.discardWaiting(id).then((done) => {
              if (!done) showToast("It went out, or later changes depend on it, so it stays.", []);
              void refresh();
            })
          }
          onRetry={(id) => void api.retryProblem(id).then(() => refresh())}
          onDiscard={(id) => void api.discardProblem(id).then(() => refresh())}
          onEdit={(id) => void api.problemToDraft(id).then((record) => (setReviewing(false), resume(record), refresh()))}
          onClose={() => setReviewing(false)}
        />
      </Show>
      <Show when={settingsOpen()}>
        {(section) => (
          <Suspense>
            <SettingsPage
              accounts={accounts()}
              section={section()}
              onClose={() => (setSettingsOpen(null), loadSignatures())}
              onAccountsChanged={() => void api.accounts().then(setAccounts)}
            />
          </Suspense>
        )}
      </Show>
      <Show when={screen() && start()}>
        <DayScreen
          name={firstName()}
          onStart={() => runDeck("all")}
          onDoneUpdates={() => void doneUpdates()}
          paused={() => compose() !== null || snoozing() !== null || palette()}
        />
      </Show>
      <Show when={deck() !== null && start()}>
        <DayDeck
          rows={deckRows()}
          onReply={(m, text) => void respond(m, "reply", undefined, text)}
          onSnooze={(row, then) => (snoozeThen(then), setSnoozing([row]))}
          onDone={(row) => act("archive", [row])}
          onClose={closeDeck}
          paused={() => (compose() !== null && !composeMin()) || snoozing() !== null || palette()}
        />
      </Show>
      <Show when={perf()}>
        <PerfOverlay />
      </Show>
      <Show when={sheet()}>
        <ShortcutSheet bindings={bindings()} onClose={() => setSheet(false)} />
      </Show>
      <Show when={viewing()}>
        {(v) => <AttachmentViewer message={v().message} index={v().index} onClose={() => setViewing(null)} />}
      </Show>
      <Show when={snoozing()}>
        {(hit) => <SnoozePicker count={hit().length} onPick={(due) => void snoozeUntil(due)} onClose={() => (snoozeThen(null), setSnoozing(null))} />}
      </Show>
      <Show when={labeling()}>
        {(hit) => (
          <LabelPicker
            labels={labelsOf(hit()[0].accountId)}
            applied={(hit()[0].labels ?? []).filter((l) => hit().every((r) => r.labels?.includes(l)))}
            count={hit().length}
            onPick={(f, add) => void label(hit(), f, add)}
            onClose={() => setLabeling(null)}
          />
        )}
      </Show>
      <Show when={palette()}>
        <CommandBar
          commands={commands()}
          start={paletteStart()}
          onClose={() => batch(() => (setPalette(false), setPaletteStart(undefined)))}
        />
      </Show>
      <Show when={compose() && !compose()!.inline ? compose() : null}>
        {(init) => (
          <Compose
            accounts={accounts()}
            signatures={signatures()}
            init={init()}
            onSend={send}
            onClose={composeClosed}
            onDiscard={composeDiscarded}
            minimized={composeMin()}
            onMinimize={setComposeMin}
          />
        )}
      </Show>
      <Show when={setup() || (ready() && accounts().length === 0)}>
        <AccountSetup
          onAdded={() => (setSetup(false), void refresh())}
          onClose={accounts().length ? () => setSetup(false) : undefined}
        />
      </Show>
    </div>
  );
}
