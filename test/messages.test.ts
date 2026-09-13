/**
 * The conversation, translated.
 *
 * The ordering assertion is the one that matters: VS Code carries a tool
 * result inside a User turn and the wire wants it as its own message before
 * any user text in that turn. Getting it wrong looks exactly like a model
 * ignoring a tool it just called.
 */

import { describe, expect, it } from "vitest";
import { estimateTokens, estimateTurnTokens, toChatMessages, type Turn } from "../src/messages.ts";

const user = (...parts: Turn["parts"]): Turn => ({ role: "user", parts });
const assistant = (...parts: Turn["parts"]): Turn => ({ role: "assistant", parts });
const text = (value: string): Turn["parts"][number] => ({ kind: "text", text: value });
// A call and its answer are sent only as a pair — the wire refuses either
// half alone — so the fixtures below carry both, with the half under test
// named in the assertion.
const called = (id: string, name = "read", input: object = {}): Turn => assistant({ kind: "tool-call", callId: id, name, input });

describe("toChatMessages", () => {
  it("sends plain text as a string, not a multipart array", () => {
    // The shape every upstream accepts. The array form is used only when
    // there is an image to carry.
    expect(toChatMessages([user(text("hello"))])).toEqual([{ role: "user", content: "hello" }]);
  });

  it("joins the parts of one turn into one message", () => {
    expect(toChatMessages([user(text("a"), text("b"))])).toEqual([{ role: "user", content: "ab" }]);
  });

  it("carries the speaker name when the editor gave one", () => {
    expect(toChatMessages([{ role: "user", name: "sandeep", parts: [text("hi")] }])).toEqual([
      { role: "user", name: "sandeep", content: "hi" },
    ]);
  });

  it("puts a tool result before the user text of the same turn", () => {
    expect(
      toChatMessages([called("call_a"), user({ kind: "tool-result", callId: "call_a", text: "42" }, text("and now?"))]).slice(1),
    ).toEqual([
      { role: "tool", tool_call_id: "call_a", content: "42" },
      { role: "user", content: "and now?" },
    ]);
  });

  it("emits a tool result with no user text as a tool message alone", () => {
    expect(toChatMessages([called("c"), user({ kind: "tool-result", callId: "c", text: "ok" })]).slice(1)).toEqual([
      { role: "tool", tool_call_id: "c", content: "ok" },
    ]);
  });

  it("serialises tool-call arguments as a JSON string, as the wire wants", () => {
    expect(
      toChatMessages([called("c", "read", { path: "a.ts" }), user({ kind: "tool-result", callId: "c", text: "" })]),
    ).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
      },
      { role: "tool", tool_call_id: "c", content: "" },
    ]);
  });

  it("gives an assistant turn of calls alone a null content, not an empty string", () => {
    // Some upstreams reject `""` outright, and it reads as the model having
    // said nothing out loud, which is a different claim.
    const [message] = toChatMessages([called("c", "n"), user({ kind: "tool-result", callId: "c", text: "ok" })]) as [
      { content: unknown },
    ];
    expect(message.content).toBeNull();
  });

  it("keeps text alongside the calls of the same assistant turn", () => {
    expect(
      toChatMessages([assistant(text("Reading it now."), { kind: "tool-call", callId: "c", name: "read", input: {} })]),
    ).toMatchObject([{ role: "assistant", content: "Reading it now." }]);
  });

  it("drops an assistant turn with nothing in it", () => {
    expect(toChatMessages([assistant()])).toEqual([]);
    expect(toChatMessages([user()])).toEqual([]);
  });

  it("carries an image as a data URL beside its text", () => {
    expect(toChatMessages([user(text("what is this?"), { kind: "image", mimeType: "image/png", base64: "AAA" })])).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ]);
  });

  it("synthesises no system message", () => {
    // A provider receives User and Assistant only; Copilot's instructions
    // arrive as the first user turn. Inventing a system message would change
    // what the model is told without anyone asking.
    const roles = (toChatMessages([user(text("a")), assistant(text("b"))]) as { role: string }[]).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
  });
});

describe("estimateTokens", () => {
  it("errs high, because the two errors are not symmetric", () => {
    // Over-estimating trims a prompt that would have fitted. Under-estimating
    // sends one the gateway refuses after the user has waited for it.
    expect(estimateTokens("a".repeat(4000))).toBeGreaterThan(1000);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
  });
});

describe("orphaned tool calls and results", () => {
  // The wire refuses a whole request over either half missing, with a
  // sentence naming a `tool_call_id`. Review of #356.
  const call = (id: string): Turn["parts"][number] => ({ kind: "tool-call", callId: id, name: "read", input: {} });
  const result = (id: string): Turn["parts"][number] => ({ kind: "tool-result", callId: id, text: "ok" });

  it("drops a call that never got its result", () => {
    // A tool cancelled before it produced one. The assistant text stays.
    expect(toChatMessages([assistant(text("Reading."), call("c1")), user(text("never mind"))])).toEqual([
      { role: "assistant", content: "Reading." },
      { role: "user", content: "never mind" },
    ]);
  });

  it("drops an assistant turn that was only an unanswered call", () => {
    expect(toChatMessages([assistant(call("c1")), user(text("hi"))])).toEqual([{ role: "user", content: "hi" }]);
  });

  it("drops a result whose call was trimmed out of the history", () => {
    expect(toChatMessages([user(result("gone"), text("and?"))])).toEqual([{ role: "user", content: "and?" }]);
  });

  it("keeps the pairs and drops only the orphan among them", () => {
    expect(toChatMessages([assistant(call("a"), call("b")), user(result("a"), text("go on"))])).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", content: "ok" },
      { role: "user", content: "go on" },
    ]);
  });

  it("does not pair a result that precedes its call", () => {
    expect(toChatMessages([user(result("x")), assistant(call("x"))])).toEqual([]);
  });
});

describe("estimateTurnTokens", () => {
  it("counts every kind of part, not only the text", () => {
    // Review of #356: the provider counted a message as zero because it read
    // plain parts through a check written for the editor's classes.
    const parts: Turn["parts"] = [
      text("hello"),
      { kind: "tool-call", callId: "c", name: "read_file", input: { path: "a".repeat(100) } },
      { kind: "tool-result", callId: "c", text: "b".repeat(100) },
      { kind: "image", mimeType: "image/png", base64: "AAA" },
    ];
    const total = estimateTurnTokens(parts);
    expect(total).toBeGreaterThan(estimateTokens("hello") + estimateTokens("a".repeat(100)) + estimateTokens("b".repeat(100)));
    expect(estimateTurnTokens([{ kind: "image", mimeType: "image/png", base64: "AAA" }])).toBeGreaterThanOrEqual(1000);
    expect(estimateTurnTokens([])).toBe(0);
  });
});
