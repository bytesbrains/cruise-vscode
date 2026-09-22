<p align="center">
  <img src="https://bytesbrains.com/brand/cruise-logo-480.png" alt="BytesBrains Cruise" width="280" />
</p>

<h1 align="center">BytesBrains Cruise for VS Code</h1>

<p align="center">
  Every model your Cruise key can reach — in Copilot Chat and agent mode —<br />
  with budgets, per-project keys, and one cost ledger that stay on the gateway.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=BytesBrains.bytesbrains-cruise"><img src="https://img.shields.io/visual-studio-marketplace/v/BytesBrains.bytesbrains-cruise?label=Marketplace&amp;color=0078D4" alt="Visual Studio Marketplace" /></a>
  <a href="https://open-vsx.org/extension/bytesbrains/bytesbrains-cruise"><img src="https://img.shields.io/open-vsx/v/bytesbrains/bytesbrains-cruise?label=Open%20VSX&amp;color=C160EF" alt="Open VSX" /></a>
  <a href="https://bytesbrains.com/cruise"><img src="https://img.shields.io/badge/Product-bytesbrains.com%2Fcruise-111111" alt="Product" /></a>
</p>

---

## Install

| Where | Link |
| --- | --- |
| **Visual Studio Marketplace** | [BytesBrains.bytesbrains-cruise](https://marketplace.visualstudio.com/items?itemName=BytesBrains.bytesbrains-cruise) |
| **Open VSX** | [bytesbrains/bytesbrains-cruise](https://open-vsx.org/extension/bytesbrains/bytesbrains-cruise) |
| **Product** | [bytesbrains.com/cruise](https://bytesbrains.com/cruise) |

This extension is a **client** of Cruise, not a second place spend can happen. Your keys,
budgets and ledger stay on the gateway.

---

## Try it before anyone issues you a key

1. Install the extension.
2. Command palette → **Cruise: Manage API key** → **Try the demo**.
3. Paste a `cru_demo_` key.

That points `cruise.endpoint` at `https://cruise-demo.bytesbrains.net/v1` — production’s
model ids exactly, every price zero, and no provider credential in the deployment. Answers
are fabricated. It costs nothing to take.

For real traffic, enter a `cru_live_` key with **Cruise: Manage API key** — the endpoint
moves back to `https://cruise.bytesbrains.net/v1` on its own, because a live key is only
accepted there.

## A proxy or your own gateway

Command palette → **Cruise: Change endpoint** → **Custom URL…**, and paste the base URL
(e.g. `https://proxy.example.com/v1`). The stored key is sent to it as a bearer token, so
`https://` is required; plain `http://` is allowed only for `localhost`. **Production** and
**Demo** in the same menu point it back at Cruise.

If a key is rejected, the dialog says which endpoint it went to, what kind of key it was
(`cru_live_…`, never the key itself), what the gateway answered, and the likely cause —
with the fix on a button.

---

## What you get

| | |
| --- | --- |
| **Vendor** | Registers as `cruise`, so models appear in Copilot Chat’s picker and in agent mode — not behind a chat prefix |
| **Models** | Fetched from `GET /v1/models` whenever the list is asked for. Never frozen into the extension |
| **Key** | Lives in the editor’s `SecretStorage`, entered only through **Cruise: Manage API key** |
| **Endpoint** | `cruise.endpoint` — a *user* setting a workspace cannot override, because the key is sent wherever it names |
| **Output bound** | `cruise.maxOutputTokens`, clamped to each model’s measured ceiling |

### Why the list is fetched, not shipped

Cruise publishes only what it can actually serve for the key you present, with prices. A
measurement older than 30 days is treated as unverified rather than last-known-good, and the
model stops being routable. A list baked into an extension would offer models the gateway
refuses — and you would blame the extension. Correctly.

### Why the key never touches `settings.json`

Settings sync would replicate a live key onto every machine you sign into. That is a leak
with no event to notice it by.

### Lanes are models here too

A `bb/…` row in the picker is a **lane**: Cruise picks a member per request by price and by
what the request needs. Hover shows the members and the dearest rate any of them can charge —
because that is what a budget has to survive.

---

## When it refuses

Cruise answers both spending refusals with `429` and OpenAI’s `insufficient_quota` on purpose —
that is the shape every OpenAI client already understands. They are not the same event; this
extension says which one you hit:

| Refusal | Meaning |
| --- | --- |
| **Out of budget** | A period cap. It names when it resets; waiting is the fix |
| **Out of credit** | A lifetime cap. Waiting does nothing; a credit grant lifts it |

Anything else — rate limit, stale measurement, a model your key may not call — is passed
through with Cruise’s own sentence (project and figures), plus whatever the editor can add
about what to do next. Detail goes to the **BytesBrains Cruise** output channel.

---

## What it does not do

- No telemetry
- No update check against a second host
- **No traffic anywhere but the configured base URL**
- No runtime dependencies — the whole extension is one bundled file

It holds a `cru_` key and never a provider credential. If this machine is compromised, the
blast radius is one key you can revoke, capped by the budget and rate limit set when it was
issued. Ask for yours with `--rate-limit` and `--account-rate-limit` set.

---

## Develop

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm run package` writes a `.vsix` you can load with **Extensions: Install from VSIX…**.

Publishing to the Marketplace and Open VSX is a person running a command — not something a
merge does. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

---

## Licence

See [LICENSE.txt](LICENSE.txt). Proprietary: use with Cruise; no modified redistributions.
