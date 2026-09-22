/**
 * A pinned VS Code, a throwaway profile, and a build of the extension that
 * cannot reach the network — the stage every capture runs on.
 *
 * **The capture build.** `src/` is bundled exactly as `npm run build` does,
 * with one addition in front: `fetch` is wrapped so the two Cruise hosts (and
 * the README's example proxy) go to the local mock gateway, and any other URL
 * is refused outright. The extension's own code, and every URL it *shows*, is
 * unchanged — the dialogs still say `https://cruise-demo.bytesbrains.net/v1`
 * — but no request leaves 127.0.0.1, so a capture needs no key and no account.
 * The published bundle in `dist/` is never touched.
 *
 * **The editor.** Downloaded once into `.vscode-test/` at the version pinned
 * below, launched with a fresh user-data and extensions directory, so a
 * maintainer's own settings, theme and extensions never show up in a
 * picture. Dialogs are the in-window kind (`window.dialogStyle: custom`) so
 * a modal is part of the page and lands in a screenshot.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { _electron as electron } from "playwright-core";

/** Pinned so a regenerated GIF differs only when the extension does. Bump deliberately. */
export const VSCODE_VERSION = "1.138.0";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The size every frame is taken at, in CSS pixels. Small on purpose: the
 * README shows the GIF at about 800px wide, and a bigger window only makes
 * the text in it smaller.
 */
export const WINDOW = { width: 1024, height: 640 };

const REDIRECTS = [
  ["https://cruise.bytesbrains.net/v1", "production"],
  ["https://cruise-demo.bytesbrains.net/v1", "demo"],
  ["https://proxy.example.com/v1", "proxy"],
];

/** Bundle the extension into `dir` with `fetch` pointed at the mock. */
async function buildCaptureExtension(dir, gateway) {
  const banner = `(() => {
  const real = globalThis.fetch;
  const routes = ${JSON.stringify(REDIRECTS)};
  globalThis.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [from, to] of routes) {
      if (url.startsWith(from)) return real(${JSON.stringify(gateway)} + "/" + to + "/v1" + url.slice(from.length), init);
    }
    return Promise.reject(new TypeError("capture build: refusing to reach " + url));
  };
})();`;
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  fs.copyFileSync(path.join(ROOT, "media/icon.png"), path.join(dir, "media/icon.png"));
  await build({
    entryPoints: [path.join(ROOT, "src/extension.ts")],
    bundle: true,
    outfile: path.join(dir, "dist/extension.js"),
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    target: "node22",
    banner: { js: banner },
    logLevel: "warning",
  });
}

const SETTINGS = {
  "window.dialogStyle": "custom",
  "window.titleBarStyle": "custom",
  "window.commandCenter": true,
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.enableExperiments": false,
  "workbench.layoutControl.enabled": false,
  "workbench.activityBar.location": "hidden",
  "workbench.statusBar.visible": false,
  "editor.fontSize": 14,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "extensions.ignoreRecommendations": true,
  "security.workspace.trust.enabled": false,
  "git.enabled": false,
  "chat.commandCenter.enabled": false,
  "chat.agent.enabled": false,
  "notifications.position": "bottom-right",
  // Chat sends without a GitHub sign-in, and everything the editor itself
  // would fetch goes to a closed port instead of the internet.
  "chat.allowAnonymousAccess": true,
  "http.proxy": "http://127.0.0.1:9",
  "http.proxySupport": "override",
  "http.noProxy": ["127.0.0.1", "localhost"],
};

/**
 * Launch the editor with the capture build loaded. `scale` is the device
 * pixel ratio: 2 gives the stills retina detail, and GIF frames are taken
 * at CSS size from the same window.
 */
export async function launch({ gateway, scale = 2, settings = {} }) {
  const executablePath = await downloadAndUnzipVSCode({ version: VSCODE_VERSION, cachePath: path.join(ROOT, ".vscode-test") });

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "cruise-capture-"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  // Installed, not loaded as a development extension: a development host
  // titles every window "[Extension Development Host]", which no user sees.
  const extension = path.join(stage, "extensions", `${pkg.publisher}.${pkg.name}-${pkg.version}`);
  const user = path.join(stage, "user");
  // The folder the window opens: its name is the only thing of it the
  // pictures show, so it is named for a reader.
  const workspace = path.join(stage, "my-project");
  fs.mkdirSync(path.join(user, "User"), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(user, "User", "settings.json"), JSON.stringify({ ...SETTINGS, ...settings }, null, 2));
  await buildCaptureExtension(extension, gateway);

  const app = await electron.launch({
    executablePath,
    args: [
      `--user-data-dir=${user}`,
      `--extensions-dir=${path.join(stage, "extensions")}`,
      `--force-device-scale-factor=${scale}`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-updates",
      "--new-window",
      "--proxy-server=127.0.0.1:9",
      "--proxy-bypass-list=127.0.0.1;localhost",
      workspace,
    ],
    env: { ...process.env, VSCODE_SKIP_PRELAUNCH: "1" },
  });
  const window = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, size) => {
    const [win] = BrowserWindow.getAllWindows();
    win.setContentSize(size.width, size.height);
    win.center();
  }, WINDOW);
  await window.waitForSelector(".monaco-workbench", { timeout: 90_000 });
  // The workbench paints before its extensions and views settle.
  await window.waitForTimeout(3_000);

  return {
    app,
    window,
    async close() {
      await app.close();
      fs.rmSync(stage, { recursive: true, force: true });
    },
  };
}
