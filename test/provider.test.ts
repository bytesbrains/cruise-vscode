/**
 * The provider, against the stub editor and a stubbed `fetch`.
 *
 * What is asserted is what leaves the extension — the request body — and what
 * comes back to the editor: parts reported, the error thrown and what it
 * carries. Review of #356 asked for every one of these.
 */

import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "../src/gateway.ts";
import { CruiseChatProvider } from "../src/provider.ts";
import { MemorySecrets, state } from "./vscode.stub.ts";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
beforeEach(() => state.reset());

function stub(response: Response): ReturnType<typeof vi.fn> {
  const fake = vi.fn(() => Promise.resolve(response));
  globalThis.fetch = fake as unknown as typeof fetch;
  return fake;
}

/** An SSE body from the frames given. */
function sse(...payloads: unknown[]): Response {
  const text = [...payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`), "data: [DONE]\n\n"].join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const catalogue = {
  object: "list",
  data: [
    {
      id: "bb/extraction",
      object: "model",
      owned_by: "cruise",
      "x-cruise": { modality: "chat", lane: true, streaming: true, tools: true, vision: false, max_context: 128_000, max_output: 8_192 },
    },
  ],
};

const model: vscode.LanguageModelChatInformation = {
  id: "bb/extraction",
  name: "bb/extraction",
  family: "cruise-lane",
  version: "2026-09-01",
  maxInputTokens: 128_000,
  maxOutputTokens: 8_192,
  capabilities: { toolCalling: true, imageInput: false },
};

function provider(secrets = new MemorySecrets()): { provider: CruiseChatProvider; secrets: MemorySecrets } {
  const log = vscode.window.createOutputChannel("test", { log: true });
  return { provider: new CruiseChatProvider(secrets, log), secrets };
}

const userTurn = (...content: vscode.LanguageModelChatRequestMessage["content"]): vscode.LanguageModelChatRequestMessage => ({
  role: vscode.LanguageModelChatMessageRole.User,
  name: undefined,
  content,
});

function responseOf(p: CruiseChatProvider, messages: vscode.LanguageModelChatRequestMessage[], options: Partial<vscode.ProvideLanguageModelChatResponseOptions> = {}) {
  const reported: vscode.LanguageModelResponsePart[] = [];
  const token = new vscode.CancellationTokenSource();
  const run = p.provideLanguageModelChatResponse(
    model,
    messages,
    { modelOptions: {}, ...options } as vscode.ProvideLanguageModelChatResponseOptions,
    { report: (part) => reported.push(part) },
    token.token,
  );
  return { run, reported, token };
}

describe("listing models", () => {
  it("returns nothing and asks nothing when there is no key and the editor is enumerating silently", async () => {
    const fake = stub(Response.json(catalogue));
    const { provider: p } = provider();
    expect(await p.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)).toEqual([]);
    expect(fake).not.toHaveBeenCalled();
  });

  it("prompts for a key when the user asked, and lists with it", async () => {
    stub(Response.json(catalogue));
    const { provider: p, secrets } = provider();
    state.inputBox = "cru_demo_abc";
    const listed = await p.provideLanguageModelChatInformation({ silent: false }, new vscode.CancellationTokenSource().token);
    expect(secrets.peek("cruise.apiKey")).toBe("cru_demo_abc");
    expect(listed).toMatchObject([{ id: "bb/extraction", family: "cruise-lane", capabilities: { toolCalling: true, imageInput: false } }]);
  });

  it("swallows a refusal into an empty list, and says so only when asked", async () => {
    stub(Response.json({ error: { code: null, message: "bad key" } }, { status: 401 }));
    const { provider: p, secrets } = provider();
    await secrets.store("cruise.apiKey", "cru_live_wrong");
    expect(await p.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)).toEqual([]);
    expect(state.shown).toEqual([]);
    expect(await p.provideLanguageModelChatInformation({ silent: false }, new vscode.CancellationTokenSource().token)).toEqual([]);
    // A rejected key the user asked about gets the diagnosis dialog, not a toast.
    expect(state.shown).toMatchObject([{ level: "error", modal: true, detail: expect.stringContaining("rejected the key itself") }]);
  });
});

describe("the request that leaves", () => {
  it("cannot have its model, stream or usage accounting rewritten by modelOptions", async () => {
    // Review of #356 claimed `stream_options` was overridable. It is set after
    // the spread, as `model` is, and this pins that.
    const fake = stub(sse());
    const { provider: p, secrets } = provider();
    await secrets.store("cruise.apiKey", "k");
    await responseOf(p, [userTurn(new vscode.LanguageModelTextPart("hi"))], {
      modelOptions: { model: "gpt-4o", stream: false, stream_options: { include_usage: false }, temperature: 0.2, max_tokens: 999_999 },
    }).run;
    const body = JSON.parse(String((fake.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "bb/extraction", stream: true, stream_options: { include_usage: true }, temperature: 0.2 });
    expect(body["max_tokens"]).toBe(8_192);
    expect(body["messages"]).toEqual([{ role: "user", content: "hi" }]);
  });

  it("bounds max_tokens by the setting, then by the model's ceiling", async () => {
    const fake = stub(sse());
    const { provider: p, secrets } = provider();
    await secrets.store("cruise.apiKey", "k");
    state.settings.set("cruise.maxOutputTokens", 2_000);
    await responseOf(p, [userTurn(new vscode.LanguageModelTextPart("hi"))]).run;
    expect(JSON.parse(String((fake.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({ max_tokens: 2_000 });
  });

  it("carries the editor's tools in the wire's shape, with the tool mode", async () => {
    const fake = stub(sse());
    const { provider: p, secrets } = provider();
    await secrets.store("cruise.apiKey", "k");
    await responseOf(p, [userTurn(new vscode.LanguageModelTextPart("hi"))], {
      tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
      toolMode: vscode.LanguageModelChatToolMode.Required,
    }).run;
    expect(JSON.parse(String((fake.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({
      tools: [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object" } } }],
      tool_choice: "required",
    });
  });
});

describe("the response that comes back", () => {
  it("reports text as it streams and a tool call once its arguments parse", async () => {
    stub(
      sse(
        { choices: [{ delta: { content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"p":1}' } }] } }] },
      ),
    );
    const { provider: p, secrets } = provider();
    await secrets.store("cruise.apiKey", "k");
    const { run, reported } = responseOf(p, [userTurn(new vscode.LanguageModelTextPart("hi"))]);
    await run;
    expect(reported).toEqual([
      new vscode.LanguageModelTextPart("Hel"),
      new vscode.LanguageModelTextPart("lo"),
      new vscode.LanguageModelToolCallPart("c1", "read", { p: 1 }),
    ]);
  });

  it("refuses with NoPermissions when no key is stored", async () => {
    const { provider: p } = provider();
    await expect(responseOf(p, [userTurn(new vscode.LanguageModelTextPart("hi"))]).run).rejects.toMatchObject({ code: "NoPermissions" });
  });

  it("maps a credentials refusal to NoPermissions and keeps the refusal as cause", async () => {
    stub(Response.json({ error: { code: null, message: "Invalid key." } }, { status: 401 }));
    const { provider: p, secrets } = provider();
    await secrets.store("cruise.apiKey", "k");
    const error: unknown = await responseOf(p, [userTurn(new vscode.LanguageModelTextPart("hi"))]).run.catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "NoPermissions", message: expect.stringContaining("Manage API key") });
    expect((error as Error).cause).toBeInstanceOf(GatewayError);
  });

  it("says in the chat panel when the key was sent to the wrong deployment (#16)", async () => {
    stub(Response.json({ error: { code: null, message: "Incorrect API key provided." } }, { status: 401 }));
    state.settings.set("cruise.endpoint", "https://cruise-demo.bytesbrains.net/v1");
    const { provider: p, secrets } = provider();
    await secrets.store("cruise.apiKey", "cru_live_abc");
    const error: unknown = await responseOf(p, [userTurn(new vscode.LanguageModelTextPart("hi"))]).run.catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "NoPermissions", message: expect.stringContaining("sent to the demo gateway") });
    expect((error as Error).message).toContain("Change endpoint");
    // A modal over the chat panel on every retry would be worse than the bug.
    expect(state.shown).toEqual([]);
  });

  it("diagnoses against the endpoint the request went to, not the one set since (review of #17)", async () => {
    let answer!: (response: Response) => void;
    globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))) as unknown as typeof fetch;
    state.settings.set("cruise.endpoint", "https://cruise-demo.bytesbrains.net/v1");
    const { provider: p, secrets } = provider();
    await secrets.store("cruise.apiKey", "cru_live_abc");
    const { run } = responseOf(p, [userTurn(new vscode.LanguageModelTextPart("hi"))]);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    // The user moves to production while the demo is still answering.
    state.settings.set("cruise.endpoint", undefined);
    answer(Response.json({ error: { code: null, message: "Incorrect API key provided." } }, { status: 401 }));
    const error: unknown = await run.catch((e: unknown) => e);
    expect((error as Error).message).toContain("sent to the demo gateway");
  });

  it("names the endpoint that could not be reached, not the one set since", async () => {
    let fail!: (error: Error) => void;
    globalThis.fetch = vi.fn(() => new Promise<Response>((_, reject) => (fail = reject))) as unknown as typeof fetch;
    state.settings.set("cruise.endpoint", "https://proxy.example.com/v1");
    const { provider: p, secrets } = provider();
    await secrets.store("cruise.apiKey", "cru_live_abc");
    const listing = p.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    state.settings.set("cruise.endpoint", undefined);
    fail(new TypeError("fetch failed"));
    await listing;
    expect(state.logged.at(-1)?.message).toContain("Could not reach Cruise at https://proxy.example.com/v1");
  });

  it("throws a spending refusal as a plain error whose cause still carries the code", async () => {
    // Budget and credit are different sentences; the code is what tells an
    // extension calling `sendRequest` which one it hit. Review of #356.
    stub(Response.json({ error: { code: "wallet_exhausted", message: "No credit left." } }, { status: 429 }));
    const { provider: p, secrets } = provider();
    await secrets.store("cruise.apiKey", "k");
    const error: unknown = await responseOf(p, [userTurn(new vscode.LanguageModelTextPart("hi"))]).run.catch((e: unknown) => e);
    expect(error).not.toHaveProperty("code");
    expect((error as Error).message).toContain("Waiting does not lift this one");
    expect((error as Error).cause).toMatchObject({ refusal: { code: "wallet_exhausted" } });
  });

  it("names a body that is not a stream rather than ending the turn with nothing", async () => {
    stub(Response.json({ id: "chatcmpl-1", choices: [{ message: { content: "hi" } }] }));
    const { provider: p, secrets } = provider();
    await secrets.store("cruise.apiKey", "k");
    await expect(responseOf(p, [userTurn(new vscode.LanguageModelTextPart("hi"))]).run).rejects.toThrow(/not a completion stream/);
  });

  it("returns quietly when the user pressed stop", async () => {
    const fake = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    globalThis.fetch = fake as unknown as typeof fetch;
    const { provider: p, secrets } = provider();
    await secrets.store("cruise.apiKey", "k");
    const { run, token } = responseOf(p, [userTurn(new vscode.LanguageModelTextPart("hi"))]);
    token.cancel();
    await expect(run).resolves.toBeUndefined();
  });
});

describe("counting tokens", () => {
  it("counts a message's parts, not zero", async () => {
    // Review of #356 found a message always counted as zero: the plain parts
    // were read through an `instanceof` check for the editor's classes.
    const { provider: p } = provider();
    const token = new vscode.CancellationTokenSource().token;
    const message = userTurn(
      new vscode.LanguageModelTextPart("a".repeat(350)),
      new vscode.LanguageModelDataPart(new Uint8Array(16), "image/png"),
    );
    expect(await p.provideTokenCount(model, "a".repeat(350), token)).toBe(100);
    expect(await p.provideTokenCount(model, message, token)).toBeGreaterThan(100);
  });
});
