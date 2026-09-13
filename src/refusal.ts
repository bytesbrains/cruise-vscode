/**
 * Turning a Cruise refusal into a sentence the person in the chat panel can
 * act on.
 *
 * **Branch on `error.code`, never on the status.** Cruise answers both of its
 * exhausted refusals with `429 insufficient_quota`, deliberately: that is the
 * shape a stock OpenAI client already understands, so nothing has to be taught
 * about Cruise to fail correctly. The code is what tells them apart, and they
 * are not the same event —
 *
 * - `budget_exhausted` is a **period** cap. It carries a `retry-after` naming
 *   when the period rolls over, and waiting is the whole fix.
 * - `wallet_exhausted` is a **lifetime** cap. It carries no `retry-after`
 *   because there is no period that starts over; only a credit grant lifts it
 *   (#247).
 *
 * "You are out of budget until midnight" and "you are out of credit" are
 * different sentences to the person reading them, and a client that renders
 * one for both is telling half of its users to wait for something that will
 * never happen.
 *
 * Cruise's own `message` is already a sentence — it names the project, the
 * figures and, for a wallet, what a smaller request would do. So this file
 * never rewrites it. It appends what the *editor* knows and the gateway does
 * not: which button to press next.
 */

/** A refused response, reduced to what a sentence is built from. */
export interface Refusal {
  status: number;
  /** `error.code`. `null` is a refusal with no machine-readable reason. */
  code: string | null;
  /** `error.message`. Cruise's prose, kept verbatim. */
  message: string;
  /** `retry-after`, in seconds. Present on a 429 that waiting fixes. */
  retryAfter: number | null;
}

/**
 * Seconds as something a person reads at a glance.
 *
 * Rounded up, never down: a "retry in 0 minutes" that is really 40 seconds
 * away sends the user straight back into the same refusal.
 */
export function humanDelay(seconds: number): string {
  if (seconds <= 90) return `${Math.max(1, Math.ceil(seconds))} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  return `${Math.ceil(minutes / 60)} hours`;
}

/**
 * What to tell the user, and whether the editor should offer them the key
 * command.
 *
 * `credentials` is the flag the caller turns into `LanguageModelError`'s
 * NoPermissions rather than a generic failure — VS Code renders that one with
 * a sign-in affordance, and a wrong or revoked key is the only refusal here
 * where signing in again is the fix.
 */
export function explain(refusal: Refusal): { message: string; credentials: boolean } {
  const wait = refusal.retryAfter === null ? null : humanDelay(refusal.retryAfter);

  switch (refusal.code) {
    // A period cap. `retry-after` names the rollover; if it is somehow absent,
    // say the shape of the answer rather than invent a figure.
    case "budget_exhausted":
      return {
        message:
          wait === null
            ? `${refusal.message} The cap resets at the end of its period; until then, waiting or a larger budget on the project are the only two things that change it.`
            : `${refusal.message} It resets in about ${wait}. Until then, waiting or a larger budget on the project are the only two things that change it.`,
        credentials: false,
      };

    // A lifetime cap. Saying "try again later" here would be false.
    case "wallet_exhausted":
      return {
        message: `${refusal.message} Waiting does not lift this one — a lifetime cap has no period that starts over, and only a credit grant changes it.`,
        credentials: false,
      };

    // These do pass with time, and the header says when.
    case "rate_limit_exceeded":
    case "account_rate_limit_exceeded":
      return {
        message: `${refusal.message}${wait === null ? "" : ` Try again in about ${wait}.`}`,
        credentials: false,
      };

    // Repeated failed authentication, which is the gateway protecting itself
    // rather than a statement about this key. Still a credentials problem from
    // where the user sits — the key they have is not opening anything.
    case "too_many_auth_failures":
      return {
        message: `${refusal.message}${wait === null ? "" : ` Try again in about ${wait}.`} Check the key with **Cruise: Manage API key** before retrying.`,
        credentials: true,
      };

    // The catalogue moved under the picker: a measurement aged past 30 days, a
    // lane lost its last routable member, or the key's model scope changed.
    // Refetching the list is the fix and the user cannot guess that.
    case "measurement_stale":
    case "model_unmeasured":
    case "model_not_found":
      return {
        message: `${refusal.message} Cruise's catalogue has changed since this model was picked — reopen the model picker to refetch it.`,
        credentials: false,
      };

    // The reservation is built from `max_tokens`, so a billed tenant that
    // sends none is refused rather than have an unbounded request reserved
    // against its credit. This extension always sends one, so reaching here
    // means the setting was zeroed or a caller's `modelOptions` removed it.
    case "request_unbounded":
      return {
        message: `${refusal.message} This extension sends \`max_tokens\` on every request — check the \`cruise.maxOutputTokens\` setting.`,
        credentials: false,
      };

    // A billed tenant reaching a model that has no price in force, or one that
    // reports no usage. Refused rather than under-billed, which is the right
    // call and a baffling one without this sentence.
    case "model_unpriced":
    case "usage_unreported":
      return {
        message: `${refusal.message} Cruise refuses a request it cannot bill correctly rather than guess at the cost. Pick another model.`,
        credentials: false,
      };

    default:
      // No code, so fall back to the status — the one place this file is
      // allowed to. 401 and 403 are the credentials cases; everything else
      // gets Cruise's own sentence, which is usually better than ours.
      if (refusal.status === 401 || refusal.status === 403) {
        return {
          message: `${refusal.message} Run **Cruise: Manage API key** to store a working key.`,
          credentials: true,
        };
      }
      return { message: refusal.message, credentials: false };
  }
}

/**
 * Read a refused response into a `Refusal`.
 *
 * The body is parsed defensively rather than trusted. A refusal that comes
 * from something in front of Cruise — a proxy, a captive portal, a typo in the
 * endpoint setting — is not OpenAI-shaped at all, and the user needs to be
 * told the status rather than shown `undefined`.
 */
export function readRefusal(status: number, headers: Headers, body: unknown): Refusal {
  const header = headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);

  let code: string | null = null;
  let message = "";
  if (typeof body === "object" && body !== null && "error" in body) {
    const error: unknown = (body as { error: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const fields = error as { code?: unknown; message?: unknown };
      if (typeof fields.code === "string") code = fields.code;
      if (typeof fields.message === "string") message = fields.message;
    }
  }

  return {
    status,
    code,
    message: message === "" ? `Cruise refused the request with HTTP ${status}.` : message,
    retryAfter: Number.isFinite(seconds) && seconds >= 0 ? seconds : null,
  };
}
