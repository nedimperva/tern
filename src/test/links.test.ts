import { describe, expect, it } from "vitest";
import { claimedHost, hostOf, misleading } from "../links";
import { linkify } from "../linkify";

describe("hostOf", () => {
  it("names the host without www, or the address for mailto", () => {
    expect(hostOf("https://www.Example.com/x")).toBe("example.com");
    expect(hostOf("mailto:ana@example.org")).toBe("ana@example.org");
    expect(hostOf("javascript:alert(1)")).toBeNull();
    expect(hostOf("not a url")).toBeNull();
  });
});

describe("misleading", () => {
  it("catches text that names another site", () => {
    expect(misleading("paypal.com", "https://evil.example/login")).toBe("paypal.com");
    expect(misleading("https://bank.com/login?x=1", "http://bank.co/")).toBe("bank.com");
  });
  it("lets the same site and its subdomains through", () => {
    expect(misleading("www.paypal.com", "https://paypal.com/a")).toBeNull();
    expect(misleading("paypal.com", "https://login.paypal.com")).toBeNull();
  });
  it("ignores text that is not an address", () => {
    expect(claimedHost("Read the full guide")).toBeNull();
    expect(misleading("Click here", "https://x.example")).toBeNull();
    expect(misleading("ana@example.org", "mailto:bob@example.net")).toBeNull();
  });
});

describe("linkify", () => {
  it("leaves the full stop after a link out", () => {
    expect(linkify("see https://x.org.")).toEqual(["see ", { href: "https://x.org", text: "https://x.org" }, "."]);
  });
  it("keeps a bracket the link opened, drops one around it", () => {
    expect(linkify("(https://en.wikipedia.org/wiki/Up_(film))")).toEqual([
      "(",
      { href: "https://en.wikipedia.org/wiki/Up_(film)", text: "https://en.wikipedia.org/wiki/Up_(film)" },
      ")",
    ]);
  });
  it("gives www. addresses https", () => {
    expect(linkify("www.example.com")).toEqual([{ href: "https://www.example.com", text: "www.example.com" }]);
  });
});
