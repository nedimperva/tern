// A mail frame's document and window, or null when WebKit won't let us in: it throws a SecurityError, rather than
// answering null, for a frame on its way out (a conversation closing), and a throw in the middle of an update left
// the window half drawn. Every reach into a mail frame goes through here.

export function docOf(frame: HTMLIFrameElement | null | undefined): Document | null {
  try {
    return frame?.contentDocument ?? null;
  } catch {
    return null;
  }
}

export function windowOf(frame: HTMLIFrameElement | null | undefined): Window | null {
  try {
    return frame?.contentWindow ?? null;
  } catch {
    return null;
  }
}
