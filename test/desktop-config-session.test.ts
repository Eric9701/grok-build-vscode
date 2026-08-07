/**
 * `--config-json` / `GROK_DESKTOP_CONFIG_JSON` overrides apply to ONE RUN.
 *
 * They used to be merged into the user's real config file and left there. The
 * failure that produced this test: a throwaway `grok.cliPath` pointing at a
 * stub agent was passed once for a screenshot, and the app then started that
 * stub on every later launch — the chat showed a "Fake" model with nothing on
 * screen explaining why, and the flag was long gone from the command line.
 *
 * A persisted override is invisible by construction, so it needs a test that
 * fails when the persistence comes back.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigStore } from "../src/desktop/config-store";

describe("session config overrides (--config-json)", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cfg-"));
    file = path.join(dir, "config.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("takes effect for this run", () => {
    const store = new ConfigStore(file);
    store.applySessionOverrides({ "grok.cliPath": "/tmp/stub-grok" });
    expect(store.getConfiguration("grok").get("cliPath")).toBe("/tmp/stub-grok");
  });

  it("does NOT survive a restart — the whole point", () => {
    const store = new ConfigStore(file);
    store.applySessionOverrides({ "grok.cliPath": "/tmp/stub-grok" });
    expect(store.getConfiguration("grok").get("cliPath")).toBe("/tmp/stub-grok");

    // A fresh process reading the same file must see the user's real value.
    const restarted = new ConfigStore(file);
    expect(restarted.getConfiguration("grok").get("cliPath", "")).toBe("");
  });

  it("never writes the override to disk, even as a file that exists", () => {
    const store = new ConfigStore(file);
    store.applySessionOverrides({ "grok.cliPath": "/tmp/stub-grok", "grok.showThinking": true });
    const onDisk = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    expect(onDisk).not.toContain("stub-grok");
  });

  it("does not clobber a real value the user had already saved", async () => {
    const store = new ConfigStore(file);
    await store.getConfiguration("grok").update("cliPath", "/usr/local/bin/grok");

    const overridden = new ConfigStore(file);
    overridden.applySessionOverrides({ "grok.cliPath": "/tmp/stub-grok" });
    // Masked while the flag is in force...
    expect(overridden.getConfiguration("grok").get("cliPath")).toBe("/tmp/stub-grok");
    // ...and intact underneath it.
    expect(new ConfigStore(file).getConfiguration("grok").get("cliPath")).toBe(
      "/usr/local/bin/grok",
    );
  });

  it("an explicit change in the app beats the override", async () => {
    const store = new ConfigStore(file);
    store.applySessionOverrides({ "grok.cliPath": "/tmp/stub-grok" });
    await store.getConfiguration("grok").update("cliPath", "/usr/local/bin/grok");
    // Otherwise the setting would appear to save and keep reading back the
    // flag's value — the same invisible cause, one layer up.
    expect(store.getConfiguration("grok").get("cliPath")).toBe("/usr/local/bin/grok");
    expect(new ConfigStore(file).getConfiguration("grok").get("cliPath")).toBe(
      "/usr/local/bin/grok",
    );
  });

  it("applyOverrides still persists — it is the deliberate path", async () => {
    const store = new ConfigStore(file);
    store.applyOverrides({ "grok.showThinking": true });
    expect(new ConfigStore(file).getConfiguration("grok").get("showThinking")).toBe(true);
  });
});
