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

async function run(command: string): Promise<void> {
  const handler = state.commands.get(command);
  if (handler === undefined) throw new Error(`${command} not registered`);
  await handler();
}

const runManage = () => run("cruise.manageKey");
const runChangeEndpoint = () => run("cruise.changeEndpoint");

const DEMO = "https://cruise-demo.bytesbrains.net/v1";
const PROXY = "https://proxy.example.com/v1";
const rejected = () => Response.json({ error: { code: null, message: "Incorrect API key provided." } }, { status: 401 });

/** Answer each fetch with the next response, in order. */
function sequence(...responses: Response[]): void {
  globalThis.fetch = vi.fn(() => Promise.resolve(responses.shift() ?? Response.json(emptyCatalogue))) as unknown as typeof fetch;
}

describe("activate", () => {
  it("registers the vendor, the command, and puts every disposable on the context", () => {
    const ctx = context();
    activate(ctx as unknown as vscode.ExtensionContext);
    expect(state.providers.has("cruise")).toBe(true);
    expect(state.commands.has("cruise.manageKey")).toBe(true);
    expect(state.commands.has("cruise.changeEndpoint")).toBe(true);
    // The log, the provider, the registration, two commands, two listeners.
    expect(ctx.subscriptions).toHaveLength(7);
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

describe("a key and an endpoint that do not belong together (#16)", () => {
  it("moves a live key off the demo when it is stored, and says so", async () => {
    // The bug: "Try the demo" wrote the demo endpoint, nothing wrote it back,
    // and every live key after it was "Incorrect API key".
    stub(Response.json(emptyCatalogue));
    const ctx = context();
    state.settings.set("cruise.endpoint", DEMO);
    activate(ctx as unknown as vscode.ExtensionContext);
    state.quickPick = "set";
    state.inputBox = "cru_live_abc";
    await runManage();
    expect(state.updates).toEqual([{ key: "cruise.endpoint", value: undefined, target: vscode.ConfigurationTarget.Global }]);
    expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]).toBe("https://cruise.bytesbrains.net/v1/models");
    expect(state.shown).toMatchObject([
      { level: "info", message: expect.stringContaining("Switched the endpoint to production") },
      { level: "info", message: expect.stringContaining("The key works") },
    ]);
  });

  it("never lets the model list see the new key on the old endpoint", async () => {
    // Review of #17: storing the key announces it, the listener refreshes, and
    // an enumeration that ran before the endpoint moved sent a live key to the
    // demo — a second rejection during the very transition #16 fixes.
    stub(Response.json(emptyCatalogue));
    const ctx = context();
    await ctx.secrets.store("cruise.apiKey", "cru_demo_abc");
    state.settings.set("cruise.endpoint", DEMO);
    activate(ctx as unknown as vscode.ExtensionContext);
    const provider = state.providers.get("cruise") as vscode.LanguageModelChatProvider;
    const listed: Promise<unknown>[] = [];
    provider.onDidChangeLanguageModelChatInformation?.(() => {
      listed.push(Promise.resolve(provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)));
    });
    state.quickPick = "set";
    state.inputBox = "cru_live_abc";
    await runManage();
    await Promise.all(listed);
    expect(listed.length).toBeGreaterThan(0);
    const sent = vi.mocked(globalThis.fetch).mock.calls.map(([url, init]) => [
      String(url),
      new Headers((init as RequestInit | undefined)?.headers).get("authorization"),
    ]);
    expect(sent.filter(([url, auth]) => (url ?? "").startsWith(DEMO) !== (auth ?? "").includes("cru_demo_"))).toEqual([]);
  });

  it("leaves the endpoint where it was when the demo's key prompt is cancelled", async () => {
    // Writing the demo endpoint before asking for its key left a live key
    // pointed at the demo on a cancel — #16 again, one Escape away.
    const ctx = context();
    await ctx.secrets.store("cruise.apiKey", "cru_live_abc");
    activate(ctx as unknown as vscode.ExtensionContext);
    state.quickPick = "demo";
    state.inputBox = undefined;
    await runManage();
    expect(state.updates).toEqual([]);
  });

  it("leaves a proxy alone whatever the key", async () => {
    stub(Response.json(emptyCatalogue));
    const ctx = context();
    state.settings.set("cruise.endpoint", PROXY);
    activate(ctx as unknown as vscode.ExtensionContext);
    state.quickPick = "set";
    state.inputBox = "cru_demo_abc";
    await runManage();
    expect(state.updates).toEqual([]);
  });

  it("explains a rejection in a modal, and a switch fixes and rechecks it", async () => {
    sequence(rejected(), Response.json(emptyCatalogue));
    const ctx = context();
    await ctx.secrets.store("cruise.apiKey", "cru_live_abc");
    activate(ctx as unknown as vscode.ExtensionContext);
    state.quickPick = "demo";
    state.dialogChoice = "Use production endpoint";
    await runChangeEndpoint();

    const [dialog, done] = state.shown;
    expect(dialog).toMatchObject({ level: "error", modal: true, message: "Cruise rejected the key (HTTP 401)" });
    expect(dialog?.detail).toContain(`Endpoint: ${DEMO} (demo)`);
    expect(dialog?.detail).toContain("Key: cru_live_… (live key)");
    expect(dialog?.detail).toContain("only accepts cru_demo_ keys");
    expect(dialog?.detail).not.toContain("abc");
    expect(dialog?.actions).toEqual(["Use production endpoint", "Change endpoint…", "Replace key…", "Show log"]);
    expect(state.settings.get("cruise.endpoint")).toBeUndefined();
    expect(done).toMatchObject({ level: "info", message: expect.stringContaining("The key works") });
  });

  it("offers no switch when the pairing is right, and blames the key", async () => {
    stub(rejected());
    const ctx = context();
    await ctx.secrets.store("cruise.apiKey", "cru_live_abc");
    activate(ctx as unknown as vscode.ExtensionContext);
    state.quickPick = "production";
    state.dialogChoice = "Replace key…";
    await runChangeEndpoint();
    expect(state.shown[0]?.actions).toEqual(["Change endpoint…", "Replace key…", "Show log"]);
    expect(state.shown[0]?.detail).toContain("rejected the key itself");
    expect(state.executed).toEqual(["cruise.manageKey"]);
  });

  it("routes the dialog's other buttons", async () => {
    stub(rejected());
    const ctx = context();
    await ctx.secrets.store("cruise.apiKey", "cru_demo_abc");
    activate(ctx as unknown as vscode.ExtensionContext);
    state.quickPick = "custom";
    state.inputBox = PROXY;
    state.dialogChoice = "Change endpoint…";
    await runChangeEndpoint();
    expect(state.executed).toEqual(["cruise.changeEndpoint"]);
    state.shown = [];
    stub(rejected());
    state.quickPick = "production";
    state.dialogChoice = "Show log";
    await runChangeEndpoint();
    expect(state.logShown).toBe(1);
  });
});

describe("Cruise: Change endpoint", () => {
  it("is reachable from the manage menu", async () => {
    const ctx = context();
    activate(ctx as unknown as vscode.ExtensionContext);
    state.quickPick = ["endpoint", "demo"];
    await runManage();
    expect(state.settings.get("cruise.endpoint")).toBe(DEMO);
  });

  it("sets a custom URL, trimmed, and asks for a key when none is stored", async () => {
    const ctx = context();
    activate(ctx as unknown as vscode.ExtensionContext);
    state.quickPick = "custom";
    state.inputBox = `  ${PROXY}  `;
    await runChangeEndpoint();
    expect(state.updates).toEqual([{ key: "cruise.endpoint", value: PROXY, target: vscode.ConfigurationTarget.Global }]);
    expect(state.shown).toMatchObject([{ level: "info", message: expect.stringContaining("Manage API key") }]);
  });

  it("refuses plain http to another machine — the key would travel in the clear", async () => {
    const ctx = context();
    activate(ctx as unknown as vscode.ExtensionContext);
    state.quickPick = "custom";
    state.inputBox = "http://proxy.example.com/v1";
    await runChangeEndpoint();
    expect(state.updates).toEqual([]);
    expect(state.shown).toMatchObject([{ level: "error", message: expect.stringContaining("https://") }]);
  });

  it("removes the setting for production rather than writing the default into it", async () => {
    const ctx = context();
    state.settings.set("cruise.endpoint", DEMO);
    activate(ctx as unknown as vscode.ExtensionContext);
    state.quickPick = "production";
    await runChangeEndpoint();
    expect(state.updates).toEqual([{ key: "cruise.endpoint", value: undefined, target: vscode.ConfigurationTarget.Global }]);
  });

  it("does nothing when dismissed", async () => {
    const ctx = context();
    activate(ctx as unknown as vscode.ExtensionContext);
    await runChangeEndpoint();
    state.quickPick = "custom";
    state.inputBox = undefined;
    await runChangeEndpoint();
    expect(state.updates).toEqual([]);
    expect(state.shown).toEqual([]);
  });
});
