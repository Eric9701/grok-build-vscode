import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Electron e2e lives under test/desktop and needs a real BrowserWindow —
    // run via `npm run test:desktop` only (not npm test / CI unit job).
    exclude: ["**/node_modules/**", "**/dist/**", "test/desktop/**"],
    environment: "node",
  },
});
