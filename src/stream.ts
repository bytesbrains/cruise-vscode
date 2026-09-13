/**
 * The chat-completions SSE stream, read into the parts VS Code wants.
 *
 * Written rather than pulled from a library on purpose: the extension holds a
 * `cru_` key and sends traffic to one configured host, and every dependency
 * added here is another thing that could do neither. There are no runtime
 * dependencies in this extension at all, and this file is most of the reason
 * that is affordable.
 *
 * Two shapes leave here. Text arrives as it streams, because the editor
 * renders it as it arrives and that is the whole point of the provider being a
 * streaming contract. **Tool calls do not**: the wire sends a call in
 * fragments — the name in one frame, the arguments a few characters at a time
 * across many — and a partial JSON argument object is not something a caller
 * can invoke. So they accumulate by index and are emitted once, at the end,
 * when the arguments parse.
 */

/** What the reader emits, in the order it emits it. */
export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "tool-call"; callId: string; name: string; input: object }
  /**
   * `usage`, when the upstream reported it. Cruise settles the bill from its
   * own accounting rather than from this, so it is informational — but a
   * request that streams no usage at all is a model measured
   * `usage_reported: false`, and for a billed tenant that model is not
   * routable in the first place.
   */
  | { kind: "usage"; promptTokens: number; completionTokens: number };

/** A tool call under construction, keyed by the wire's `index`. */
interface PartialCall {
  id: string;
  name: string;
  args: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Split an SSE byte stream into `data:` payloads.
 *
 * Stateful because a frame is not guaranteed to arrive whole: a chunk boundary
 * can land anywhere, including inside a UTF-8 character, which is why the
 * decoder is created with `{ stream: true }` and kept across chunks. Getting
 * this wrong shows up as a mangled multibyte glyph roughly once per long
 * response, which is exactly often enough to be reported and not often enough
 * to be reproduced.
 */
export class SseDecoder {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";

  /** The complete `data:` payloads this chunk finished. */
  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain();
  }

  /** Whatever a final, unterminated frame left behind. */
  flush(): string[] {
    this.buffer += this.decoder.decode();
    // A stream that ends without a trailing blank line still has one frame in
    // it, and dropping it loses the last token of the response.
    const tail = this.buffer;
    this.buffer = "";
    return payloadsOf(tail);
  }

  private drain(): string[] {
    const payloads: string[] = [];
    // Frames are separated by a blank line. `\r\n\r\n` too, because a proxy
    // in front of the gateway may normalise line endings and the spec allows
    // both.
    let boundary = this.nextBoundary();
    while (boundary !== null) {
      const frame = this.buffer.slice(0, boundary.at);
      this.buffer = this.buffer.slice(boundary.at + boundary.length);
      payloads.push(...payloadsOf(frame));
      boundary = this.nextBoundary();
    }
    return payloads;
  }

  private nextBoundary(): { at: number; length: number } | null {
    const lf = this.buffer.indexOf("\n\n");
    const crlf = this.buffer.indexOf("\r\n\r\n");
    if (crlf !== -1 && (lf === -1 || crlf < lf)) return { at: crlf, length: 4 };
    if (lf !== -1) return { at: lf, length: 2 };
    return null;
  }
}

/**
 * The `data:` payload of one frame, comments and other fields dropped.
 *
 * **One frame is one payload**, however many `data:` lines it has: the SSE
 * grammar concatenates them with a newline between, and a JSON object an
 * upstream chose to pretty-print across lines is one object, not several
 * fragments that each fail to parse. Every chat-completions upstream sends
 * one line per frame today, so this is the spec rather than a shape seen on
 * the wire — but the parser that only handles the shape it has seen is the
 * one that drops a whole response the day a proxy reflows it. Review of
 * #356.
 *
 * Returned as a list so the decoder can say "nothing" for a frame that is
 * all comments — a `: keep-alive` — without an empty-string payload reaching
 * the JSON parser.
 */
function payloadsOf(frame: string): string[] {
  const lines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    // One optional space after the colon, per the SSE grammar. Trimming more
    // than that would corrupt a payload that legitimately starts with space.
    lines.push(line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5));
  }
  const payload = lines.join("\n");
  return payload.length > 0 ? [payload] : [];
}

/** A body that turned out not to be an SSE stream at all. */
export class NotAStreamError extends Error {
  constructor(sample: string) {
    // Enough of the body to recognise it — the opening of a JSON object or
    // an HTML tag says which kind of thing answered — and not so much that a
    // page of markup lands in the chat panel.
    const head = sample.replace(/\s+/g, " ").trim().slice(0, 120);
    super(`Cruise answered with something that is not a completion stream: "${head}${sample.length > 120 ? "…" : ""}"`);
    this.name = "NotAStreamError";
  }
}

/**
 * Read the whole stream, yielding events as they become renderable.
 *
 * The `[DONE]` sentinel ends the stream. A stream that ends without it — a
 * dropped connection mid-response — still flushes its accumulated tool calls,
 * because a call whose arguments completed before the socket died is a call
 * the caller can and should invoke.
 *
 * A body that carried **no `data:` frame at all** is refused rather than read
 * as an empty answer. A 200 whose body is a single JSON object — something in
 * front of the gateway that ignored `stream: true` — or a captive portal's
 * HTML has no frames in it, and reading it as SSE produces nothing: no text,
 * no error, a chat turn that simply ends. Throwing names what actually came
 * back. Detected from the body rather than from `content-type`, because the
 * Worker forwards the upstream's header as it came (`src/chat.ts`) and a
 * header gate would refuse a real stream over a cosmetic mislabel. Review of
 * #356.
 */
export async function* readCompletionStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const decoder = new SseDecoder();
  const calls = new Map<number, PartialCall>();
  const reader = body.getReader();
  let done = false;
  let framed = false;
  // Kept only until the first frame arrives, so the sample in the error is
  // the body's opening rather than its whole length. Its own decoder, kept
  // across chunks for the same reason `SseDecoder` keeps one.
  const sampler = new TextDecoder("utf-8");
  let sample = "";

  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!framed && sample.length < 512) sample += sampler.decode(next.value, { stream: true });
      for (const payload of decoder.push(next.value)) {
        framed = true;
        if (payload === "[DONE]") {
          done = true;
          break;
        }
        yield* consume(payload, calls);
      }
      if (done) break;
    }
    if (!done) {
      for (const payload of decoder.flush()) {
        framed = true;
        if (payload === "[DONE]") break;
        yield* consume(payload, calls);
      }
    }
    if (!framed && sample.trim().length > 0) throw new NotAStreamError(sample);
  } finally {
    // Cancelling releases the socket. Without it a request abandoned mid-answer
    // — which is what a user pressing stop in the chat panel does — leaves the
    // connection open until the gateway times it out, and the reservation it
    // is holding with it.
    await reader.cancel().catch(() => undefined);
  }

  yield* finished(calls);
}

/** One frame's worth of events. */
function* consume(payload: string, calls: Map<number, PartialCall>): Generator<StreamEvent> {
  let frame: unknown;
  try {
    frame = JSON.parse(payload);
  } catch {
    // A frame that is not JSON is not something to fail the whole response
    // over: the rest of the stream is still good, and the alternative is
    // throwing away an answer the user watched arrive.
    return;
  }
  if (!isRecord(frame)) return;

  const usage = frame["usage"];
  if (isRecord(usage)) {
    const prompt = usage["prompt_tokens"];
    const completion = usage["completion_tokens"];
    if (typeof prompt === "number" && typeof completion === "number") {
      yield { kind: "usage", promptTokens: prompt, completionTokens: completion };
    }
  }

  const choices = frame["choices"];
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = choice["delta"];
    if (!isRecord(delta)) continue;

    const content = delta["content"];
    if (typeof content === "string" && content.length > 0) {
      yield { kind: "text", text: content };
    }

    const toolCalls = delta["tool_calls"];
    if (Array.isArray(toolCalls)) accumulate(toolCalls, calls);
  }
}

/**
 * Fold a frame's tool-call fragments into the calls under construction.
 *
 * Keyed by `index` rather than by `id`: the id arrives on the first fragment
 * and is absent from every one after it, so `id` cannot address a call that is
 * still being built. Parallel calls are why this is a map and not one slot —
 * a model measured `parallel_tool_calls` sends two indices interleaved.
 */
function accumulate(fragments: unknown[], calls: Map<number, PartialCall>): void {
  for (const fragment of fragments) {
    if (!isRecord(fragment)) continue;
    const rawIndex = fragment["index"];
    // A fragment with no `index` is folded into call 0, not dropped. OpenAI's
    // wire always carries the index, but some compatible upstreams omit it
    // when there is only one call — and dropping the fragment there would
    // lose the only call the model made, which is worse than the failure the
    // default risks: an upstream that carries `index` on some fragments and
    // not others would merge a parallel call into the first, and that upstream
    // is broken on any client. Review of #356 asked for the drop; this is why
    // not.
    const index = typeof rawIndex === "number" ? rawIndex : 0;
    const call = calls.get(index) ?? { id: "", name: "", args: "" };

    if (typeof fragment["id"] === "string" && fragment["id"].length > 0) call.id = fragment["id"];
    const fn = fragment["function"];
    if (isRecord(fn)) {
      if (typeof fn["name"] === "string" && fn["name"].length > 0) call.name = fn["name"];
      if (typeof fn["arguments"] === "string") call.args += fn["arguments"];
    }
    calls.set(index, call);
  }
}

/**
 * The calls, once the stream is over.
 *
 * A call with no name never happened — the wire opened an index and the model
 * changed its mind, which the fold above cannot tell from a fragment still in
 * flight. Empty arguments become `{}`: a no-argument tool sends `""`, and
 * `JSON.parse("")` throws, so this is the common case rather than the edge.
 */
function* finished(calls: Map<number, PartialCall>): Generator<StreamEvent> {
  for (const [index, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
    if (call.name === "") continue;
    let input: object = {};
    if (call.args.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(call.args);
        if (isRecord(parsed)) input = parsed;
      } catch {
        // Truncated arguments. Emitting the call with an empty object would
        // have the caller invoke a tool with the wrong input, which is worse
        // than not invoking it, so the call is dropped.
        continue;
      }
    }
    // The wire's id, or one built from the index when the upstream sent none —
    // the editor matches a result back to a call by this string, so it has to
    // exist and has to be stable within the response.
    yield { kind: "tool-call", callId: call.id === "" ? `call_${index}` : call.id, name: call.name, input };
  }
}
