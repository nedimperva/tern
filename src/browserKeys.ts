// Tern runs in a web view (WebView2 on Windows, WebKitGTK on Linux), which still answers the browser's own keys:
// F5 reloads the whole app, Ctrl+P prints the window, Ctrl+F opens a find bar over it, Alt+Left goes "back" to
// nowhere, and a right-click offers Back, Refresh and Print. None of that belongs in a mail app, so released builds
// take those away. A build from source keeps them, for reloading and inspecting while developing.

/** Browser keys with no meaning in Tern. Ctrl+Shift+P is the performance overlay, so only plain Ctrl+P goes. */
function browserKey(e: KeyboardEvent): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (e.key === "F5" || e.key === "F3" || e.key === "F7" || e.key === "BrowserBack" || e.key === "BrowserForward") return true;
  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return true;
  if (ctrl && !e.shiftKey && !e.altKey && (key === "r" || key === "p" || key === "f" || key === "g" || key === "u" || key === "j" || key === "h"))
    return true;
  return ctrl && e.shiftKey && key === "r";
}

/** Where the right-click menu stays: text fields and selected text, for cut, copy and paste. */
function wantsMenu(target: EventTarget | null): boolean {
  if (String(window.getSelection() ?? "").trim()) return true;
  const el = target instanceof Element ? target : null;
  return !!el?.closest("input, textarea, [contenteditable=''], [contenteditable='true'], .ProseMirror");
}

/** The right-click menu only where it helps; also for a message's frame, which has a document of its own. */
export function quietMenu(doc: Document) {
  if (!import.meta.env.PROD) return;
  doc.addEventListener("contextmenu", (e) => {
    const selected = String(doc.getSelection() ?? "").trim();
    if (!selected && !wantsMenu(e.target)) e.preventDefault();
  });
}

export function quietBrowserKeys() {
  if (!import.meta.env.PROD) return;
  // Caught first, so whatever else listens, the web view itself never acts on them.
  window.addEventListener(
    "keydown",
    (e) => {
      if (browserKey(e)) e.preventDefault();
    },
    true,
  );
  quietMenu(document);
  // The mouse's back and forward buttons.
  window.addEventListener("mouseup", (e) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  });
}
