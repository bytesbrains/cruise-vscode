/**
 * The provider VS Code registers under the vendor `cruise`.
 *
 * This is the only file that touches `vscode` and the wire in the same breath,
 * and it is kept thin for that reason. Everything that has to be *right* — the
 * catalogue fold, the message translation, the SSE reader, the sentence a
 * refusal turns into — lives in a module with no `vscode` import and a test
 * beside it. What is left here is tested too, against `test/vscode.stub.ts`:
 * a stand-in for the editor's module that the `clients` Vitest project aliases
 * `vscode` to, carrying only the classes and calls this extension makes. The
 * stub's `instanceof` checks are real because the stub's classes are the ones
 * both sides construct. It is not the editor, and a test against it says
 * nothing about the picker; it says what this file sends and what it throws.
 */

import * as vscode from "vscode";
import { chatModels, type CruiseModel } from "./catalogue.ts";
import { endpoint, promptForKey, settled, storedKey } from "./credentials.ts";
import { showCredentialProblem } from "./dialog.ts";
import { fetchCatalogue, GatewayError, streamCompletion, type ChatRequest } from "./gateway.ts";
import { estimateTokens, estimateTurnTokens, toChatMessages, type Part, type Turn } from "./messages.ts";
import { diagnose } from "./pairing.ts";
import { explain } from "./refusal.ts";
import { NotAStreamError, readCompletionStream } from "./stream.ts";

const OUTPUT_SETTING = "cruise.maxOutputTokens";

/**
 * What a request is bounded at when the caller states nothing.
 *
 * **Not the model's ceiling**, and the reason is the reservation: Cruise holds
 * an upper bound over what the request could cost *before* it is sent, and the
 * bound is built from `max_tokens`. Reserving a million-token ceiling for a
 * two-sentence answer refuses a request the tenant could easily afford — the
 * failure #219 removed from the router, which a client can reintroduce from
 * the outside simply by asking for the maximum.
 *
 * A billed tenant that sends no `max_tokens` at all is refused
 * `request_unbounded`, so "send nothing" is not the alternative.
 */
const DEFAULT_MAX_OUTPUT = 16_384;

export class CruiseChatProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** The key or the endpoint moved, so the model list is no longer current. */
  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    // `silent` is the editor enumerating providers in the background. Prompting
    // there would put a modal in front of somebody who never asked for Cruise.
    // Read only once a key change has moved the endpoint with it (`settled`).
    await settled();
    let key = await storedKey(this.secrets);
    if (key === undefined) {
      if (options.silent) return [];
      key = await promptForKey(this.secrets);
      if (key === undefined) return [];
    }

    const base = endpoint();
    const abort = new AbortController();
    const cancel = token.onCancellationRequested(() => abort.abort());
    try {
      const models = chatModels(await fetchCatalogue(base, key, abort.signal));
      this.log.info(`${base} listed ${models.length} chat models for this key`);
      return models.map(informationOf);
    } catch (error) {
      if (abort.signal.aborted) return [];
      // A failure here is not thrown: the editor is building a picker, and one
      // provider that cannot answer must not take the list down with it. Said
      // out loud only when the user asked — a background enumeration that
      // fails is a log line, not a notification.
      if (!options.silent && error instanceof GatewayError && explain(error.refusal).credentials) {
        // Not awaited: the picker is waiting on this list, and it should not
        // sit open behind a modal. A switch moves the setting, and the
        // configuration listener refreshes the list from there.
        void showCredentialProblem(error.refusal, key, base, this.log);
        return [];
      }
      const sentence = sentenceOf(error, key, base);
      this.log.error(`${base} could not list models: ${sentence}`);
      if (!options.silent) vscode.window.showErrorMessage(sentence);
      return [];
    } finally {
      cancel.dispose();
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    await settled();
    const key = await storedKey(this.secrets);
    if (key === undefined) {
      throw vscode.LanguageModelError.NoPermissions(
        `No Cruise API key is stored. Run "Cruise: Manage API key".`,
      );
    }

    const request = requestFor(model, messages, options);
    // Captured, not re-read: a refusal is explained against the gateway that
    // gave it, and the setting may have moved while the request was out.
    const base = endpoint();
    const abort = new AbortController();
    const cancel = token.onCancellationRequested(() => abort.abort());

    try {
      const body = await streamCompletion(base, key, request, abort.signal);
      for await (const event of readCompletionStream(body)) {
        if (token.isCancellationRequested) break;
        if (event.kind === "text") {
          progress.report(new vscode.LanguageModelTextPart(event.text));
        } else if (event.kind === "tool-call") {
          progress.report(new vscode.LanguageModelToolCallPart(event.callId, event.name, event.input));
        } else {
          this.log.info(`${model.id}: ${event.promptTokens} prompt + ${event.completionTokens} completion tokens`);
        }
      }
    } catch (error) {
      // A user pressing stop is not a failure to report.
      if (abort.signal.aborted || token.isCancellationRequested) return;
      const sentence = sentenceOf(error, key, base);
      this.log.error(`${model.id}: ${sentence}`);
      // The sentence is for the person in the chat panel. The original is
      // kept as `cause` for the extension that called `sendRequest` and wants
      // the refusal's `code` — a `GatewayError` carries it, and replacing it
      // with a plain `Error` would have thrown that away. Review of #356.
      const thrown =
        error instanceof GatewayError && explain(error.refusal).credentials
          ? vscode.LanguageModelError.NoPermissions(sentence)
          : new Error(sentence);
      thrown.cause = error;
      throw thrown;
    } finally {
      cancel.dispose();
    }
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    // Estimated, not counted, and the estimate is deliberately high — see
    // `estimateTokens`. Cruise cannot do better: a lane allocates a member per
    // request, so which tokenizer applies is not known until after the
    // request has been made.
    return Promise.resolve(typeof text === "string" ? estimateTokens(text) : estimateTurnTokens(partsOf(text)));
  }
}

/** A catalogue row as the picker's information object. */
function informationOf(model: CruiseModel): vscode.LanguageModelChatInformation {
  return {
    id: model.id,
    name: model.name,
    family: model.family,
    version: model.version,
    detail: model.detail,
    tooltip: model.tooltip,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: { toolCalling: model.toolCalling, imageInput: model.imageInput },
  };
}

/** The body to send. */
function requestFor(
  model: vscode.LanguageModelChatInformation,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
): ChatRequest {
  const configured = vscode.workspace.getConfiguration().get<number>(OUTPUT_SETTING);
  const ceiling =
    typeof configured === "number" && configured > 0 ? configured : DEFAULT_MAX_OUTPUT;

  const turns: Turn[] = messages.map((message) => ({
    role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user",
    name: message.name,
    parts: partsOf(message),
  }));

  return {
    // The caller's own options first, so the four fields below cannot be
    // rewritten by one of them — the same ordering `errorResponse` uses in the
    // Worker, for the same reason: a mistake made impossible beats a rule
    // somebody has to know. A `temperature` or `top_p` passes straight
    // through; a `model` does not.
    ...options.modelOptions,
    model: model.id,
    messages: toChatMessages(turns),
    stream: true,
    stream_options: { include_usage: true },
    // Never above what the model was measured to produce: a request over the
    // published ceiling is refused `limit_exceeded` before it reaches an
    // upstream.
    max_tokens: Math.min(ceiling, model.maxOutputTokens),
    ...(options.tools === undefined || options.tools.length === 0
      ? {}
      : {
          tools: options.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              ...(tool.inputSchema === undefined ? {} : { parameters: tool.inputSchema }),
            },
          })),
          tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto",
        }),
  };
}

/** The editor's classes, resolved into the plain parts `messages.ts` folds. */
function partsOf(message: vscode.LanguageModelChatRequestMessage): Part[] {
  const parts: Part[] = [];
  for (const raw of message.content) {
    if (raw instanceof vscode.LanguageModelTextPart) {
      parts.push({ kind: "text", text: raw.value });
    } else if (raw instanceof vscode.LanguageModelToolCallPart) {
      parts.push({ kind: "tool-call", callId: raw.callId, name: raw.name, input: raw.input });
    } else if (raw instanceof vscode.LanguageModelToolResultPart) {
      parts.push({ kind: "tool-result", callId: raw.callId, text: raw.content.map(plainTextOf).join("") });
    } else if (raw instanceof vscode.LanguageModelDataPart) {
      const part = dataPartOf(raw);
      if (part !== null) parts.push(part);
    }
    // Anything else is a part type this extension has not been taught. Dropped
    // rather than stringified: sending the editor's internal shape to an
    // upstream as prose is how a model ends up answering about JSON.
  }
  return parts;
}

/** An image the wire can carry, or text, or nothing. */
function dataPartOf(part: vscode.LanguageModelDataPart): Part | null {
  if (part.mimeType.startsWith("image/")) {
    return { kind: "image", mimeType: part.mimeType, base64: Buffer.from(part.data).toString("base64") };
  }
  if (part.mimeType.startsWith("text/") || part.mimeType === "application/json") {
    return { kind: "text", text: new TextDecoder().decode(part.data) };
  }
  return null;
}

/** Whatever text a nested part carries, for counting and for tool results. */
function plainTextOf(part: unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) return part.value;
  if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("text/")) {
    return new TextDecoder().decode(part.data);
  }
  return "";
}

/** What to show a person, for anything thrown by a request sent to `base`. */
function sentenceOf(error: unknown, key: string, base: string): string {
  if (error instanceof GatewayError) {
    // A rejected key is explained against the endpoint it was sent to: a
    // correct key on the wrong deployment reads exactly like a bad one (#16).
    return explain(error.refusal).credentials
      ? diagnose(error.refusal, key, base).sentence
      : explain(error.refusal).message;
  }
  // The gateway was reached and answered; it is the answer that was wrong.
  if (error instanceof NotAStreamError) return error.message;
  if (error instanceof Error) {
    // A fetch that never reached the gateway: a wrong endpoint, an offline
    // machine, a proxy. Name the endpoint, because that setting is the thing
    // the user can actually change.
    return `Could not reach Cruise at ${base}: ${error.message}`;
  }
  return String(error);
}
