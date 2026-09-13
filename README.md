# BytesBrains Cruise for VS Code

Every model your [Cruise](https://bytesbrains.com/cruise) key can reach, in Copilot Chat and
agent mode, beside the built-in ones. Your budgets, per-project keys and cost ledger stay
exactly where they are — this extension is a client of the gateway, not a second place spend
can happen.

| | |
|---|---|
| **Product** | [bytesbrains.com/cruise](https://bytesbrains.com/cruise) |
| **Source** | [github.com/bytesbrains/cruise-vscode](https://github.com/bytesbrains/cruise-vscode) |
| **Visual Studio Marketplace** | [BytesBrains.bytesbrains-cruise](https://marketplace.visualstudio.com/items?itemName=BytesBrains.bytesbrains-cruise) |
| **Open VSX** | [bytesbrains/bytesbrains-cruise](https://open-vsx.org/extension/bytesbrains/bytesbrains-cruise) |

## Try it before anyone issues you a key

1. Install the extension from the Marketplace or Open VSX.
2. Run **Cruise: Manage API key** from the command palette and pick **Try the demo**.
3. Paste a `cru_demo_` key.

That points the endpoint at `https://cruise-demo.bytesbrains.net/v1` — production's model ids
exactly, every price zero, and no provider credential anywhere in the deployment. Answers are
fabricated. It is the install-and-see path, and it costs nothing to take.

For real traffic, set `cruise.endpoint` back to `https://cruise.bytesbrains.net/v1` and run
the same command with a `cru_live_` key.

## What it does

| | |
|---|---|
| Registers | The vendor `cruise`, so its models appear in the picker rather than behind a chat prefix |
| Models | Fetched from `GET /v1/models` every time the list is asked for. Never a list in the source |
| Key | The editor's `SecretStorage`, entered through **Cruise: Manage API key** |
| Endpoint | The `cruise.endpoint` setting — a user setting, which a workspace cannot override: the key is sent to whatever this names |
| Output bound | The `cruise.maxOutputTokens` setting, clamped to the model's measured ceiling |

**The model list is fetched, not shipped.** Cruise publishes only what it can actually serve,
for the key presented, with prices. A measurement older than 30 days is treated as unverified
rather than as last known good and the model stops being routable — so a list frozen into an
extension would offer models the gateway refuses, and you would blame the extension. Correctly.

**The key never touches `settings.json`.** Settings sync would replicate a live key onto every
machine you sign into, which is a leak with no event to notice it by.

**Lanes are models here too.** A `bb/…` row in the picker is a lane: Cruise picks a member per
request by price and by what the request needs. The hover names the members and the dearest
rate any of them can charge, because that is what a budget has to survive.

## When it refuses

Cruise answers both of its spending refusals with `429` and OpenAI's `insufficient_quota`, on
purpose — that is the shape every OpenAI client already understands. They are not the same
event, and this extension says which one you hit:

| | |
|---|---|
| **Out of budget** | A period cap. It names when it resets, and waiting is the fix |
| **Out of credit** | A lifetime cap. Waiting does nothing; a credit grant is what lifts it |

Anything else — a rate limit, a stale measurement, a model your key may not call — is passed
through with Cruise's own sentence, which names the project and the figures, plus whatever the
editor can add about what to do next. Detail goes to the **BytesBrains Cruise** output channel.

## What it does not do

No telemetry. No update check. **No traffic anywhere but the configured base URL**, and no
runtime dependencies at all — the whole extension is one bundled file.

It holds a `cru_` key and never a provider credential. If this machine is compromised, the
blast radius is one key you can revoke, capped by a budget and a rate limit that were set when
it was issued. Ask for yours with `--rate-limit` and `--account-rate-limit` set.

## Building it

```sh
npm ci
npm run build
npm test
npm run typecheck
```

`npm run package` produces a VSIX you can install with **Extensions: Install from VSIX…**.

Publishing to the Marketplace and Open VSX is a person running a command, not something a
merge does. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

See [LICENSE.txt](LICENSE.txt). Proprietary: use with Cruise; no modified redistributions.
