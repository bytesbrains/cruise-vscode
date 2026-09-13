# Contributing

Thanks for caring about the extension. This repo is the source of truth for
`bytesbrains.bytesbrains-cruise` on the Visual Studio Marketplace and Open VSX.

## Ground rules

- **Never commit a Cruise key, a Marketplace PAT, or an Open VSX token.** Keys live in the
  editor's `SecretStorage` or in your shell environment for publish commands — nowhere in git.
- **No telemetry, no second host.** The extension talks only to the configured `cruise.endpoint`.
- **Do not commit `dist/`, `*.vsix`, or `node_modules/`.** They are build artifacts.
- Prefer a pull request into `dev` (or `main` for a hotfix). Both branches are protected.

## Setup

```sh
git clone https://github.com/bytesbrains/cruise-vscode.git
cd cruise-vscode
npm ci
```

`npm ci` runs `prepare`, which points `core.hooksPath` at `.githooks/`. Those hooks require
[gitleaks](https://github.com/gitleaks/gitleaks) (`brew install gitleaks`) and fail closed if it
is missing — on purpose.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run secrets:scan
```

CI runs the same on every pull request and on pushes to `main` / `dev`. The required status
check is named `check`.

## Trying a local build

```sh
npm run package
```

Install the VSIX with **Extensions: Install from VSIX…**, point `cruise.endpoint` at
`https://cruise-demo.bytesbrains.net/v1`, and sign in with a `cru_demo_` key.

## Publishing (maintainers)

Publishing is a person on a machine, not a merge. Bump `version` in `package.json`, update
`CHANGELOG.md`, then:

```sh
# Visual Studio Marketplace — needs VSCE_PAT in the environment
npm run publish:marketplace

# Open VSX — needs OVSX_PAT in the environment
npm run publish:openvsx
```

Tag the release as `v0.x.y` after both registries accept it. Do not put either token in the
repo or in Actions secrets unless the workflow that would use them is reviewed for the same
reason deploys are not automatic: a publish that fires on a merge separates the artifact from
the person who decided it.

## Pull requests

1. Branch from `dev`.
2. Keep the change one concern.
3. Make sure `npm test`, `npm run typecheck`, and `npm run build` are green locally.
4. Open a PR; wait for `check` to pass.
