/**
 * Where the key lives, and where it deliberately does not.
 *
 * **`SecretStorage`, never `settings.json`.** Settings sync would replicate a
 * live `cru_live_` key onto every machine the user has ever signed into, and
 * that is a leak with no event to notice it by — no request fails, nothing is
 * logged, and the key is simply somewhere else now. `SecretStorage` is the
 * editor's keychain: per machine, not synced, and cleared with the extension.
 *
 * The endpoint *is* a setting, because it is not a secret and because being
 * able to point this at `cruise-demo.bytesbrains.net` is what makes the
 * extension installable before anyone has issued a key (`docs/demo.md`). But
 * it is a **`machine`-scoped** setting, which a workspace cannot override, and
 * that is the other half of keeping the key: the extension sends the stored
 * key as a bearer token to whatever this setting names, so a
 * `.vscode/settings.json` in a cloned repository that set it would have the
 * key posted to a host of the repository author's choosing on the next
 * request. Workspace Trust does not close that — a setting is only withheld
 * in Restricted Mode when it is declared `restricted`, and a trusted clone is
 * still somebody else's file. Raised in review of #356.
 */

import * as vscode from "vscode";

/**
 * The one entry this extension writes to the keychain. This is the entry's
 * *name*, not a value: the key itself is whatever the user pasted, and never
 * appears in this file. Named `KEYCHAIN_ENTRY` rather than anything ending in
 * `SECRET`, because a constant of that name holding a quoted string reads as a
 * credential to a scanner and to a person skimming — review of #356 flagged it
 * as one nine times.
 */
const KEYCHAIN_ENTRY = "cruise.apiKey";

const ENDPOINT_SETTING = "cruise.endpoint";
const DEFAULT_ENDPOINT = "https://cruise.bytesbrains.net/v1";

export const DEMO_ENDPOINT = "https://cruise-demo.bytesbrains.net/v1";

/** The configured data plane, or production. */
export function endpoint(): string {
  const configured = vscode.workspace.getConfiguration().get<string>(ENDPOINT_SETTING);
  return configured === undefined || configured.trim() === "" ? DEFAULT_ENDPOINT : configured.trim();
}

/** The stored key, or `undefined` when the user has not signed in. */
export async function storedKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const key = await secrets.get(KEYCHAIN_ENTRY);
  return key === undefined || key === "" ? undefined : key;
}

export async function storeKey(secrets: vscode.SecretStorage, key: string): Promise<void> {
  await secrets.store(KEYCHAIN_ENTRY, key);
}

export async function forgetKey(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(KEYCHAIN_ENTRY);
}

/**
 * Ask for a key.
 *
 * `password: true` so it is not shown, not in the input box's history, and not
 * in a screen recording of somebody demonstrating the extension.
 *
 * The shape is checked only as far as the prefix. The exact key format lives in
 * one place — `src/keys.ts`, from which the OpenAPI document, the gitleaks rule
 * and `docs/keys.md` all derive — and a second copy pinned into a separately
 * published extension is precisely the drift `npm run docs:check` exists to
 * catch: change the length and a stale validator starts refusing keys that are
 * perfectly good, offline, with no way for the user to override it. So the
 * gateway is the authority on whether a key works, and the prefix check is a
 * typo catcher, not a gate — it warns and still stores.
 */
export async function promptForKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const entered = await vscode.window.showInputBox({
    title: "BytesBrains Cruise",
    prompt: `Paste a Cruise API key. It is stored in the editor's secret storage, never in settings. Endpoint: ${endpoint()}`,
    placeHolder: "cru_live_…",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() === "" ? "A key is required." : undefined),
  });

  if (entered === undefined) return undefined;
  // Trimmed, because a key pasted out of a terminal brings a newline with it
  // and a bearer token with a trailing newline is a 401 nobody can see.
  const key = entered.trim();

  if (!key.startsWith("cru_")) {
    vscode.window.showWarningMessage(
      "That does not look like a Cruise key — they begin with `cru_`. Storing it anyway; the gateway decides.",
    );
  }

  await storeKey(secrets, key);
  return key;
}
