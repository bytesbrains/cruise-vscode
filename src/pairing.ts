/**
 * Which key belongs on which gateway, and what to say when they do not match.
 *
 * Cruise runs two public deployments with **separate key tables**: production
 * accepts `cru_live_` and `cru_test_`, the demo accepts `cru_demo_`, and
 * neither has heard of the other's keys. `cru_svc_` authorises one route on
 * `/payments/*` and never `/v1/*`, on either (`docs/keys.md`). So a perfectly
 * good key sent to the wrong one is a plain `401 Incorrect API key` — the
 * gateway cannot know it was meant for its sibling — and the user reads it as
 * a bad key and pastes the same one again. #16: "Try the demo" left the
 * endpoint on the demo, and every live key after it was "incorrect".
 *
 * The key's prefix is the safe half (`docs/keys.md`), so everything here reads
 * only the prefix and nothing it produces carries more of the key than that.
 *
 * No `vscode` import: this is the part that has to be right, so it is the part
 * tested without a stub.
 */

import { normaliseEndpoint } from "./gateway.ts";
import { humanDelay, type Refusal } from "./refusal.ts";

export const PRODUCTION_ENDPOINT = "https://cruise.bytesbrains.net/v1";
export const DEMO_ENDPOINT = "https://cruise-demo.bytesbrains.net/v1";

const PRODUCTION_HOST = new URL(PRODUCTION_ENDPOINT).hostname;
const DEMO_HOST = new URL(DEMO_ENDPOINT).hostname;

export type KeyKind = "live" | "test" | "demo" | "svc" | "unknown";
export type EndpointKind = "production" | "demo" | "custom";

/** What the prefix says the key is. */
export function keyKind(key: string): KeyKind {
  const match = /^cru_(live|test|demo|svc)_/.exec(key.trim());
  return match === null ? "unknown" : (match[1] as KeyKind);
}

/** The key as it may be shown: its prefix and nothing after. */
export function keyLabel(key: string): string {
  const kind = keyKind(key);
  return kind === "unknown" ? "a key that does not start with cru_" : `cru_${kind}_… (${kind} key)`;
}

/**
 * Which deployment an endpoint names. By host, so `https://cruise.bytesbrains.net`
 * pasted without `/v1`, or with a trailing slash, is still production.
 */
export function endpointKind(endpoint: string): EndpointKind {
  let host: string;
  try {
    host = new URL(normaliseEndpoint(endpoint)).hostname.toLowerCase();
  } catch {
    return "custom";
  }
  if (host === PRODUCTION_HOST) return "production";
  if (host === DEMO_HOST) return "demo";
  return "custom";
}

/** The deployment a key kind belongs on, or `null` when no endpoint serves it. */
export function homeOf(kind: KeyKind): "production" | "demo" | null {
  if (kind === "live" || kind === "test") return "production";
  if (kind === "demo") return "demo";
  return null;
}

export function urlOf(kind: "production" | "demo"): string {
  return kind === "production" ? PRODUCTION_ENDPOINT : DEMO_ENDPOINT;
}

/**
 * Where the endpoint should move so the key is sent to its own deployment, or
 * `null` to leave it. A custom endpoint is never moved: a proxy or a
 * self-hosted gateway was set on purpose, and this cannot see what it fronts.
 */
export function realignment(key: string, endpoint: string): "production" | "demo" | null {
  const current = endpointKind(endpoint);
  if (current === "custom") return null;
  const home = homeOf(keyKind(key));
  return home === null || home === current ? null : home;
}

/**
 * Why a custom endpoint would be unsafe to send the key to, or `undefined`.
 *
 * The key goes out as a bearer token on every request, so plain `http:` is
 * refused except to this machine — a local proxy is the reason to allow it at
 * all. Credentials in the URL are refused because they would sit in
 * `settings.json`, which is synced, and the whole point of `SecretStorage` is
 * that nothing secret is.
 */
export function endpointProblem(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return "An endpoint URL is required.";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "Not a URL. Include the scheme, e.g. https://proxy.example.com/v1";
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    return "Use https:// — the API key is sent with every request. Plain http:// is allowed only for localhost.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "The endpoint must be an https:// URL.";
  if (url.username !== "" || url.password !== "") {
    return "Do not put credentials in the URL — settings are synced. The key is sent as a bearer token already.";
  }
  return undefined;
}

/** A credentials refusal, explained against the key and endpoint that produced it. */
export interface Diagnosis {
  /** What went wrong and what to do, in two sentences — for the chat panel. */
  sentence: string;
  /** The full picture, one fact per line — for a modal's detail. */
  detail: string;
  /** The deployment that would fix it, when the key's kind names one. */
  switchTo: "production" | "demo" | null;
}

export function diagnose(refusal: Refusal, key: string, endpoint: string): Diagnosis {
  const kind = keyKind(key);
  const where = endpointKind(endpoint);
  const switchTo = realignment(key, endpoint);
  const { cause, advice } = causeOf(refusal, kind, where, endpoint);
  const wait = refusal.retryAfter === null ? "" : ` Try again in about ${humanDelay(refusal.retryAfter)}.`;

  return {
    sentence: `${refusal.message} ${cause}${wait} ${advice}`,
    detail: [
      `Endpoint: ${endpoint} (${where === "custom" ? "custom URL" : where})`,
      `Key: ${keyLabel(key)}`,
      `Gateway answered: HTTP ${refusal.status}${refusal.code === null ? "" : ` ${refusal.code}`} — ${refusal.message}`,
      "",
      `Likely cause: ${cause}${wait}`,
      "",
      advice,
    ].join("\n"),
    switchTo,
  };
}

function causeOf(
  refusal: Refusal,
  kind: KeyKind,
  where: EndpointKind,
  endpoint: string,
): { cause: string; advice: string } {
  if (kind === "svc") {
    return {
      cause: "This is a cru_svc_ service key. Service keys authorise one /payments/* route and cannot list or call models on any gateway.",
      advice: "Replace it with a cru_live_ key (or a cru_demo_ key for the demo) via **Cruise: Manage API key**.",
    };
  }

  if (kind === "unknown") {
    return where === "custom"
      ? {
          cause: "The stored key does not start with cru_, so it is not a Cruise key. If your proxy issues its own keys, it rejected this one.",
          advice: "Check the key with whoever runs the proxy, or store a Cruise key via **Cruise: Manage API key**.",
        }
      : {
          cause: "The stored key does not start with cru_, so it is not a Cruise key — an OpenAI or other provider key will not work here.",
          advice: "Store a cru_live_ key (or cru_demo_ for the demo) via **Cruise: Manage API key**.",
        };
  }

  if (where === "demo" && (kind === "live" || kind === "test")) {
    return {
      cause: `A cru_${kind}_ key was sent to the demo gateway, which has its own key table and only accepts cru_demo_ keys.`,
      advice: "Switch the endpoint to production — **Cruise: Change endpoint** → Production.",
    };
  }

  if (where === "production" && kind === "demo") {
    return {
      cause: "A cru_demo_ key was sent to the production gateway, which does not accept demo keys.",
      advice: "Switch the endpoint to the demo — **Cruise: Change endpoint** → Demo — or store a cru_live_ key.",
    };
  }

  if (where === "custom") {
    const home = homeOf(kind) === "demo" ? DEMO_ENDPOINT : PRODUCTION_ENDPOINT;
    return {
      cause: `The endpoint is a custom URL (${hostOf(endpoint)}), so the key went through it rather than straight to Cruise. It may not forward the Authorization header, may expect its own credential, or may front a Cruise deployment this key does not belong to (a cru_${kind}_ key belongs on ${home}).`,
      advice: "Check the proxy, or point the endpoint straight at Cruise with **Cruise: Change endpoint**.",
    };
  }

  // The pairing is right, so it is the key itself.
  return refusal.status === 403
    ? {
        cause: `The ${where} gateway recognised the key and refused it this request — its scope or its project does not allow it.`,
        advice: "Check the key's scope and project in the Cruise dashboard.",
      }
    : {
        cause: `The key and the endpoint match (a ${kind} key on ${where}), so the gateway rejected the key itself: it may be revoked, expired, mistyped, or issued by a different account.`,
        advice: "Check the key in the Cruise dashboard and store it again with **Cruise: Manage API key**.",
      };
}

function hostOf(endpoint: string): string {
  try {
    return new URL(normaliseEndpoint(endpoint)).host;
  } catch {
    return endpoint;
  }
}
