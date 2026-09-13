/**
 * Activation, and the one command the user ever runs.
 *
 * The extension contributes a **language model chat provider** rather than a
 * chat participant: registering a vendor is what puts every model a Cruise key
 * can reach into Copilot Chat's own picker and into agent mode, beside the
 * built-in ones, instead of behind a `@cruise` prefix nobody discovers.
 *
 * Activation is `onLanguageModelChat:cruise` — the editor starts this only
 * when something actually asks for the vendor. Nothing runs at startup, no
 * request is made until a model list is wanted, and an installed-and-unused
 * extension costs a window nothing.
 */

import * as vscode from "vscode";
import { chatModels } from "./catalogue.ts";
import { DEMO_ENDPOINT, endpoint, forgetKey, promptForKey, storedKey } from "./credentials.ts";
import { fetchCatalogue, GatewayError } from "./gateway.ts";
import { CruiseChatProvider } from "./provider.ts";
import { explain } from "./refusal.ts";

const VENDOR = "cruise";
const MANAGE_COMMAND = "cruise.manageKey";
const ENDPOINT_SETTING = "cruise.endpoint";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("BytesBrains Cruise", { log: true });
  context.subscriptions.push(log);

  const provider = new CruiseChatProvider(context.secrets, log);
  context.subscriptions.push(provider);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));

  context.subscriptions.push(
    vscode.commands.registerCommand(MANAGE_COMMAND, () => manage(context, log, () => provider.refresh())),
  );

  // The catalogue is a property of the key and the endpoint, both of which the
  // user can change while the picker is open. Telling the editor the list has
  // moved is cheaper than a stale list that refuses on first use.
  context.subscriptions.push(context.secrets.onDidChange((event) => {
    if (event.key.startsWith("cruise.")) provider.refresh();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(ENDPOINT_SETTING)) provider.refresh();
  }));
}

export function deactivate(): void {
  // Nothing to unwind: every disposable is on the context's subscriptions, and
  // the key lives in the editor's keychain rather than in this process.
}

/**
 * The management command, reached from the model picker's own affordance and
 * from the palette.
 *
 * Signing in **verifies**: the key is stored, then immediately used to read
 * `GET /v1/models`, and the user is told how many models it reaches. A key
 * that was pasted with a character missing otherwise fails much later, inside
 * a chat request, where it reads as the model being broken.
 */
async function manage(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  refresh: () => void,
): Promise<void> {
  const existing = await storedKey(context.secrets);

  const choice = await vscode.window.showQuickPick(
    [
      { label: existing === undefined ? "Sign in with an API key" : "Replace the stored key", id: "set" },
      { label: "Try the demo", detail: `Point the endpoint at ${DEMO_ENDPOINT} and use a cru_demo_ key`, id: "demo" },
      ...(existing === undefined ? [] : [{ label: "Sign out", detail: "Remove the key from this machine", id: "clear" }]),
    ],
    { title: `BytesBrains Cruise — ${endpoint()}`, placeHolder: "What would you like to do?" },
  );
  if (choice === undefined) return;

  if (choice.id === "clear") {
    await forgetKey(context.secrets);
    refresh();
    vscode.window.showInformationMessage("The Cruise key has been removed from this machine.");
    return;
  }

  if (choice.id === "demo") {
    // Global rather than workspace: a demo endpoint is a property of the
    // person trying the extension, not of the folder they happen to have open.
    await vscode.workspace
      .getConfiguration()
      .update(ENDPOINT_SETTING, DEMO_ENDPOINT, vscode.ConfigurationTarget.Global);
  }

  const key = await promptForKey(context.secrets);
  if (key === undefined) return;
  refresh();
  await verify(key, log);
}

/** Read the catalogue once, and say what the key can reach. */
async function verify(key: string, log: vscode.LogOutputChannel): Promise<void> {
  const base = endpoint();
  try {
    const models = chatModels(await fetchCatalogue(base, key, AbortSignal.timeout(15_000)));
    log.info(`${base} listed ${models.length} chat models for this key`);
    vscode.window.showInformationMessage(
      models.length === 0
        ? `The key works, and ${base} lists no chat model it may call. Check the key's model scope.`
        : `The key works. ${models.length} model${models.length === 1 ? "" : "s"} available from ${base}.`,
    );
  } catch (error) {
    const sentence =
      error instanceof GatewayError
        ? explain(error.refusal).message
        : `Could not reach Cruise at ${base}: ${error instanceof Error ? error.message : String(error)}`;
    log.error(sentence);
    // Stored anyway. The endpoint may be temporarily unreachable, and throwing
    // the key away over one failed read would make a flaky network look like a
    // bad credential.
    vscode.window.showErrorMessage(sentence);
  }
}
