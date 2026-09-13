/**
 * The two calls this extension makes, and nothing else.
 *
 * **No traffic goes anywhere but the configured base URL.** There is no
 * telemetry, no update check, no analytics host: an extension that holds an
 * API key and opens a second connection is an extension nobody can reason
 * about, and the argument for installing this one is that its blast radius is
 * a single revocable, budget-capped, rate-limited `cru_` key (`docs/keys.md`).
 *
 * `fetch` is the platform's — Node 22 in the extension host. Adding an HTTP
 * client would be the first runtime dependency here, and the reason not to is
 * the paragraph above.
 */

import { readRefusal, type Refusal } from "./refusal.ts";

/** A refusal, carried as a throw so a caller can `catch` one shape. */
export class GatewayError extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
    this.name = "GatewayError";
  }
}

/**
 * The base URL, made predictable.
 *
 * Trailing slashes are stripped, and `/v1` is appended when the setting does
 * not already carry it — someone pasting `https://cruise.bytesbrains.net` out
 * of a browser bar is the likeliest way this setting is filled in, and a 404
 * on `/models` is a worse answer than the one they meant.
 */
export function normaliseEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function headers(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
}

/** Read a refused response's body without letting a bad one mask the refusal. */
async function refuse(response: Response): Promise<never> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON. `readRefusal` builds a sentence from the status alone, which
    // is what a proxy or a captive portal in front of the gateway produces.
  }
  throw new GatewayError(readRefusal(response.status, response.headers, body));
}

/**
 * `GET /v1/models`, unparsed.
 *
 * Every entry it returns can be called — the list and the router agree by
 * construction (`src/index.ts`), which is what lets the picker offer a row
 * without checking anything else first.
 */
export async function fetchCatalogue(endpoint: string, key: string, signal: AbortSignal): Promise<unknown> {
  const base = normaliseEndpoint(endpoint);
  const response = await fetch(`${base}/models`, {
    method: "GET",
    headers: headers(key),
    signal,
  });
  if (!response.ok) await refuse(response);
  try {
    return await response.json();
  } catch {
    // A 200 that is not JSON is a captive portal, a proxy's landing page, or
    // an endpoint setting that names a website rather than a gateway. Left
    // alone, the `SyntaxError` reaches the user as "could not reach Cruise",
    // which is the one thing that did not happen. Review of #356.
    throw new GatewayError({
      status: response.status,
      code: null,
      message: `${base}/models answered ${response.status} with a body that is not JSON. Check that the endpoint setting names a Cruise data plane.`,
      retryAfter: null,
    });
  }
}

/** What the provider sends. OpenAI's chat-completions body, nothing added. */
export interface ChatRequest {
  model: string;
  messages: unknown[];
  stream: true;
  stream_options: { include_usage: true };
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: "auto" | "required";
  [option: string]: unknown;
}

/**
 * `POST /v1/chat/completions`, streaming.
 *
 * Returns the body rather than reading it: the caller renders parts as they
 * arrive, and buffering here would undo that.
 */
export async function streamCompletion(
  endpoint: string,
  key: string,
  request: ChatRequest,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(`${normaliseEndpoint(endpoint)}/chat/completions`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) await refuse(response);
  if (response.body === null) {
    throw new GatewayError({
      status: response.status,
      code: null,
      message: "Cruise returned an empty response body.",
      retryAfter: null,
    });
  }
  return response.body;
}
