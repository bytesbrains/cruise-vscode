/**
 * Where the key lives, against the in-memory keychain of `vscode.stub.ts`.
 *
 * What is asserted is the side effect on the keychain and what the user was
 * told — the two things a person cannot see by reading the code, and the two
 * review of #356 said were unverified.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { endpoint, forgetKey, promptForKey, storedKey, storeKey } from "../src/credentials.ts";
import { MemorySecrets, state } from "./vscode.stub.ts";

const ENTRY = "cruise.apiKey";

beforeEach(() => state.reset());

describe("endpoint", () => {
  it("is production when nothing is set, or when the setting is blank", () => {
    expect(endpoint()).toBe("https://cruise.bytesbrains.net/v1");
    state.settings.set("cruise.endpoint", "   ");
    expect(endpoint()).toBe("https://cruise.bytesbrains.net/v1");
  });

  it("is the configured value, trimmed", () => {
    state.settings.set("cruise.endpoint", " https://cruise-demo.bytesbrains.net/v1 ");
    expect(endpoint()).toBe("https://cruise-demo.bytesbrains.net/v1");
  });
});

describe("the stored key", () => {
  it("is undefined when absent or empty, and the value otherwise", async () => {
    const secrets = new MemorySecrets();
    expect(await storedKey(secrets)).toBeUndefined();
    await storeKey(secrets, "");
    expect(await storedKey(secrets)).toBeUndefined();
    await storeKey(secrets, "cru_live_abc");
    expect(await storedKey(secrets)).toBe("cru_live_abc");
    expect(secrets.peek(ENTRY)).toBe("cru_live_abc");
  });

  it("is gone after forgetKey", async () => {
    const secrets = new MemorySecrets();
    await storeKey(secrets, "cru_live_abc");
    await forgetKey(secrets);
    expect(await storedKey(secrets)).toBeUndefined();
    expect(secrets.peek(ENTRY)).toBeUndefined();
  });
});

describe("promptForKey", () => {
  it("stores nothing when the user cancels", async () => {
    const secrets = new MemorySecrets();
    state.inputBox = undefined;
    expect(await promptForKey(secrets)).toBeUndefined();
    expect(secrets.peek(ENTRY)).toBeUndefined();
    expect(state.shown).toEqual([]);
  });

  it("trims what was pasted, because a terminal brings a newline with it", async () => {
    const secrets = new MemorySecrets();
    state.inputBox = "  cru_live_abc\n";
    expect(await promptForKey(secrets)).toBe("cru_live_abc");
    expect(secrets.peek(ENTRY)).toBe("cru_live_abc");
    expect(state.shown).toEqual([]);
  });

  it("warns about a key without the prefix and stores it anyway", async () => {
    // The gateway is the authority on whether a key works; the prefix check
    // is a typo catcher, not a gate.
    const secrets = new MemorySecrets();
    state.inputBox = "sk-not-a-cruise-key";
    expect(await promptForKey(secrets)).toBe("sk-not-a-cruise-key");
    expect(secrets.peek(ENTRY)).toBe("sk-not-a-cruise-key");
    expect(state.shown).toMatchObject([{ level: "warning", message: expect.stringContaining("cru_") }]);
  });
});
