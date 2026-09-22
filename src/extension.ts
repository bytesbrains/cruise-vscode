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
import { DEMO_ENDPOINT, endpoint, forgetKey, promptForKey, setEndpoint, storedKey } from "./credentials.ts";
import { ENDPOINT_COMMAND, MANAGE_COMMAND, showCredentialProblem } from "./dialog.ts";
import { fetchCatalogue, GatewayError } from "./gateway.ts";
import { endpointKind, endpointProblem, PRODUCTION_ENDPOINT } from "./pairing.ts";
import { CruiseChatProvider } from "./provider.ts";
import { explain } from "./refusal.ts";

const VENDOR = "cruise";
const ENDPOINT_SETTING = "cruise.endpoint";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("BytesBrains Cruise", { log: true });
  context.subscriptions.push(log);

  const provider = new CruiseChatProvider(context.secrets, log);
  context.subscriptions.push(provider);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));

  context.subscriptions.push(
    vscode.commands.registerCommand(MANAGE_COMMAND, () => manage(context, log, () => provider.refresh())),
    vscode.commands.registerCommand(ENDPOINT_COMMAND, () => changeEndpoint(context, log)),
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
      { label: "Change endpoint", detail: `Now ${endpoint()} — production, the demo, or a proxy / custom URL`, id: "endpoint" },
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

  if (choice.id === "endpoint") {
    await changeEndpoint(context, log);
    return;
  }

  if (choice.id === "demo") {
    // Global rather than workspace: a demo endpoint is a property of the
    // person trying the extension, not of the folder they happen to have open.
    await setEndpoint(DEMO_ENDPOINT);
  }

  const key = await promptForKey(context.secrets);
  if (key === undefined) return;
  refresh();
  await verify(key, log);
}

/**
 * Where the stored key is sent — production, the demo, or a URL of the user's
 * own: a proxy, a self-hosted gateway. Picking a deployment by name is the way
 * back from the demo that #16 found missing; before this the only one was
 * finding `cruise.endpoint` in `settings.json`.
 *
 * The new endpoint is checked with the stored key straight away, for the same
 * reason signing in is: a wrong URL otherwise surfaces inside a chat request.
 */
async function changeEndpoint(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): Promise<void> {
  const current = endpoint();
  const kind = endpointKind(current);
  const mark = (candidate: string) => (kind === candidate ? "current" : "");

  const choice = await vscode.window.showQuickPick(
    [
      { label: "Production", description: mark("production") || "default", detail: PRODUCTION_ENDPOINT, id: "production" },
      { label: "Demo", description: mark("demo"), detail: `${DEMO_ENDPOINT} — takes a cru_demo_ key`, id: "demo" },
      {
        label: "Custom URL…",
        description: mark("custom"),
        detail: kind === "custom" ? current : "A proxy or self-hosted Cruise gateway that speaks the OpenAI API",
        id: "custom",
      },
    ],
    { title: `BytesBrains Cruise — endpoint is ${current}`, placeHolder: "Where should requests go?" },
  );
  if (choice === undefined) return;

  if (choice.id === "production") {
    await setEndpoint(undefined);
  } else if (choice.id === "demo") {
    await setEndpoint(DEMO_ENDPOINT);
  } else {
    const entered = await vscode.window.showInputBox({
      title: "BytesBrains Cruise — custom endpoint",
      prompt: "The base URL requests go to, e.g. https://proxy.example.com/v1. The stored key is sent to it as a bearer token.",
      value: kind === "custom" ? current : "https://",
      ignoreFocusOut: true,
      validateInput: endpointProblem,
    });
    if (entered === undefined) return;
    // Checked again rather than trusted to the input box's validation, which
    // a caller driving this command programmatically does not go through.
    const problem = endpointProblem(entered);
    if (problem !== undefined) {
      vscode.window.showErrorMessage(problem);
      return;
    }
    await setEndpoint(entered.trim());
  }

  const key = await storedKey(context.secrets);
  if (key === undefined) {
    vscode.window.showInformationMessage(`Endpoint set to ${endpoint()}. Run **Cruise: Manage API key** to sign in.`);
    return;
  }
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
    // Stored anyway. The endpoint may be temporarily unreachable, and throwing
    // the key away over one failed read would make a flaky network look like a
    // bad credential.
    if (error instanceof GatewayError && explain(error.refusal).credentials) {
      // Switching makes the pairing match, so the recheck cannot offer the
      // same switch again — this recurses at most once.
      if ((await showCredentialProblem(error.refusal, key, base, log)) === "switched") await verify(key, log);
      return;
    }
    const sentence =
      error instanceof GatewayError
        ? explain(error.refusal).message
        : `Could not reach Cruise at ${base}: ${error instanceof Error ? error.message : String(error)}`;
    log.error(sentence);
    vscode.window.showErrorMessage(sentence);
  }
}
