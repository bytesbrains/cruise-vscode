/**
 * Which key belongs on which gateway, and the diagnosis a rejected one gets.
 *
 * #16 is the reason this file exists: a correct `cru_live_` key sent to the
 * demo gateway came back "Incorrect API key", and nothing said the endpoint
 * was the problem. Every key × endpoint pairing is pinned here.
 */

import { describe, expect, it } from "vitest";
import {
  DEMO_ENDPOINT,
  diagnose,
  endpointKind,
  endpointProblem,
  keyKind,
  keyLabel,
  PRODUCTION_ENDPOINT,
  realignment,
} from "../src/pairing.ts";
import type { Refusal } from "../src/refusal.ts";

// A placeholder, never a key-shaped value: a full-length or high-entropy one is
// exactly what the repository's gitleaks rules exist to stop, and the kind is
// read from the prefix anyway.
const SECRET = "abc";
const live = `cru_live_${SECRET}`;
const test_ = `cru_test_${SECRET}`;
const demo = `cru_demo_${SECRET}`;
const svc = `cru_svc_${SECRET}`;
const PROXY = "https://proxy.example.com/v1";

const rejected: Refusal = { status: 401, code: null, message: "Incorrect API key provided.", retryAfter: null };

describe("keyKind and keyLabel", () => {
  it("reads the kind from the prefix", () => {
    expect([live, test_, demo, svc, "sk-openai", ""].map(keyKind)).toEqual(["live", "test", "demo", "svc", "unknown", "unknown"]);
  });

  it("never shows more of the key than its prefix", () => {
    expect(keyLabel(live)).toBe("cru_live_… (live key)");
    expect(keyLabel("sk-openai-secret")).not.toContain("secret");
  });
});

describe("endpointKind", () => {
  it("knows the two deployments by host, however the URL was pasted", () => {
    expect(endpointKind(PRODUCTION_ENDPOINT)).toBe("production");
    expect(endpointKind("https://cruise.bytesbrains.net/")).toBe("production");
    expect(endpointKind("HTTPS://CRUISE-DEMO.BYTESBRAINS.NET")).toBe("demo");
  });

  it("calls everything else custom, including what does not parse", () => {
    expect(endpointKind(PROXY)).toBe("custom");
    expect(endpointKind("not a url")).toBe("custom");
  });
});

describe("realignment", () => {
  it("moves a production key off the demo, and a demo key off production", () => {
    expect(realignment(live, DEMO_ENDPOINT)).toBe("production");
    expect(realignment(test_, DEMO_ENDPOINT)).toBe("production");
    expect(realignment(demo, PRODUCTION_ENDPOINT)).toBe("demo");
  });

  it("leaves a matching pair, a key with no home, and a custom endpoint alone", () => {
    expect(realignment(live, PRODUCTION_ENDPOINT)).toBeNull();
    expect(realignment(demo, DEMO_ENDPOINT)).toBeNull();
    expect(realignment(svc, DEMO_ENDPOINT)).toBeNull();
    expect(realignment("sk-openai", DEMO_ENDPOINT)).toBeNull();
    // A proxy was set on purpose; this cannot see what it fronts.
    expect(realignment(demo, PROXY)).toBeNull();
  });
});

describe("endpointProblem", () => {
  it("accepts https anywhere and http only on this machine", () => {
    expect(endpointProblem(PROXY)).toBeUndefined();
    expect(endpointProblem("http://localhost:4000/v1")).toBeUndefined();
    expect(endpointProblem("http://127.0.0.1:4000")).toBeUndefined();
    expect(endpointProblem("http://proxy.example.com/v1")).toContain("https://");
  });

  it("refuses blanks, non-URLs, other schemes and credentials in the URL", () => {
    expect(endpointProblem("  ")).toContain("required");
    expect(endpointProblem("proxy.example.com")).toContain("Not a URL");
    expect(endpointProblem("ftp://proxy.example.com")).toContain("https://");
    expect(endpointProblem("https://user:pass@proxy.example.com/v1")).toContain("credentials");
  });
});

describe("diagnose", () => {
  it("names a live key on the demo gateway, and offers production", () => {
    const d = diagnose(rejected, live, DEMO_ENDPOINT);
    expect(d.switchTo).toBe("production");
    expect(d.sentence).toContain("demo gateway");
    expect(d.sentence).toContain("only accepts cru_demo_");
    expect(d.detail).toContain(`Endpoint: ${DEMO_ENDPOINT} (demo)`);
    expect(d.detail).toContain("Key: cru_live_… (live key)");
    expect(d.detail).toContain("HTTP 401 — Incorrect API key provided.");
  });

  it("names a demo key on production, and offers the demo", () => {
    const d = diagnose(rejected, demo, PRODUCTION_ENDPOINT);
    expect(d.switchTo).toBe("demo");
    expect(d.sentence).toContain("does not accept demo keys");
  });

  it("says a service key cannot call models anywhere", () => {
    const d = diagnose(rejected, svc, PRODUCTION_ENDPOINT);
    expect(d.switchTo).toBeNull();
    expect(d.sentence).toContain("cru_svc_");
    expect(d.sentence).toContain("/payments/*");
  });

  it("says a non-Cruise key is not a Cruise key", () => {
    expect(diagnose(rejected, "sk-openai", PRODUCTION_ENDPOINT).sentence).toContain("not a Cruise key");
    expect(diagnose(rejected, "sk-openai", PROXY).sentence).toContain("proxy");
  });

  it("puts a proxy in the picture, and names where the key belongs", () => {
    const d = diagnose(rejected, demo, PROXY);
    expect(d.switchTo).toBeNull();
    expect(d.detail).toContain("(custom URL)");
    expect(d.sentence).toContain("proxy.example.com");
    expect(d.sentence).toContain(DEMO_ENDPOINT);
  });

  it("blames the key itself only when the pairing is right", () => {
    expect(diagnose(rejected, live, PRODUCTION_ENDPOINT)).toMatchObject({
      switchTo: null,
      sentence: expect.stringContaining("rejected the key itself"),
    });
    expect(diagnose({ ...rejected, status: 403 }, live, PRODUCTION_ENDPOINT).sentence).toContain("scope");
  });

  it("keeps the wait on a lockout, and the code in the detail", () => {
    const d = diagnose({ status: 429, code: "too_many_auth_failures", message: "Too many failures.", retryAfter: 120 }, live, DEMO_ENDPOINT);
    expect(d.sentence).toContain("Try again in about 2 minutes.");
    expect(d.detail).toContain("HTTP 429 too_many_auth_failures");
  });
});

describe("the words a person reads", () => {
  it("carry no markdown — a modal, a notification and a chat error all show it as typed", () => {
    // The README's rejected-key still showed "**Cruise: Change endpoint**"
    // with the asterisks: `detail` is plain text, and so is a toast.
    const refusals: Refusal[] = [401, 403].map((status) => ({ status, code: null, message: "Incorrect API key provided.", retryAfter: null }));
    for (const refusal of refusals) {
      for (const key of [live, test_, demo, svc, "sk-other"]) {
        for (const endpoint of [PRODUCTION_ENDPOINT, DEMO_ENDPOINT, PROXY]) {
          const { sentence, detail } = diagnose(refusal, key, endpoint);
          expect(`${sentence}\n${detail}`).not.toMatch(/\*\*|__|`/);
        }
      }
    }
  });
});
