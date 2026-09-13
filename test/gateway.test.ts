/**
 * The two calls, and the endpoint they are built from.
 *
 * `fetch` is stubbed rather than a server started: what is being asserted is
 * the request this extension makes and the way it reads a refusal, both of
 * which are decided before a socket opens.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCatalogue, GatewayError, normaliseEndpoint, streamCompletion } from "../src/gateway.ts";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

function stub(response: Response): ReturnType<typeof vi.fn> {
  const fake = vi.fn(() => Promise.resolve(response));
  globalThis.fetch = fake as unknown as typeof fetch;
  return fake;
}

describe("normaliseEndpoint", () => {
  it("leaves a well-formed endpoint alone", () => {
    expect(normaliseEndpoint("https://cruise.bytesbrains.net/v1")).toBe("https://cruise.bytesbrains.net/v1");
  });

  it("appends the version a browser bar leaves off", () => {
    // Pasting the host out of an address bar is the likeliest way this setting
    // is filled in, and a 404 on /models is a worse answer than the one they
    // meant.
    expect(normaliseEndpoint("https://cruise-demo.bytesbrains.net")).toBe("https://cruise-demo.bytesbrains.net/v1");
    expect(normaliseEndpoint("  https://cruise.bytesbrains.net/v1/  ")).toBe("https://cruise.bytesbrains.net/v1");
  });
});

describe("fetchCatalogue", () => {
  it("presents the key as a bearer token", async () => {
    const fake = stub(Response.json({ object: "list", data: [] }));
    await fetchCatalogue("https://cruise.bytesbrains.net/v1", "cru_demo_key", new AbortController().signal);
    const [url, init] = fake.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cruise.bytesbrains.net/v1/models");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer cru_demo_key");
  });

  it("throws a refusal carrying the code, not the status", async () => {
    stub(
      Response.json(
        { error: { message: "Tenant 'bb' has no credit left.", type: "insufficient_quota", param: null, code: "wallet_exhausted" } },
        { status: 429 },
      ),
    );
    await expect(fetchCatalogue("https://x/v1", "k", new AbortController().signal)).rejects.toMatchObject({
      name: "GatewayError",
      refusal: { code: "wallet_exhausted", retryAfter: null },
    });
  });

  it("still refuses when the body is not JSON at all", async () => {
    // Something in front of the gateway — a proxy, a captive portal — and the
    // parse failure must not mask the refusal it arrived with.
    stub(new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(fetchCatalogue("https://x/v1", "k", new AbortController().signal)).rejects.toBeInstanceOf(GatewayError);
  });
});

describe("streamCompletion", () => {
  it("posts to the completions path and returns the body unread", async () => {
    const body = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    const fake = stub(new Response(body, { status: 200 }));
    const request = {
      model: "bb/extraction",
      messages: [],
      stream: true as const,
      stream_options: { include_usage: true as const },
    };
    const returned = await streamCompletion("https://cruise.bytesbrains.net/v1", "k", request, new AbortController().signal);
    expect(returned).toBe(body);
    const [url, init] = fake.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cruise.bytesbrains.net/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "bb/extraction", stream: true });
  });

  it("refuses a 200 with no body rather than hand back nothing", async () => {
    stub(new Response(null, { status: 200 }));
    await expect(
      streamCompletion("https://x/v1", "k", { model: "m", messages: [], stream: true, stream_options: { include_usage: true } }, new AbortController().signal),
    ).rejects.toBeInstanceOf(GatewayError);
  });
});

describe("a 200 that is not JSON", () => {
  it("is a refusal naming the endpoint, not a syntax error", async () => {
    // A captive portal or an endpoint setting that names a website. The raw
    // `SyntaxError` reached the user as "could not reach Cruise", which is the
    // one thing that did not happen. Review of #356.
    stub(new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(fetchCatalogue("https://portal.example", "k", new AbortController().signal)).rejects.toMatchObject({
      name: "GatewayError",
      refusal: { status: 200, code: null, message: expect.stringContaining("https://portal.example/v1/models answered 200") },
    });
  });
});
