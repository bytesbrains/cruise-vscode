/**
 * VS Code's conversation, in OpenAI's chat-completions shape.
 *
 * Deliberately free of `vscode`: the editor's parts are classes, recognised at
 * runtime with `instanceof`, and a module that does that cannot be run outside
 * an extension host. So `provider.ts` — which does have the editor — flattens
 * them into the plain shapes below, and everything that has to be *correct* is
 * here, where a test can reach it.
 *
 * There is no system role in what a provider receives. VS Code models a
 * conversation as User and Assistant only, and Copilot's own instructions
 * arrive as the first user turn. Nothing to translate, and nothing to invent:
 * a synthesised system message would change what the model is told without the
 * caller ever asking for it.
 */

/** One piece of a turn, with the editor's classes already resolved. */
export type Part =
  | { kind: "text"; text: string }
  | { kind: "tool-call"; callId: string; name: string; input: object }
  | { kind: "tool-result"; callId: string; text: string }
  | { kind: "image"; mimeType: string; base64: string };

/** One turn. `name` is the editor's optional speaker name. */
export interface Turn {
  role: "user" | "assistant";
  name?: string | undefined;
  parts: Part[];
}

const textOf = (parts: Part[]): string =>
  parts
    .filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("");

/**
 * The wire's messages, in order.
 *
 * The one non-obvious move is tool results. VS Code carries a result as a part
 * of a **User** turn; the wire wants it as its own `role: "tool"` message,
 * before any user text in the same turn and matched to the call by `callId`.
 * Emitting them in the wrong order is the failure that looks like a model
 * ignoring a tool it just called.
 */
export function toChatMessages(turns: Turn[]): unknown[] {
  const messages: unknown[] = [];
  const paired = pairedCallIds(turns);

  for (const turn of turns) {
    const results = turn.parts.filter(
      (part): part is Extract<Part, { kind: "tool-result" }> => part.kind === "tool-result" && paired.has(part.callId),
    );
    for (const result of results) {
      messages.push({ role: "tool", tool_call_id: result.callId, content: result.text });
    }

    if (turn.role === "assistant") {
      const calls = turn.parts.filter(
        (part): part is Extract<Part, { kind: "tool-call" }> => part.kind === "tool-call" && paired.has(part.callId),
      );
      const text = textOf(turn.parts);
      // An assistant turn that is only tool calls carries `content: null`,
      // which is what the wire expects — an empty string reads as the model
      // having said nothing out loud, and some upstreams reject it outright.
      if (calls.length === 0 && text === "") continue;
      messages.push({
        role: "assistant",
        content: text === "" ? null : text,
        ...(calls.length === 0
          ? {}
          : {
              tool_calls: calls.map((call) => ({
                id: call.callId,
                type: "function",
                // Arguments are a JSON **string** on the wire, not an object.
                // The asymmetry with the response — where they also arrive as
                // a string — is the wire's, not ours.
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }),
      });
      continue;
    }

    const user = turn.parts.filter((part) => part.kind === "text" || part.kind === "image");
    if (user.length === 0) continue;
    const images = user.filter((part): part is Extract<Part, { kind: "image" }> => part.kind === "image");
    const text = textOf(user);

    messages.push({
      role: "user",
      ...(turn.name === undefined ? {} : { name: turn.name }),
      // A string when there is nothing but text, because that is the shape
      // every upstream accepts. The multipart array is used only when there is
      // an image to carry, and a model without measured `vision` never gets
      // one — `catalogue.ts` reads that flag closed, so the picker does not
      // offer an image-capable session over a model that has not been seen to
      // do it.
      content:
        images.length === 0
          ? text
          : [
              ...(text === "" ? [] : [{ type: "text", text }]),
              ...images.map((image) => ({
                type: "image_url",
                image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
              })),
            ],
    });
  }

  return messages;
}

/**
 * The call ids that have both halves: a call in an assistant turn and a
 * result in a later turn.
 *
 * **An orphan of either kind is dropped, not sent.** The wire requires that an
 * assistant message carrying `tool_calls` be followed by a `tool` message per
 * call, and that every `tool` message answer a call — an upstream refuses the
 * whole request with a 400 otherwise, and the sentence it refuses with names a
 * `tool_call_id`, which is not something the person in the chat panel can act
 * on. A history can hold an orphan when a tool was cancelled before it
 * produced a result, or when the editor trimmed the conversation to fit the
 * context window and the cut landed between a call and its answer. Dropping
 * the half that is left tells the model slightly less than happened; sending
 * it tells the model nothing at all. Review of #356.
 */
function pairedCallIds(turns: Turn[]): Set<string> {
  const called = new Set<string>();
  const paired = new Set<string>();
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (turn.role === "assistant" && part.kind === "tool-call") called.add(part.callId);
      // Only a result that follows its call pairs: a result the editor placed
      // before the call it answers is not a shape the wire accepts either.
      if (turn.role === "user" && part.kind === "tool-result" && called.has(part.callId)) paired.add(part.callId);
    }
  }
  return paired;
}

/** What one image is counted as. A ceiling, in keeping with `estimateTokens`. */
const TOKENS_PER_IMAGE = 1_600;

/**
 * A token estimate for a whole turn, every part counted.
 *
 * The parts are counted as the wire will carry them — a tool call as its name
 * and its arguments serialised, a result as its text — rather than as the
 * text a person would see, because the wire is what the context window is
 * measured against. An image is a fixed figure at the top of the range
 * upstreams charge for one: the editor uses this count to decide whether a
 * prompt fits, and the error that matters is the one that sends a prompt the
 * gateway refuses `limit_exceeded` after the user has waited for it.
 *
 * Review of #356 found `provideTokenCount` counting a message as zero — it
 * flattened the editor's parts and then asked an `instanceof` check written
 * for the editor's classes to read them. This is the replacement.
 */
export function estimateTurnTokens(parts: Part[]): number {
  let total = 0;
  for (const part of parts) {
    switch (part.kind) {
      case "text":
      case "tool-result":
        total += estimateTokens(part.text);
        break;
      case "tool-call":
        total += estimateTokens(part.name) + estimateTokens(JSON.stringify(part.input));
        break;
      case "image":
        total += TOKENS_PER_IMAGE;
        break;
    }
  }
  return total;
}

/**
 * A token count, when nobody has a tokenizer.
 *
 * VS Code asks a provider to count tokens so it can budget a prompt against
 * `maxInputTokens`. Cruise cannot answer it: a lane allocates a member per
 * request, so the tokenizer is not known until after the request is made, and
 * shipping one per upstream would be a table that goes stale the way a frozen
 * model list does.
 *
 * So this estimates, and estimates **high**. Four characters per token is the
 * usual rule of thumb for English; code and non-Latin scripts run denser than
 * that, and the direction of the error matters more than its size — an
 * over-estimate makes the editor trim a prompt that would have fitted, and an
 * under-estimate makes it send one the gateway refuses `limit_exceeded` after
 * the user has waited for it.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 3.5));
}
