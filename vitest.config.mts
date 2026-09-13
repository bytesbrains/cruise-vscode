import path from "node:path";
import { defineConfig } from "vitest/config";

// The extension host provides `vscode` at runtime and nothing else does, so the
// modules that import it cannot load under Node without a stand-in. The stub
// carries only what the extension calls; tests assert what we send and throw,
// not what the editor UI shows.
export default defineConfig({
  resolve: {
    alias: { vscode: path.join(import.meta.dirname, "test/vscode.stub.ts") },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
