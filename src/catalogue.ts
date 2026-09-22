/**
 * `GET /v1/models`, folded into what VS Code's model picker needs.
 *
 * **The list is fetched, never shipped.** A copy of the catalogue frozen into
 * an extension goes wrong the first time a lane changes members or a
 * measurement ages out — `MEASUREMENT_MAX_AGE_DAYS = 30`, and an aged
 * measurement is treated as unverified rather than as last known good, so the
 * router refuses the model with `measurement_stale`. A user staring at that
 * refusal for a model our own extension offered them will blame the gateway,
 * correctly. Everything `/v1/models` returns can be called; that is the
 * contract this file leans on entirely (`src/index.ts`).
 *
 * The catalogue is per key, not per platform: it is filtered to what the
 * presented key may call, and for a billed tenant that is narrower again. So
 * this runs on every `provideLanguageModelChatInformation`, and the key it
 * runs with decides the answer.
 */

/** A row of `/v1/models`, as much of it as the picker reads. */
interface CatalogueRow {
  id?: unknown;
  object?: unknown;
  owned_by?: unknown;
  "x-cruise"?: {
    modality?: unknown;
    lane?: unknown;
    job?: unknown;
    description?: unknown;
    members?: unknown;
    tools?: unknown;
    vision?: unknown;
    streaming?: unknown;
    max_context?: unknown;
    max_output?: unknown;
    data_retention?: unknown;
    measured_at?: unknown;
    pricing?: unknown;
  };
}

/** One model the picker can offer, with the strings it renders. */
export interface CruiseModel {
  /** The id a request puts in `model`. Cruise's, never the provider's. */
  id: string;
  name: string;
  family: string;
  version: string;
  detail: string;
  tooltip: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  toolCalling: boolean;
  imageInput: boolean;
}

/** 1 USD = 1,000,000 micros. Money is integer micros everywhere but here. */
const MICROS_PER_USD = 1_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A tri-state flag, read closed: only `true` is a capability. */
const flag = (value: unknown): boolean => value === true;

const positiveInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;

/**
 * The dearest token rate this row can charge, in micros per million.
 *
 * **The maximum, never the headline and never an average**, across the
 * conditional variants too — the same rule `src/lanes.ts` folds a lane's price
 * by, for the same reason: a figure shown beside a model is what somebody
 * budgets on, and a peak-hour or large-prompt variant that costs three times
 * the headline makes an average a number that is true of no request.
 *
 * `null` when nothing is in force, which is **not** the same as free: an
 * unpriced model is charged its full reservation. The picker says "unpriced"
 * rather than "$0.00" for exactly that reason.
 */
function dearestRates(pricing: unknown): { input: number; output: number } | null {
  if (!isRecord(pricing)) return null;
  const rate = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  let input = rate(pricing["input_micros_per_mtok"]);
  let output = rate(pricing["output_micros_per_mtok"]);
  const variants = pricing["variants"];
  if (Array.isArray(variants)) {
    for (const variant of variants) {
      if (!isRecord(variant)) continue;
      input = Math.max(input, rate(variant["input_micros_per_mtok"]));
      output = Math.max(output, rate(variant["output_micros_per_mtok"]));
    }
  }
  return { input, output };
}

/** Micros per million tokens as dollars per million tokens, for display only. */
const perMtok = (micros: number): string => `$${(micros / MICROS_PER_USD).toFixed(2)}`;

/**
 * What a component line adds. Not rendered as a figure — a per-request or
 * per-search fee is a different unit from a token rate and printing them in
 * one string invites adding them — but its presence is worth saying, because a
 * caller budgeting on token rates alone under-counts a search model by the
 * larger half of a short query.
 */
const hasComponents = (pricing: unknown): boolean =>
  isRecord(pricing) && Array.isArray(pricing["components"]) && pricing["components"].length > 0;

/**
 * Every chat row the key may call, in the order the gateway listed them.
 *
 * Four things are dropped, each for a reason the picker cannot recover from:
 *
 * - **Anything that is not `chat`.** An image, speech or embedding row is
 *   catalogued and served, at a route this provider does not speak. Offering
 *   one in a chat picker produces `unsupported_capability` on first use.
 * - **A row with no measured context or output limit.** VS Code wants two
 *   numbers and will size a request against them; inventing them makes the
 *   editor send a request the gateway refuses `limit_exceeded`. Unknown fails
 *   closed here as it does in the router.
 * - **A row that cannot stream.** `provideLanguageModelChatResponse` is a
 *   streaming contract, and a model measured `streaming: false` — or never
 *   measured, which reads the same way — cannot honour it.
 * - **A malformed row.** Parsed defensively rather than trusted: this is the
 *   one place a gateway response reaches the editor's model list.
 *
 * **A lane is judged by its members, not by its summary.** The gateway's lane
 * row reports each capability as the *intersection* of its members' — true
 * only when every member has it, null when any is unmeasured (`src/lanes.ts`
 * in the gateway). That is the right promise for "every request fits every
 * member", and the wrong test for "can this lane serve a streamed request
 * with tools": allocation gates each member per request (`lanes-allocate.ts`)
 * and serves it from one that can. So a lane streams, calls tools or reads
 * images when any member listed in the same response does. Read from the
 * summary alone, one unmeasured member drops a lane out of the picker the
 * gateway would have served — and agent mode lists only models with tools.
 *
 * `skipped`, when given, collects every dropped row with its reason, so the
 * output channel can say why something is not in the picker.
 */
export function chatModels(body: unknown, skipped?: { id: string; reason: string }[]): CruiseModel[] {
  if (!isRecord(body) || !Array.isArray(body["data"])) return [];
  const models: CruiseModel[] = [];
  const rows = (body["data"] as CatalogueRow[]).filter(
    (entry): entry is CatalogueRow & { id: string } => isRecord(entry) && typeof entry.id === "string",
  );
  const byId = new Map(rows.map((entry) => [entry.id, entry]));
  const skip = (id: string, reason: string) => skipped?.push({ id, reason });

  for (const entry of rows) {
    const x = entry["x-cruise"];
    if (!isRecord(x)) {
      skip(entry.id, "no x-cruise block");
      continue;
    }
    if (x["modality"] !== "chat") {
      skip(entry.id, `modality ${String(x["modality"])}, not chat`);
      continue;
    }
    const lane = flag(x["lane"]);
    const capable = (capability: "streaming" | "tools" | "vision") => (lane ? laneCan(x, byId, capability) : flag(x[capability]));

    if (!capable("streaming")) {
      skip(entry.id, lane ? "no listed member measured to stream" : `streaming is ${String(x["streaming"])}`);
      continue;
    }

    const maxInputTokens = positiveInt(x["max_context"]);
    const maxOutputTokens = positiveInt(x["max_output"]);
    if (maxInputTokens === null || maxOutputTokens === null) {
      skip(entry.id, `no measured limits (max_context ${String(x["max_context"])}, max_output ${String(x["max_output"])})`);
      continue;
    }

    const owner = typeof entry.owned_by === "string" ? entry.owned_by : "cruise";
    const rates = dearestRates(x["pricing"]);

    models.push({
      id: entry.id,
      // The last segment for a model — `workers-ai/@cf/meta/llama-3.1-8b`
      // reads as a path and the picker has little room — and the whole id for
      // a lane, where the `bb/` prefix is the point.
      name: lane ? entry.id : (entry.id.split("/").pop() ?? entry.id),
      // The picker groups by family. A lane is its own family: allocation
      // picks a member per request, so a lane is not "one of" its upstream.
      family: lane ? "cruise-lane" : owner,
      // A lookup value, not a display string. The measurement date is the
      // honest one: it is what changes when the model behind a fixed id does.
      version: typeof x["measured_at"] === "string" ? x["measured_at"] : "unmeasured",
      detail: detailOf({ lane, owner, rates, components: hasComponents(x["pricing"]) }),
      tooltip: tooltipOf({ entry, x, lane, owner, rates, maxInputTokens, maxOutputTokens }),
      maxInputTokens,
      maxOutputTokens,
      // Read closed: `null` is never measured, and the gate refuses a request
      // needing an unmeasured capability rather than attempting it. For a
      // lane, any member that has it — see above.
      toolCalling: capable("tools"),
      imageInput: capable("vision"),
    });
  }

  return models;
}

/**
 * Whether some member of a lane, as listed in the same response, has
 * `capability` measured true — the lane's own summary first, since true there
 * means every member. A member the key cannot see is not listed, and cannot be
 * the one a request is allocated to either.
 */
function laneCan(x: Record<string, unknown>, byId: Map<string, CatalogueRow>, capability: "streaming" | "tools" | "vision"): boolean {
  if (flag(x[capability])) return true;
  const members = Array.isArray(x["members"]) ? x["members"].filter((m): m is string => typeof m === "string") : [];
  return members.some((id) => {
    const member = byId.get(id)?.["x-cruise"];
    return isRecord(member) && member["modality"] === "chat" && flag(member[capability]);
  });
}

/** The line beside the name in the picker. Short: it competes for width. */
function detailOf(o: {
  lane: boolean;
  owner: string;
  rates: { input: number; output: number } | null;
  components: boolean;
}): string {
  const price =
    o.rates === null
      ? "unpriced"
      : `${perMtok(o.rates.input)}/${perMtok(o.rates.output)} per Mtok${o.components ? " + fees" : ""}`;
  return o.lane ? `lane · ${price}` : `${o.owner} · ${price}`;
}

/** The hover. Room for the things a picker line has none for. */
function tooltipOf(o: {
  entry: CatalogueRow;
  x: Record<string, unknown>;
  lane: boolean;
  owner: string;
  rates: { input: number; output: number } | null;
  maxInputTokens: number;
  maxOutputTokens: number;
}): string {
  const lines: string[] = [String(o.entry.id)];

  if (o.lane) {
    const job = typeof o.x["job"] === "string" ? o.x["job"] : "unnamed";
    const members = Array.isArray(o.x["members"]) ? o.x["members"].filter((m) => typeof m === "string") : [];
    lines.push(`A lane for ${job}. Cruise picks one member per request.`);
    if (typeof o.x["description"] === "string" && o.x["description"].length > 0) lines.push(o.x["description"]);
    if (members.length > 0) lines.push(`Members: ${members.join(", ")}`);
  } else {
    lines.push(`Served by ${o.owner}.`);
  }

  lines.push(`Context ${o.maxInputTokens.toLocaleString("en-US")} · output ${o.maxOutputTokens.toLocaleString("en-US")} tokens`);

  lines.push(
    o.rates === null
      ? "Unpriced, which is not free: an unpriced model is charged its full reservation."
      : `Up to ${perMtok(o.rates.input)} in / ${perMtok(o.rates.output)} out per million tokens — the dearest rate this model can charge, variants included.`,
  );

  // What the host does with the prompt. `null` is unmeasured, and saying so is
  // the point: a lane that requires no-training-on-data fails a member closed
  // on this rather than assuming, and a person choosing by hand deserves the
  // same information.
  const retention = o.x["data_retention"];
  lines.push(
    retention === "none"
      ? "Prompts are not retained by the host."
      : retention === "retained"
        ? "The host retains prompts and does not train on them."
        : retention === "trains"
          ? "The host may train on prompts."
          : "Prompt retention has not been measured.",
  );

  return lines.join("\n");
}
