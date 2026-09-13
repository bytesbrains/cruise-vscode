# Changelog

## 0.1.3 — 2026-09-13

Republish so the Marketplace carries a complete asset set for this version — the
0.1.2 upload timed out mid-flight and left the listing without a usable icon in
the editor. Same bits otherwise.

## 0.1.2 — 2026-09-13

Source of truth moved to the public repository
[`bytesbrains/cruise-vscode`](https://github.com/bytesbrains/cruise-vscode). Marketplace and
Open VSX listings now point at that repo and at the product page
[bytesbrains.com/cruise](https://bytesbrains.com/cruise). No behaviour change.

## 0.1.1 — 2026-09-11

**Renamed from `cruise` to `bytesbrains-cruise`**, so the extension id is now
`bytesbrains.bytesbrains-cruise`. The Visual Studio Marketplace wants an extension's `name` unique
across every publisher, not only within ours, and `cruise` was already taken — `vsce publish`
refused 0.1.0 with *"The extension 'cruise' already exists in the Marketplace"* although
`bytesbrains.cruise` did not. The display name, the `cruise.*` settings and commands, and the
`cruise` chat vendor are unchanged.

Nothing else changed. Because the id changed, the key a 0.1.0 install stored in `SecretStorage` does
not carry over: enter it again with **Cruise: Manage API key**.

## 0.1.0 — 2026-09-09, Open VSX only, as `bytesbrains.cruise`

The first version. A language model chat provider for the vendor `cruise`:

- Every chat model and lane a Cruise key can reach appears in the model picker, fetched from
  `GET /v1/models` rather than frozen into the extension.
- The key lives in the editor's `SecretStorage` and is entered through
  **Cruise: Manage API key**, which verifies it against the catalogue before saying it worked.
- The endpoint is a setting, so `cruise-demo.bytesbrains.net` and a `cru_demo_` key are a
  working first run with nothing issued and nothing spent. A user setting only: a cloned
  repository's `.vscode/settings.json` cannot point the stored key at a host of its choosing.
- Streaming responses, tool calls, and image input where the model was measured to take it.
- A budget refusal and a credit refusal say different things, because they are.
- Ships under its own proprietary licence, `LICENSE.txt`, because Open VSX accepts nothing
  without one. Use with Cruise, no modified copies; the terms for the service are the service's.

The icon is the Cruise mark — the gauge inside the `C` — cropped from the brand wordmark in
`bytesbrains-landing` (`frontend/public/brand/cruise-logo-960.png`) rather than drawn again.
The wordmark itself is not the icon: it is more than twice as wide as it is tall, and at the
42 pixels the extensions sidebar gives it, "AI API GATEWAY" is a grey smudge.
