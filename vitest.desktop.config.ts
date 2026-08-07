import { defineConfig } from "vitest/config";

/**
 * Electron desktop e2e — real BrowserWindow + Playwright `_electron`.
 * Kept out of `npm test` / CI unit job (downloads Electron, needs a display).
 * Run: `npm run test:desktop`
 */
export default defineConfig({
  test: {
    include: ["test/desktop/**/*.test.ts"],
    environment: "node",
    testTimeout: 90_000,
    hookTimeout: 90_000,
    // One Electron app at a time — avoid parallel window fights on Windows.
    fileParallelism: false,
    poolOptions: {
      threads: { singleThread: true },
    },
  },
});
