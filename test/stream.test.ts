/**
 * The SSE reader.
 *
 * Everything here is a shape the wire actually produces, including the two
 * that only show up under load: a frame split across a chunk boundary, and a
 * multibyte character split down the middle of one.
 */

import { describe, expect, it } from "vitest";
import { readCompletionStream, SseDecoder, type StreamEvent } from "../src/stream.ts";

const encoder = new TextEncoder();

/** A stream that hands over exactly the chunks it was given. */
function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const delta = (content: string): string => frame({ choices: [{ index: 0, delta: { content } }] });

async function collect(chunks: (string | Uint8Array)[]): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of readCompletionStream(streamOf(chunks))) events.push(event);
  return events;
}

const textOf = (events: StreamEvent[]): string =>
  events.filter((event) => event.kind === "text").map((event) => event.text).join("");

describe("SseDecoder", () => {
  it("holds a frame that arrives in pieces", () => {
    const decoder = new SseDecoder();
    expect(decoder.push(encoder.encode('data: {"a"'))).toEqual([]);
    expect(decoder.push(encoder.encode(':1}\n\n'))).toEqual(['{"a":1}']);
  });

  it("keeps a multibyte character whole across a chunk boundary", () => {
    // The failure this prevents shows up as one mangled glyph per long
    // response — often enough to be reported, rarely enough not to be
    // reproduced. `€` is three bytes; the split is between the first and the
    // second.
    const bytes = encoder.encode("data: €\n\n");
    const decoder = new SseDecoder();
    expect(decoder.push(bytes.slice(0, 7))).toEqual([]);
    expect(decoder.push(bytes.slice(7))).toEqual(["€"]);
  });

  it("reads both line endings", () => {
    // A proxy in front of the gateway may normalise them, and the spec allows
    // either.
    expect(new SseDecoder().push(encoder.encode('data: 1\r\n\r\ndata: 2\r\n\r\n'))).toEqual(["1", "2"]);
  });

  it("ignores comments and other fields", () => {
    expect(new SseDecoder().push(encoder.encode(": keep-alive\nevent: ping\ndata: 1\n\n"))).toEqual(["1"]);
  });

  it("strips exactly one space after the colon", () => {
    // Trimming further would corrupt a payload that legitimately begins with
    // whitespace — which a content delta of "  indented" does.
    expect(new SseDecoder().push(encoder.encode("data:  two spaces\n\n"))).toEqual([" two spaces"]);
  });
});

describe("readCompletionStream", () => {
  it("yields text as it arrives", async () => {
    const events = await collect([delta("Hel"), delta("lo"), "data: [DONE]\n\n"]);
    expect(events).toEqual([
      { kind: "text", text: "Hel" },
      { kind: "text", text: "lo" },
    ]);
  });

  it("does not lose the last token when the stream ends without [DONE]", async () => {
    // A connection that drops after the final frame is still a complete
    // answer, and discarding the tail loses the end of a sentence.
    expect(textOf(await collect([delta("done")]))).toBe("done");
  });

  it("assembles a tool call from its fragments and emits it once", async () => {
    // The name arrives on the first fragment; the arguments a few characters
    // at a time. A partial JSON object is not something a caller can invoke,
    // so nothing is emitted until the stream is over.
    const events = await collect([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "" } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] }),
      "data: [DONE]\n\n",
    ]);
    expect(events).toEqual([{ kind: "tool-call", callId: "call_a", name: "read_file", input: { path: "a.ts" } }]);
  });

  it("keeps two parallel calls apart by index, not by id", async () => {
    // The id arrives on the first fragment and is absent from every one after
    // it, so it cannot address a call that is still being built.
    const events = await collect([
      frame({ choices: [{ delta: { tool_calls: [
        { index: 0, id: "call_a", function: { name: "one", arguments: "{}" } },
        { index: 1, id: "call_b", function: { name: "two", arguments: '{"x":' } },
      ] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "1}" } }] } }] }),
      "data: [DONE]\n\n",
    ]);
    expect(events).toEqual([
      { kind: "tool-call", callId: "call_a", name: "one", input: {} },
      { kind: "tool-call", callId: "call_b", name: "two", input: { x: 1 } },
    ]);
  });

  it("reads a no-argument call as an empty object", async () => {
    // `JSON.parse("")` throws, and a tool taking no arguments is the common
    // case rather than the edge.
    const events = await collect([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "now", arguments: "" } }] } }] }),
      "data: [DONE]\n\n",
    ]);
    expect(events).toEqual([{ kind: "tool-call", callId: "c", name: "now", input: {} }]);
  });

  it("drops a call whose arguments were truncated", async () => {
    // Invoking a tool with the wrong input is worse than not invoking it.
    const events = await collect([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "write", arguments: '{"path":' } }] } }] }),
    ]);
    expect(events).toEqual([]);
  });

  it("keeps the answer when one frame is not JSON", async () => {
    // The rest of the stream is still good, and the alternative is throwing
    // away an answer the user watched arrive.
    expect(textOf(await collect([delta("a"), "data: {not json\n\n", delta("b"), "data: [DONE]\n\n"]))).toBe("ab");
  });

  it("reports usage when the upstream sent it", async () => {
    const events = await collect([
      frame({ choices: [], usage: { prompt_tokens: 41, completion_tokens: 7 } }),
      "data: [DONE]\n\n",
    ]);
    expect(events).toEqual([{ kind: "usage", promptTokens: 41, completionTokens: 7 }]);
  });

  it("stops at [DONE] and ignores whatever follows it", async () => {
    expect(textOf(await collect([delta("a"), "data: [DONE]\n\n", delta("b")]))).toBe("a");
  });
});

describe("SSE framing the wire does not use today", () => {
  it("joins the data lines of one frame with a newline, as the grammar says", () => {
    // A JSON object pretty-printed across `data:` lines is one object. Read
    // line by line it is three fragments that each fail to parse, and the
    // whole frame is silently lost. Review of #356.
    const payloads = new SseDecoder().push(encoder.encode('data: {"a":\ndata:  1}\n\n'));
    expect(payloads).toEqual(['{"a":\n 1}']);
    expect(JSON.parse(payloads[0]!)).toEqual({ a: 1 });
  });

  it("still says nothing for a frame that is only comments", () => {
    expect(new SseDecoder().push(encoder.encode(": keep-alive\n\n"))).toEqual([]);
  });

  it("folds a fragment with no index into call 0 rather than dropping it", async () => {
    // Some compatible upstreams omit `index` when there is one call. Dropping
    // the fragment there would lose the only call the model made.
    const events = await collect([
      frame({ choices: [{ delta: { tool_calls: [{ id: "c", function: { name: "read", arguments: "" } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{"p":1}' } }] } }] }),
      "data: [DONE]\n\n",
    ]);
    expect(events).toEqual([{ kind: "tool-call", callId: "c", name: "read", input: { p: 1 } }]);
  });
});

describe("a body that is not a stream", () => {
  it("refuses a bare JSON completion rather than reading it as an empty answer", async () => {
    // Something in front of the gateway that ignored `stream: true`. Read as
    // SSE it has no frames, and the chat turn simply ends with nothing in it.
    const body = JSON.stringify({ id: "chatcmpl-1", choices: [{ message: { content: "hello" } }] });
    await expect(collect([body])).rejects.toMatchObject({
      name: "NotAStreamError",
      message: expect.stringContaining('"{"id":"chatcmpl-1"'),
    });
  });

  it("refuses a captive portal's HTML with the opening of it in the sentence", async () => {
    await expect(collect(["<html>\n  <body>Sign in to the network</body>\n</html>"])).rejects.toMatchObject({
      message: expect.stringContaining("<html> <body>Sign in"),
    });
  });

  it("does not refuse an empty body, or one that framed and then ended", async () => {
    expect(await collect([])).toEqual([]);
    expect(await collect(["\n\n"])).toEqual([]);
    expect(textOf(await collect([delta("a")]))).toBe("a");
  });
});
