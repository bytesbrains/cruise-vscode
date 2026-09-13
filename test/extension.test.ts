/**
 * Activation and the management command, against the stub editor.
 *
 * What is asserted is what was registered and what the command does to the
 * keychain and the settings — the side effects review of #356 said nothing
 * verified.
 */

import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate, deactivate } from "../src/extension.ts";
import { MemorySecrets, state } from "./vscode.stub.ts";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
beforeEach(() => state.reset());

function context(): { subscriptions: { dispose(): void }[]; secrets: MemorySecrets } {
  return { subscriptions: [], secrets: new MemorySecrets() };
}

function stub(response: Response): void {
  globalThis.fetch = vi.fn(() => Promise.resolve(response)) as unknown as typeof fetch;
}

const emptyCatalogue = { object: "list", data: [] };

async function runManage(): Promise<void> {
  const handler = state.commands.get("cruise.manageKey");
  if (handler === undefined) throw new Error("command not registered");
  await handler();
}

describe("activate", () => {
  it("registers the vendor, the command, and puts every disposable on the context", () => {
    const ctx = context();
    activate(ctx as unknown as vscode.ExtensionContext);
    expect(state.providers.has("cruise")).toBe(true);
    expect(state.commands.has("cruise.manageKey")).toBe(true);
    // The log, the provider, the registration, the command, two listeners.
    expect(ctx.subscriptions).toHaveLength(6);
    deactivate();
    for (const disposable of ctx.subscriptions) disposable.dispose();
    expect(state.providers.has("cruise")).toBe(false);
  });

  it("tells the editor the list moved when the key or the endpoint changes", async () => {
    const ctx = context();
    activate(ctx as unknown as vscode.ExtensionContext);
    const provider = state.providers.get("cruise") as { onDidChangeLanguageModelChatInformation: (l: () => void) => void };
    let fired = 0;
    provider.onDidChangeLanguageModelChatInformation(() => fired++);
    await ctx.secrets.store("cruise.apiKey", "k");
    state.changeConfiguration("cruise.endpoint");
    state.changeConfiguration("editor.fontSize");
    expect(fired).toBe(2);
  });
});

describe("Cruise: Manage API key", () => {
  it("signs in: stores the key, then verifies it against the catalogue", async () => {
    stub(Response.json(emptyCatalogue));
    const ctx = context();
    activate(ctx as unknown as vscode.ExtensionContext);
    state.quickPick = "set";
    state.inputBox = "cru_live_abc";
    await runManage();
    expect(ctx.secrets.peek("cruise.apiKey")).toBe("cru_live_abc");
    expect(state.shown).toMatchObject([{ level: "info", message: expect.stringContaining("The key works") }]);
  });

  it("keeps a key the endpoint could not verify, and says why", async () => {
    // Throwing the key away over one failed read makes a flaky network look
    // like a bad credential.
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    const ctx = context();
    activate(ctx as unknown as vscode.ExtensionContext);
    state.quickPick = "set";
    state.inputBox = "cru_live_abc";
    await runManage();
    expect(ctx.secrets.peek("cruise.apiKey")).toBe("cru_live_abc");
    expect(state.shown).toMatchObject([{ level: "error", message: expect.stringContaining("Could not reach Cruise") }]);
  });

  it("points the demo at the user's settings, never the workspace's", async () => {
    stub(Response.json(emptyCatalogue));
    const ctx = context();
    activate(ctx as unknown as vscode.ExtensionContext);
    state.quickPick = "demo";
    state.inputBox = "cru_demo_abc";
    await runManage();
    expect(state.updates).toEqual([
      { key: "cruise.endpoint", value: "https://cruise-demo.bytesbrains.net/v1", target: vscode.ConfigurationTarget.Global },
    ]);
    expect(ctx.secrets.peek("cruise.apiKey")).toBe("cru_demo_abc");
  });

  it("signs out: the key is gone from this machine", async () => {
    const ctx = context();
    await ctx.secrets.store("cruise.apiKey", "cru_live_abc");
    activate(ctx as unknown as vscode.ExtensionContext);
    state.quickPick = "clear";
    await runManage();
    expect(ctx.secrets.peek("cruise.apiKey")).toBeUndefined();
    expect(state.shown).toMatchObject([{ level: "info", message: expect.stringContaining("removed") }]);
  });

  it("does nothing when the pick is dismissed", async () => {
    const ctx = context();
    activate(ctx as unknown as vscode.ExtensionContext);
    state.quickPick = undefined;
    await runManage();
    expect(ctx.secrets.peek("cruise.apiKey")).toBeUndefined();
    expect(state.shown).toEqual([]);
  });
});
