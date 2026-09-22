/**
 * The dialog a rejected key gets, when the user is there to read it.
 *
 * A toast has room for one sentence, and "Incorrect API key" is the one
 * sentence that sends the user to paste the same key again (#16). A modal has
 * a detail pane, so it shows every fact the diagnosis rests on — endpoint,
 * the key's kind, the gateway's answer, the likely cause — and puts the fix
 * on a button.
 *
 * Shown only from something the user just did (signing in, changing the
 * endpoint, opening the picker). A background enumeration logs instead, and a
 * chat request carries the diagnosis in its thrown message: a modal over the
 * chat panel for every retry would be worse than the bug.
 */

import * as vscode from "vscode";
import { setEndpoint } from "./credentials.ts";
import { DEMO_ENDPOINT, diagnose } from "./pairing.ts";
import type { Refusal } from "./refusal.ts";

export const MANAGE_COMMAND = "cruise.manageKey";
export const ENDPOINT_COMMAND = "cruise.changeEndpoint";

/**
 * Show the refusal, act on the button pressed, and report whether the
 * endpoint was switched — the caller re-checks the key when it was.
 */
export async function showCredentialProblem(
  refusal: Refusal,
  key: string,
  base: string,
  log: vscode.LogOutputChannel,
): Promise<"switched" | "none"> {
  const diagnosis = diagnose(refusal, key, base);
  log.error(diagnosis.detail.replace(/\n+/g, " | "));

  const switchLabel =
    diagnosis.switchTo === "production" ? "Use production endpoint" : diagnosis.switchTo === "demo" ? "Use demo endpoint" : undefined;
  const actions = [...(switchLabel === undefined ? [] : [switchLabel]), "Change endpoint…", "Replace key…", "Show log"];

  const picked = await vscode.window.showErrorMessage(
    `Cruise rejected the key (HTTP ${refusal.status})`,
    { modal: true, detail: diagnosis.detail },
    ...actions,
  );

  if (picked !== undefined && picked === switchLabel) {
    await setEndpoint(diagnosis.switchTo === "production" ? undefined : DEMO_ENDPOINT);
    return "switched";
  }
  if (picked === "Change endpoint…") await vscode.commands.executeCommand(ENDPOINT_COMMAND);
  else if (picked === "Replace key…") await vscode.commands.executeCommand(MANAGE_COMMAND);
  else if (picked === "Show log") log.show();
  return "none";
}
