/**
 * A stand-in for Cruise's two public deployments, on 127.0.0.1, for the
 * README capture and nothing else.
 *
 * It keeps the one rule the visuals have to show honestly: **separate key
 * tables** (`src/pairing.ts`). `/production` accepts `cru_live_` and
 * `cru_test_`, `/demo` accepts `cru_demo_`, and anything else is the same
 * `401 Incorrect API key provided.` the real gateways send — so the
 * rejected-key dialog in the stills is the extension reacting to a real
 * refusal, not a staged one. `/proxy` stands for a proxy in front of
 * production.
 *
 * No key here is real and nothing is forwarded anywhere.
 */

import http from "node:http";

const DEPLOYMENTS = {
  production: ["cru_live_", "cru_test_"],
  demo: ["cru_demo_"],
  proxy: ["cru_live_", "cru_test_"],
};

const MEASURED = "2026-09-01";

/**
 * The rows the picker shows: Cruise's platform lanes, `bb/<job>`, with the
 * jobs as `docs/vocabulary.md` in the gateway repository names them. Shaped
 * like `GET /v1/models`, trimmed to what `src/catalogue.ts` reads. The demo
 * lists production's ids with every price zero (`docs/demo.md`), so the two
 * differ only in price.
 */
const LANES = [
  ["bb/chat-assistant", "Interactive turns where a capable small model is enough.", { tools: true, vision: true, max_context: 128_000, max_output: 16_384 }, [300_000, 1_200_000]],
  ["bb/agentic-coding", "Long tool-use loops over a repository.", { tools: true, vision: false, max_context: 200_000, max_output: 32_000 }, [1_740_000, 3_480_000]],
  ["bb/code-review", "Reads a diff or a repository and reasons about what is wrong with it.", { tools: true, vision: false, max_context: 200_000, max_output: 16_384 }, [1_740_000, 3_480_000]],
  ["bb/deep-reasoning", "Problems that reward thinking tokens.", { tools: false, vision: false, max_context: 128_000, max_output: 32_000 }, [2_000_000, 8_000_000]],
  ["bb/extraction", "Classification and structured extraction across many inputs.", { tools: true, vision: false, max_context: 128_000, max_output: 8_192 }, [140_000, 280_000]],
  ["bb/summarization", "A long input to a short output.", { tools: false, vision: false, max_context: 128_000, max_output: 8_192 }, [140_000, 280_000]],
  ["bb/translation", "Between natural languages.", { tools: false, vision: false, max_context: 64_000, max_output: 8_192 }, [140_000, 280_000]],
];

function catalogue(free) {
  return {
    object: "list",
    data: LANES.map(([id, description, limits, [input, output]]) => ({
      id,
      object: "model",
      owned_by: "cruise",
      "x-cruise": {
        modality: "chat",
        lane: true,
        job: id.slice("bb/".length),
        streaming: true,
        measured_at: MEASURED,
        description,
        ...limits,
        pricing: free ? { input_micros_per_mtok: 0, output_micros_per_mtok: 0 } : { input_micros_per_mtok: input, output_micros_per_mtok: output },
      },
    })),
  };
}

/** What the demo answers, streamed a few words at a time like a model would. */
const REPLY =
  "Cruise routed this through the **bb/agentic-coding** lane. On the demo every price is zero and the answer is fabricated — swap in a `cru_live_` key and the same request is billed against your project's budget.";

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function refuse(res) {
  send(res, 401, { error: { message: "Incorrect API key provided.", type: "authentication_error", code: null } });
}

async function stream(res, model) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const frame = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const words = REPLY.split(/(?<= )/);
  for (let i = 0; i < words.length; i += 3) {
    frame({ id: "chatcmpl-capture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: words.slice(i, i + 3).join("") }, finish_reason: null }] });
    await new Promise((resolve) => setTimeout(resolve, 45));
  }
  frame({ id: "chatcmpl-capture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  frame({ id: "chatcmpl-capture", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 412, completion_tokens: 48, total_tokens: 460 } });
  res.end("data: [DONE]\n\n");
}

/** Start on a free port. Resolves to the base URL and a way to stop it. */
export function startMockGateway() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const match = /^\/(production|demo|proxy)\/v1\/(models|chat\/completions)$/.exec(req.url ?? "");
    if (match === null) return send(res, 404, { error: { message: "Not found." } });
    const [, deployment, route] = match;
    const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    seen.push({ deployment, route, prefix: /^cru_[a-z]+_/.exec(key)?.[0] ?? "(other)" });
    if (!DEPLOYMENTS[deployment].some((prefix) => key.startsWith(prefix))) return refuse(res);

    if (route === "models") return send(res, 200, catalogue(deployment === "demo"));
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const model = JSON.parse(body || "{}").model ?? "bb/agentic-coding";
      void stream(res, model);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, seen, close: () => new Promise((done) => server.close(done)) });
    });
  });
}
