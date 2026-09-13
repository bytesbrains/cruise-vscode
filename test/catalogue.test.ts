/**
 * The fold from `GET /v1/models` to what the picker offers.
 *
 * The fixtures are shaped like the real response — `x-cruise` and all — because
 * what this file is actually asserting is an agreement between two repositories
 * of one: the Worker's catalogue route and an extension published separately
 * from it. A test written against a convenient shape would hold nothing.
 */

import { describe, expect, it } from "vitest";
import { chatModels } from "../src/catalogue.ts";

/** A routable chat row, as `src/index.ts` writes one. */
function row(id: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    id,
    object: "model",
    created: 1_756_000_000,
    owned_by: "deepseek",
    "x-cruise": {
      modality: "chat",
      tools: true,
      parallel_tool_calls: true,
      streaming: true,
      usage_reported: true,
      vision: false,
      json_schema: true,
      max_context: 65_536,
      max_output: 8_192,
      max_input_chars: null,
      dimensions: null,
      data_retention: "retained",
      measured_at: "2026-08-21T04:00:00.000Z",
      measurement_source: "conformance",
      image_variants: null,
      pricing: {
        input_micros_per_mtok: 270_000,
        output_micros_per_mtok: 1_100_000,
        cached_input_micros_per_mtok: 70_000,
        effective_from: "2026-08-01",
        source: "https://api-docs.deepseek.com/quick_start/pricing",
        variants: [],
        components: [],
      },
      reliability: null,
      ...overrides,
    },
  };
}

const listing = (...data: unknown[]): unknown => ({ object: "list", data });

describe("chatModels", () => {
  it("carries a chat row through with its limits and capabilities", () => {
    const [model] = chatModels(listing(row("deepseek/deepseek-chat")));
    expect(model).toMatchObject({
      id: "deepseek/deepseek-chat",
      name: "deepseek-chat",
      family: "deepseek",
      version: "2026-08-21T04:00:00.000Z",
      maxInputTokens: 65_536,
      maxOutputTokens: 8_192,
      toolCalling: true,
      imageInput: false,
    });
  });

  it("drops every modality that is not chat", () => {
    // Each of these is catalogued, routable, and served at a route this
    // provider does not speak. Offering one produces `unsupported_capability`
    // on first use, which reads as the extension being broken.
    const listed = chatModels(
      listing(
        row("openai/gpt-image-1", { modality: "image" }),
        row("elevenlabs/eleven-v3", { modality: "speech" }),
        row("openai/text-embedding-3-small", { modality: "embedding" }),
        row("deepseek/deepseek-chat"),
      ),
    );
    expect(listed.map((model) => model.id)).toEqual(["deepseek/deepseek-chat"]);
  });

  it("drops a row it cannot size, rather than inventing a limit", () => {
    // VS Code budgets a prompt against these two numbers. A guess makes the
    // editor send a request the gateway refuses `limit_exceeded` after the
    // user has waited for it.
    expect(chatModels(listing(row("x/y", { max_context: null })))).toEqual([]);
    expect(chatModels(listing(row("x/y", { max_output: null })))).toEqual([]);
  });

  it("drops a row that cannot stream", () => {
    // `provideLanguageModelChatResponse` is a streaming contract. Unmeasured
    // reads the same way as measured-false, because unknown fails closed.
    expect(chatModels(listing(row("x/y", { streaming: false })))).toEqual([]);
    expect(chatModels(listing(row("x/y", { streaming: null })))).toEqual([]);
  });

  it("reads an unmeasured capability closed", () => {
    const [model] = chatModels(listing(row("x/y", { tools: null, vision: null })));
    expect(model?.toolCalling).toBe(false);
    expect(model?.imageInput).toBe(false);
  });

  it("prices at the dearest variant, never the headline or an average", () => {
    // The same rule `src/lanes.ts` folds a lane's price by: a peak-hour rate a
    // caller is not shown is a rate they budget against by accident.
    const [model] = chatModels(
      listing(
        row("deepseek/deepseek-chat", {
          pricing: {
            input_micros_per_mtok: 270_000,
            output_micros_per_mtok: 1_100_000,
            cached_input_micros_per_mtok: 70_000,
            effective_from: "2026-08-01",
            source: "https://api-docs.deepseek.com/quick_start/pricing",
            variants: [
              {
                prompt_tokens_from: 0,
                peak_utc: "00:30-16:30",
                input_micros_per_mtok: 560_000,
                output_micros_per_mtok: 1_680_000,
                cached_input_micros_per_mtok: 140_000,
              },
            ],
            components: [],
          },
        }),
      ),
    );
    expect(model?.detail).toBe("deepseek · $0.56/$1.68 per Mtok");
  });

  it("says unpriced rather than free, because they are not the same", () => {
    // An unpriced model is charged its full reservation. "$0.00" would be the
    // single most expensive thing this file could print.
    const [model] = chatModels(listing(row("x/y", { pricing: null })));
    expect(model?.detail).toBe("deepseek · unpriced");
    expect(model?.tooltip).toContain("not free");
  });

  it("prices a demo row at zero, which is a price", () => {
    // The demo's catalogue is production's ids with every price zeroed, and
    // that is a measured fact rather than a missing one.
    const [model] = chatModels(
      listing(
        row("x/y", {
          pricing: {
            input_micros_per_mtok: 0,
            output_micros_per_mtok: 0,
            cached_input_micros_per_mtok: 0,
            effective_from: "2026-09-08",
            source: "demo",
            variants: [],
            components: [],
          },
        }),
      ),
    );
    expect(model?.detail).toBe("deepseek · $0.00/$0.00 per Mtok");
  });

  it("flags the components a token rate does not cover", () => {
    const [model] = chatModels(
      listing(
        row("x/y", {
          pricing: {
            input_micros_per_mtok: 1_000_000,
            output_micros_per_mtok: 2_000_000,
            cached_input_micros_per_mtok: null,
            effective_from: "2026-08-01",
            source: "s",
            variants: [],
            components: [{ component: "search", variant: "", micros: 10_000_000, per: 1000 }],
          },
        }),
      ),
    );
    expect(model?.detail).toContain("+ fees");
  });

  it("keeps a lane whole and names its members", () => {
    const [lane] = chatModels(
      listing(
        row("bb/extraction", {
          lane: true,
          job: "extraction",
          description: "Structured fields out of unstructured text",
          members: ["deepseek/deepseek-chat", "mistral/mistral-small-latest"],
          selection: "cheapest",
        }),
      ),
    );
    // The `bb/` prefix is the point of a lane's name, so it is not stripped.
    expect(lane?.name).toBe("bb/extraction");
    expect(lane?.family).toBe("cruise-lane");
    expect(lane?.detail).toMatch(/^lane · /);
    expect(lane?.tooltip).toContain("deepseek/deepseek-chat, mistral/mistral-small-latest");
  });

  it("survives a response that is not the one it expects", () => {
    expect(chatModels(null)).toEqual([]);
    expect(chatModels({})).toEqual([]);
    expect(chatModels({ object: "list", data: [null, 7, {}, { id: "x" }] })).toEqual([]);
  });
});
