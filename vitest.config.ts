import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Electron e2e lives under test/desktop and needs a real BrowserWindow —
    // run via `npm run test:desktop` only (not npm test / CI unit job).
    exclude: ["**/node_modules/**", "**/dist/**", "test/desktop/**"],
    environment: "node",
    // Vitest's 5s default is a hang detector for pure functions; several files
    // here spawn a real shell or a real Node ACP process, and the suite runs one
    // worker per core (20 on the dev box) so those starts contend. That made
    // `npm test` fail 3-4 tests per run with a different set each time, all
    // passing on re-run, while `--no-file-parallelism` was fully green.
    // Raising the ceiling costs nothing when tests pass and still fails a true
    // hang quickly. Deliberately NOT solved with retries: a retry would also
    // hide a genuine 1-in-5 race, which is exactly the class of bug this
    // codebase keeps finding.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
