/**
 * The README capture's mock gateway, read by the extension's own parsers.
 *
 * The stills are only honest if the mock behaves like Cruise where the
 * pictures depend on it: separate key tables, a 401 the extension explains as
 * a credentials problem, a catalogue that folds into `bb/` lanes, and a stream
 * the reader turns into text and usage. Review of #21 pointed out nothing
 * checked that.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatModels } from "../src/catalogue.ts";
import { fetchCatalogue, GatewayError, streamCompletion } from "../src/gateway.ts";
import { explain } from "../src/refusal.ts";
import { readCompletionStream } from "../src/stream.ts";
import { startMockGateway, type MockGateway } from "../scripts/capture/mock-gateway.mjs";

let gateway: MockGateway;
beforeAll(async () => {
  gateway = await startMockGateway();
});
afterAll(() => gateway.close());

const at = (deployment: string) => `${gateway.base}/${deployment}/v1`;
const signal = () => AbortSignal.timeout(5_000);

async function refusalOf(deployment: string, key: string): Promise<GatewayError> {
  const error: unknown = await fetchCatalogue(at(deployment), key, signal()).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GatewayError);
  return error as GatewayError;
}

describe("the capture's mock gateway", () => {
  it("keeps production's and the demo's key tables apart, as Cruise does", async () => {
    await expect(fetchCatalogue(at("demo"), "cru_demo_x", signal())).resolves.toBeDefined();
    await expect(fetchCatalogue(at("production"), "cru_live_x", signal())).resolves.toBeDefined();
    await expect(fetchCatalogue(at("production"), "cru_test_x", signal())).resolves.toBeDefined();
    for (const [deployment, key] of [["demo", "cru_live_x"], ["production", "cru_demo_x"], ["production", "cru_svc_x"], ["demo", "sk-other"]] as const) {
      const { refusal } = await refusalOf(deployment, key);
      expect(refusal.status).toBe(401);
      expect(refusal.message).toBe("Incorrect API key provided.");
      // The rejected-key still is this path: the extension must read it as a credentials problem.
      expect(explain(refusal).credentials).toBe(true);
    }
  });

  it("lists only bb/ lanes, each with its job, free on the demo", async () => {
    const models = chatModels(await fetchCatalogue(at("demo"), "cru_demo_x", signal()));
    expect(models.map((m) => m.id)).toEqual([
      "bb/chat-assistant",
      "bb/agentic-coding",
      "bb/code-review",
      "bb/deep-reasoning",
      "bb/extraction",
      "bb/summarization",
      "bb/translation",
    ]);
    for (const model of models) {
      expect(model.family).toBe("cruise-lane");
      // A row without `job` reads "A lane for unnamed" in the picker's hover card.
      expect(model.tooltip).not.toContain("unnamed");
      expect(model.detail).toContain("$0.00");
    }
  });

  it("streams a reply the extension's reader turns into text and usage", async () => {
    const body = await streamCompletion(
      at("demo"),
      "cru_demo_x",
      { model: "bb/agentic-coding", messages: [], stream: true, stream_options: { include_usage: true } },
      signal(),
    );
    let text = "";
    let usage = false;
    for await (const event of readCompletionStream(body)) {
      if (event.kind === "text") text += event.text;
      if (event.kind === "usage") usage = true;
    }
    expect(text).toContain("bb/agentic-coding");
    expect(usage).toBe(true);
  });

  it("records the key's prefix and never the key", () => {
    expect(gateway.seen.length).toBeGreaterThan(0);
    for (const request of gateway.seen) expect(request.prefix).toMatch(/^(cru_[a-z]+_|\(other\))$/);
  });
});
