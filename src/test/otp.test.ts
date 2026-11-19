// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { oneTimeCode } from "../facts";

describe("oneTimeCode", () => {
  it("finds sign-in codes however they are put", () => {
    expect(oneTimeCode("Your verification code is 482913. It expires in 10 minutes.")).toBe("482913");
    expect(oneTimeCode("482913 is your Example login code")).toBe("482913");
    expect(oneTimeCode("G-551204 is your Google verification code.")).toBe("551204");
    expect(oneTimeCode("Use 123 456 to sign in. Your one-time code")).toBe("123456");
    expect(oneTimeCode("Vaš jednokratni kod je 7731.")).toBe("7731");
    expect(oneTimeCode("Kod za prijavu: 90412")).toBe("90412");
  });

  it("leaves other numbers alone", () => {
    expect(oneTimeCode("Your order 123456 has shipped.")).toBeNull();
    expect(oneTimeCode("Security code update for 2026: nothing to do.")).toBeNull();
    expect(oneTimeCode("Meeting at 14:30 about the login code review")).toBeNull();
    expect(oneTimeCode("Confirm your code: you owe $1200")).toBeNull();
  });
});
