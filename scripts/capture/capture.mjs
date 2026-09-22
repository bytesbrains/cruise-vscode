/**
 * Regenerate the README's pictures: `npm run capture`.
 *
 * Every frame is taken from a real editor running the real extension — the
 * scenes below drive it with the keyboard at a fixed pace, against the mock
 * gateway in `mock-gateway.mjs`, in the pinned editor from `editor.mjs`. No
 * key, account or network is involved, and the output only changes when the
 * extension or the pinned editor does. See CONTRIBUTING.md.
 *
 * Writes `media/readme/`:
 *   walkthrough.gif      Manage API key → Try the demo → the lanes in Copilot Chat's picker
 *   change-endpoint.png  the endpoint menu: Production, Demo, Custom URL…
 *   custom-endpoint.png  a proxy URL entered
 *   rejected-key.png     a live key sent to the demo, explained
 *   pairing.png          which key goes where (from `diagram.html`)
 *
 * `npm run capture -- walkthrough` (or any of the names above, without the
 * extension) runs just that one.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { launch, ROOT, WINDOW } from "./editor.mjs";
import { startMockGateway } from "./mock-gateway.mjs";

const OUT = path.join(ROOT, "media/readme");

/**
 * Keys shaped like Cruise's prefixes and nothing more: far short of the real
 * length, so no gateway would accept them and the gitleaks rule does not
 * match them. The input box is a password field, so they show only as dots.
 */
const DEMO_KEY = "cru_demo_readme_capture";
const LIVE_KEY = "cru_live_readme_capture";

/** The pace of everything a viewer watches happen, in milliseconds. */
const PACE = { key: 55, settle: 700, read: 1_600, linger: 3_000 };

/**
 * The editor, with the few moves every scene makes. `frames` collects what
 * the GIF is assembled from: each screenshot and how long it stays up.
 */
async function stage() {
  const gateway = await startMockGateway();
  const editor = await launch({ gateway: gateway.base });
  const { window } = editor;
  const frames = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cruise-frames-"));

  const frame = async (ms) => {
    const file = path.join(dir, `${String(frames.length).padStart(4, "0")}.png`);
    // CSS scale for the GIF: 1280×800 regardless of the display it ran on.
    await window.screenshot({ path: file, scale: "css" });
    frames.push({ file, ms });
  };

  const still = async (name, clip) => {
    await window.screenshot({ path: path.join(OUT, `${name}.png`), scale: "device", ...(clip ? { clip } : {}) });
    console.log(`  ${name}.png`);
  };

  /** Type as a person would, a frame per character when recording. */
  const type = async (text, { record = true } = {}) => {
    for (const char of text) {
      await window.keyboard.type(char);
      if (record) await frame(PACE.key);
      else await window.waitForTimeout(PACE.key / 2);
    }
  };

  const press = async (key, settle = PACE.settle) => {
    await window.keyboard.press(key);
    await window.waitForTimeout(settle);
  };

  /** Run a command from the palette. Recorded, so the viewer sees where it came from. */
  const palette = async (command, { record = true } = {}) => {
    await press("Meta+Shift+P", 500);
    if (record) await frame(PACE.settle);
    await type(command, { record });
    if (record) await frame(PACE.read);
    await press("Enter", 1_000);
  };

  /** Toasts sit bottom-right, over the chat input. Cleared once they have been read. */
  const clearNotifications = () => palette("Notifications: Clear All Notifications", { record: false });

  return {
    window,
    gateway,
    frame,
    still,
    type,
    press,
    palette,
    clearNotifications,
    async gif(name) {
      await assembleGif(frames, path.join(OUT, `${name}.gif`));
      console.log(`  ${name}.gif (${(fs.statSync(path.join(OUT, `${name}.gif`)).size / 1024 / 1024).toFixed(2)} MB)`);
    },
    async close() {
      await editor.close();
      await gateway.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Frames to a GIF with one palette for the whole clip, and only the changed
 * rectangle re-encoded per frame — most of an editor is still between
 * keystrokes, which is what keeps this under 2 MB.
 */
async function assembleGif(frames, out) {
  const list = path.join(path.dirname(frames[0].file), "frames.txt");
  // Quoted as the concat demuxer reads it: a `'` in the temp directory's path
  // would otherwise end the name early.
  const quote = (file) => `'${file.replaceAll("'", "'\\''")}'`;
  const lines = frames.flatMap(({ file, ms }) => [`file ${quote(file)}`, `duration ${(ms / 1000).toFixed(3)}`]);
  // The concat demuxer drops the last frame's duration unless it is listed again.
  lines.push(`file ${quote(frames.at(-1).file)}`);
  fs.writeFileSync(list, lines.join("\n"));
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", list,
    "-vf", `scale=${WINDOW.width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    "-fps_mode", "vfr",
    "-loop", "0",
    out,
  ]);
}

/** Palette → Manage API key → Try the demo → a demo key → the lanes in the chat picker. */
async function walkthrough() {
  const s = await stage();
  try {
    // An empty Explorer is width the chat panel can use.
    await s.palette("View: Close Primary Side Bar", { record: false });
    // …and the chat panel takes it, so the selected lane's name is not cut to "bb/agenti…".
    await s.palette("Chat: Focus on Chat View", { record: false });
    for (let i = 0; i < 4; i++) await s.palette("View: Increase Current View Size", { record: false });
    await s.frame(PACE.read);
    await s.palette("Cruise: Manage API key");
    await s.frame(PACE.read);
    await s.type("demo");
    await s.frame(PACE.read);
    await s.press("Enter");
    await s.frame(PACE.settle);
    await s.type(DEMO_KEY);
    await s.frame(PACE.settle);
    await s.press("Enter", 1_500);
    // "The key works. 7 models available from https://cruise-demo…"
    await s.frame(PACE.linger);
    await s.clearNotifications();

    // The chat panel is already open on the right, and the editor selects a
    // Cruise lane on its own once the list arrives.
    await s.window.locator('[aria-label^="Models"]').first().click();
    await s.window.waitForTimeout(PACE.settle);
    await s.frame(PACE.read);
    await s.window.getByText("Other Models", { exact: true }).click();
    // Off the list, or a row's hover card covers the picker.
    await s.window.mouse.move(300, 200);
    await s.window.waitForTimeout(PACE.settle);
    await s.frame(PACE.linger * 1.5);
    await s.gif("walkthrough");
  } finally {
    await s.close();
  }
}

/** The endpoint menu, and a proxy URL typed into Custom URL…. */
async function changeEndpoint() {
  const s = await stage();
  try {
    await s.palette("Cruise: Change endpoint", { record: false });
    await s.window.waitForTimeout(PACE.settle);
    await s.still("change-endpoint", await around(s.window, ".quick-input-widget", 0));
    await s.type("Custom", { record: false });
    await s.press("Enter");
    await s.window.keyboard.press("Meta+A");
    await s.type("https://proxy.example.com/v1", { record: false });
    await s.window.waitForTimeout(PACE.settle);
    await s.still("custom-endpoint", await around(s.window, ".quick-input-widget", 0));
  } finally {
    await s.close();
  }
}

/**
 * A live key, then the endpoint moved to the demo: the demo's key table has
 * never heard of it, the mock answers 401 as the demo would, and the
 * extension explains it. The same sequence #16 was.
 */
async function rejectedKey() {
  const s = await stage();
  try {
    await s.palette("Cruise: Manage API key", { record: false });
    await s.type("Sign in", { record: false });
    await s.press("Enter");
    await s.type(LIVE_KEY, { record: false });
    await s.press("Enter", 1_500);
    await s.clearNotifications();
    await s.palette("Cruise: Change endpoint", { record: false });
    await s.type("Demo", { record: false });
    await s.press("Enter", 1_500);
    await s.window.locator(".monaco-dialog-box").waitFor({ timeout: 10_000 });
    await s.window.mouse.move(10, 400);
    await s.window.waitForTimeout(PACE.settle);
    await s.still("rejected-key", await around(s.window, ".monaco-dialog-box"));
  } finally {
    await s.close();
  }
}

/** The element's box with a margin, so a still shows the widget and not the window's edges. */
async function around(window, selector, by = 24) {
  const box = await window.locator(selector).filter({ visible: true }).first().boundingBox();
  return { x: Math.max(0, box.x - by), y: Math.max(0, box.y - by), width: box.width + by * 2, height: box.height + by * 2 };
}

/** `diagram.html` rendered at 2× — drawn, not captured, so it is just a page. */
async function pairing() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1200, height: 600 } });
    await page.goto(`file://${path.join(ROOT, "scripts/capture/diagram.html")}`);
    await page.locator("#diagram").screenshot({ path: path.join(OUT, "pairing.png") });
    console.log("  pairing.png");
  } finally {
    await browser.close();
  }
}

const SCENES = { walkthrough, "change-endpoint": changeEndpoint, "rejected-key": rejectedKey, pairing };

const wanted = process.argv.slice(2);
for (const name of wanted) {
  if (!(name in SCENES)) throw new Error(`No scene "${name}". Scenes: ${Object.keys(SCENES).join(", ")}`);
}
fs.mkdirSync(OUT, { recursive: true });
for (const [name, scene] of Object.entries(SCENES)) {
  if (wanted.length > 0 && !wanted.includes(name)) continue;
  console.log(name);
  await scene();
}
