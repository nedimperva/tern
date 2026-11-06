import { describe, expect, it } from "vitest";
import { plainError } from "../plainError";

describe("plainError", () => {
  it("says what a refused address means, with its codes", () => {
    const p = plainError("permanent error (550): 5.1.1 Recipient address rejected: no such user");
    expect(p.said).toMatch(/no such address/);
    expect(p.code).toBe("550 5.1.1");
  });
  it("keeps an unknown error as it is", () => {
    expect(plainError("something odd")).toEqual({ said: "something odd", code: "" });
  });
  it("names a send that may have gone out", () => {
    expect(plainError("The connection broke after the message was handed over, so it may have been sent").said).toBe(
      "The connection broke after the message was handed over.",
    );
  });
});
