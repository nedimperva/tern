// Where a link in a mail really goes. Mail is untrusted, and a link's text can name one site while it points at
// another ("paypal.com" over a link to somewhere else): the host is shown on hover, and a mismatch is called out.

/** The host a link opens, without "www.", or the address for mailto:; null for anything else. */
export function hostOf(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol === "mailto:") return decodeURIComponent(url.pathname) || null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return bare(url.hostname);
  } catch {
    return null;
  }
}

/** The site a link's text names, when the text is itself an address ("www.bank.com", "https://bank.com/login"). */
export function claimedHost(text: string): string | null {
  const m = /^\s*(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#]\S*)?\s*$/i.exec(text);
  return m ? bare(m[1]) : null;
}

/** The site the text names, when the link goes somewhere else. A subdomain of the named site, or the site under
 * one of its subdomains, is the same site. */
export function misleading(text: string, href: string): string | null {
  const claimed = claimedHost(text);
  const real = /^https?:/i.test(href) ? hostOf(href) : null;
  if (!claimed || !real) return null;
  const same = claimed === real || real.endsWith(`.${claimed}`) || claimed.endsWith(`.${real}`);
  return same ? null : claimed;
}

function bare(host: string): string {
  return host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}
