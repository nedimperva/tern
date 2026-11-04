// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { markQuotes } from "../fold";

const NOTICE_TEXT = "This message is confidential and is intended only for the intended recipient. Do not copy it.";

describe("markQuotes", () => {
  it("folds a legal notice under the words of the mail", () => {
    const doc = new DOMParser().parseFromString(`<body><p>Hello there.</p><p>${NOTICE_TEXT}</p></body>`, "text/html");
    markQuotes(doc);
    expect(doc.querySelector("p:last-of-type")?.classList.contains("tern-quote")).toBe(true);
  });

  it("does not fold a whole newsletter because its footer notice sits in the wrapper", () => {
    const body = "<p>Our news for the month, with a long story about what we did and why it matters to you.</p>".repeat(40);
    const doc = new DOMParser().parseFromString(
      `<body><div class="wrap"><style>.a{color:red}</style>${body}${NOTICE_TEXT}</div></body>`,
      "text/html",
    );
    markQuotes(doc);
    expect(doc.querySelectorAll(".tern-quote").length).toBe(0);
  });

  it("ignores notice words in a style block", () => {
    const doc = new DOMParser().parseFromString(
      `<body><p>Hello.</p><style>/* ${NOTICE_TEXT} */ .a{}</style></body>`,
      "text/html",
    );
    markQuotes(doc);
    expect(doc.querySelectorAll(".tern-quote").length).toBe(0);
  });
});
