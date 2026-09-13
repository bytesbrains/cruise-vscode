/**
 * The sentence a refusal becomes.
 *
 * The one thing this file exists to hold: **`budget_exhausted` and
 * `wallet_exhausted` must not say the same thing.** They arrive as the same
 * status and the same OpenAI type, deliberately, and telling a user to wait
 * for a lifetime cap to reset is telling them to wait for something that will
 * never happen.
 */

import { describe, expect, it } from "vitest";
import { explain, humanDelay, readRefusal } from "../src/refusal.ts";

const headers = (entries: Record<string, string> = {}): Headers => new Headers(entries);

describe("readRefusal", () => {
  it("reads the code, the message and the retry-after", () => {
    const refusal = readRefusal(429, headers({ "retry-after": "3600" }), {
      error: { message: "Project 'demo' has reached its budget.", type: "insufficient_quota", param: null, code: "budget_exhausted" },
    });
    expect(refusal).toEqual({
      status: 429,
      code: "budget_exhausted",
      message: "Project 'demo' has reached its budget.",
      retryAfter: 3600,
    });
  });

  it("builds a sentence from the status when the body is not OpenAI-shaped", () => {
    // A proxy, a captive portal, or an endpoint setting pointing somewhere
    // that is not Cruise. The user needs the status, not `undefined`.
    const refusal = readRefusal(502, headers(), "<html>Bad Gateway</html>");
    expect(refusal.code).toBeNull();
    expect(refusal.message).toBe("Cruise refused the request with HTTP 502.");
  });

  it("ignores a retry-after that is not a number of seconds", () => {
    // The HTTP-date form is legal and Cruise never sends it; parsing it as a
    // number yields NaN, and "retry in NaN seconds" is worse than silence.
    expect(readRefusal(429, headers({ "retry-after": "Wed, 09 Sep 2026 12:00:00 GMT" }), {}).retryAfter).toBeNull();
  });
});

describe("explain", () => {
  const budget = { status: 429, code: "budget_exhausted", message: "Project 'wrokin' has reached its budget.", retryAfter: 7200 };
  const wallet = { status: 429, code: "wallet_exhausted", message: "Tenant 'bb' has no credit left.", retryAfter: null };

  it("tells a budget refusal when it lifts", () => {
    const { message, credentials } = explain(budget);
    expect(message).toContain("Project 'wrokin' has reached its budget.");
    expect(message).toContain("2 hours");
    expect(credentials).toBe(false);
  });

  it("never tells a wallet refusal to wait", () => {
    const { message } = explain(wallet);
    expect(message).toContain("only a credit grant changes it");
    expect(message).not.toMatch(/try again|retry|resets/i);
  });

  it("gives the two exhausted refusals different sentences", () => {
    expect(explain(budget).message).not.toBe(explain(wallet).message);
  });

  it("offers the key command only where a key is the problem", () => {
    expect(explain({ status: 401, code: null, message: "Incorrect API key provided.", retryAfter: null }).credentials).toBe(true);
    expect(explain({ status: 429, code: "rate_limit_exceeded", message: "Too many requests.", retryAfter: 30 }).credentials).toBe(false);
    expect(explain(budget).credentials).toBe(false);
  });

  it("says a stale catalogue is a stale catalogue", () => {
    // The picker holds a list fetched at some earlier moment; a measurement
    // aged past 30 days between then and now. Refetching is the fix, and the
    // user has no way to guess that.
    const { message } = explain({
      status: 400,
      code: "measurement_stale",
      message: "Model 'mistral/mistral-small-latest' was last measured on 2026-07-01.",
      retryAfter: null,
    });
    expect(message).toContain("reopen the model picker");
  });

  it("keeps Cruise's own sentence when it has nothing to add", () => {
    const message = "Model 'x/y' is a lane, and lanes allocate chat models only.";
    expect(explain({ status: 400, code: "unsupported_capability", message, retryAfter: null }).message).toBe(message);
  });
});

describe("humanDelay", () => {
  it("rounds up, never down", () => {
    // A "retry in 0 minutes" that is really 40 seconds away sends the user
    // straight back into the same refusal.
    expect(humanDelay(1)).toBe("1 seconds");
    expect(humanDelay(0)).toBe("1 seconds");
    expect(humanDelay(90)).toBe("90 seconds");
    expect(humanDelay(91)).toBe("2 minutes");
    expect(humanDelay(3600)).toBe("60 minutes");
    expect(humanDelay(86_400)).toBe("24 hours");
  });
});
