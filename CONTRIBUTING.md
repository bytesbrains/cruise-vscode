# Contributing

Thanks for caring about the extension. This repo is the source of truth for
`bytesbrains.bytesbrains-cruise` on the Visual Studio Marketplace and Open VSX.

## Ground rules

- **Never commit a Cruise key, a Marketplace PAT, or an Open VSX token.** Keys live in the
  editor's `SecretStorage`. Publish tokens live only as GitHub Actions secrets
  (`VSCE_PAT`, `OVSX_PAT`) or in a maintainer's local environment for a manual retry.
- **No telemetry, no second host.** The extension talks only to the configured `cruise.endpoint`.
- **Do not commit `dist/`, `*.vsix`, or `node_modules/`.** They are build artifacts.
- Prefer a pull request into `dev` (or `main` for a hotfix). Both branches are protected.

## Setup

```sh
git clone https://github.com/bytesbrains/cruise-vscode.git
cd cruise-vscode
npm ci
```

`npm ci` runs `prepare`, which points `core.hooksPath` at `.githooks/`. **pre-commit**
runs `gitleaks protect` on the staged diff; **pre-push** runs `gitleaks detect` over full
history — both with `.gitleaks.toml` (Cruise key shapes included). Those hooks require
[gitleaks](https://github.com/gitleaks/gitleaks) (`brew install gitleaks`) and fail closed if
it is missing — on purpose.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run secrets:scan
```

CI runs the same on every pull request and on pushes to `main` / `dev`, and also packages a
VSIX artifact. The required status check is named `check`.

## Trying a local build

```sh
npm run package
```

Install the VSIX with **Extensions: Install from VSIX…**, point `cruise.endpoint` at
`https://cruise-demo.bytesbrains.net/v1`, and sign in with a `cru_demo_` key.

## The README's pictures

Every image in the README is generated, never recorded by hand, so it can be regenerated
whenever the UI changes:

```sh
npx playwright-core install chromium   # once, for the diagram
npm run capture                        # everything, into media/readme/
npm run capture -- rejected-key        # or one: walkthrough, change-endpoint, rejected-key, pairing
```

`scripts/capture/` drives a real VS Code, pinned in `editor.mjs` and downloaded once into
`.vscode-test/`, with a throwaway profile, a fixed window size, theme and pace, and the
extension built from `src/`. That build carries one change: `fetch` sends the two Cruise hosts
and `proxy.example.com` to `mock-gateway.mjs` on 127.0.0.1, and refuses any other URL. The
mock keeps production's and the demo's key tables apart, so the rejected-key dialog is the
extension's real answer to a real 401. It needs **no key, no account and no network** apart
from the one-time downloads. The editor's own traffic goes to a closed proxy port. `ffmpeg`
must be on `PATH` (`brew install ffmpeg`). The diagram is `diagram.html`, rendered to PNG,
because the Marketplace rejects SVG in a README.

The pictures stay out of the VSIX (`.vscodeignore`). `vsce` rewrites the README's relative
image links to this repository on GitHub, and that is where the Marketplace loads them from.

## Releasing (maintainers)

A release is a **tag**, not a merge. The `release` workflow publishes to the Marketplace and
Open VSX, then attaches the VSIX to a GitHub Release.

1. On `main`, bump `version` in `package.json` and update `CHANGELOG.md`.
2. Merge that PR (wait for `check`).
3. Tag and push:

```sh
git tag v0.x.y main
git push origin v0.x.y
```

The tag **must** match `package.json` (`v0.1.4` ↔ `"0.1.4"`). The workflow fails closed if
`VSCE_PAT` or `OVSX_PAT` is missing.

To retry a failed publish without retagging: **Actions → release → Run workflow** and pass the
existing tag.

Local publish (escape hatch only):

```sh
export VSCE_PAT=…   # or map from AZURE_MARKETPLACE_PAT
export OVSX_PAT=…   # or map from OVSX_BB_CRUISE_PUBLISHING_TOKEN
npm run publish:marketplace
npm run publish:openvsx
```

## Pull requests

1. Branch from `dev`.
2. Keep the change one concern.
3. Make sure `npm test`, `npm run typecheck`, and `npm run build` are green locally.
4. Open a PR; wait for `check` to pass.
