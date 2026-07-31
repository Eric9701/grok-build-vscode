import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sidebar = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
const updateStart = sidebar.indexOf("  private async maybeUpdateCliOnUpgrade(");
const updateEnd = sidebar.indexOf("  /**", updateStart + 5);
const update = sidebar.slice(updateStart, updateEnd);
const compatibilityStart = sidebar.indexOf("  private async planModeCompatibility(");
const compatibilityEnd = sidebar.indexOf("  /**", compatibilityStart + 5);
const compatibility = sidebar.slice(compatibilityStart, compatibilityEnd);
const pinStart = sidebar.indexOf("  private async maybePinBrokenCli(");
const pinEnd = sidebar.indexOf("  /**", pinStart + 5);
const pin = sidebar.slice(pinStart, pinEnd);
const setModeStart = sidebar.indexOf("  async setMode(");
const setModeEnd = sidebar.indexOf("  /** Resolve a plan-review card", setModeStart);
const setMode = sidebar.slice(setModeStart, setModeEnd);
const sessionStart = sidebar.slice(
  sidebar.indexOf("  private async startSession("),
  sidebar.indexOf("    // Worktree sessions pin cwd", sidebar.indexOf("  private async startSession(")),
);
const fullSessionStart = sidebar.slice(
  sidebar.indexOf("  private async startSession("),
  sidebar.indexOf("  private remoteSessionFor(", sidebar.indexOf("  private async startSession(")),
);

describe("CLI startup compatibility", () => {
  it("has no startup freshness cache or background update check", () => {
    for (const removed of [
      "cliUpdateAvailable",
      "cliUpdateCheckedAt",
      "refreshCliUpdateAvailability",
      "grokFreshnessAction",
      "GROK_UPDATE_CHECK_COOLDOWN_MS",
    ]) {
      expect(sidebar).not.toContain(removed);
    }
  });

  it("keeps the original once-per-extension-upgrade update trigger", () => {
    expect(update).toContain("if (this.cliUpdateChecked) return");
    expect(update).toContain("extensionWasUpgraded(lastSeen, current)");
    expect(update).toContain("execGrokCli(cliPath, args");
    expect(update).toContain("this.context.globalState.update(CLI_UPDATE_VERSION_KEY, current)");
    expect(sessionStart).toContain("await this.maybeUpdateCliOnUpgrade(cliPath)");
  });

  it("keeps version gating separate from all update orchestration", () => {
    expect(compatibility).toContain("await this.readGrokVersion(cliPath)");
    expect(compatibility).toContain("isGrokVersionBelowRequired(versionOutput)");
    expect(compatibility).not.toContain("runGrokUpdate");
    expect(compatibility).not.toContain("execGrokCli");
    expect(compatibility).not.toContain("this.pool");
  });

  it("proactively pins only the bounded Windows hang range before compatibility and spawn", () => {
    expect(pin).toContain("if (this.brokenCliPinned) return");
    expect(pin).toContain("isStdioBrokenGrokVersion(versionOutput, process.platform)");
    expect(pin).toContain('this.downgradeBrokenCli(cliPath, detected, "proactive")');
    expect(sidebar).toContain('reason: "proactive" | "reactive"');

    const update = sessionStart.indexOf("await this.maybeUpdateCliOnUpgrade(cliPath)");
    const proactivePin = sessionStart.indexOf("await this.maybePinBrokenCli(cliPath)", update);
    const compatibilityCheck = sessionStart.indexOf("await this.planModeCompatibility(cliPath)", proactivePin);
    expect(proactivePin).toBeGreaterThan(update);
    expect(compatibilityCheck).toBeGreaterThan(proactivePin);
  });

  it("disables only Plan for a parseable CLI below the floor", () => {
    expect(compatibility).toMatch(/isGrokVersionBelowRequired[\s\S]+planModeAvailable: false/);
    expect(compatibility).toContain("installed version is ${installed}");
    expect(sessionStart).toContain("session.planModeAvailable = compatibility.planModeAvailable");
    expect(sessionStart).toContain('type: "planModeAvailability"');
    expect(setMode).toContain('modeId === "plan" && !session.planModeAvailable');
    expect(setMode).toContain("session.planModeUnavailableReason");
    expect(setMode).toContain("!session.planModeAvailable && session.planActive");
    expect(setMode).toContain("this.recoverUnavailablePlanMode(session, session.client, session.gen)");
  });

  it("fails closed for Plan when the installed version cannot be verified", () => {
    const unknown = compatibility.slice(
      compatibility.indexOf("if (!installed)"),
      compatibility.indexOf("if (isGrokVersionBelowRequired"),
    );
    expect(unknown).toContain("Continuing best-effort with the current binary");
    expect(unknown).toContain("planModeAvailable: false");
    expect(unknown).toContain("the installed version could not be verified");
  });

  it("re-enables Plan for a later session that meets the floor", () => {
    expect(compatibility).toContain("return { planModeAvailable: true }");
    expect(sessionStart).toContain("compatibility.planModeUnavailableReason");
  });

  it("awaits the replaced process before the upgrade trigger can replace the binary", () => {
    const capture = fullSessionStart.indexOf("const replacedClient = session.client");
    const clear = fullSessionStart.indexOf("session.client = undefined", capture);
    const dispose = fullSessionStart.indexOf("await replacedClient.dispose()", clear);
    const update = fullSessionStart.indexOf("await this.maybeUpdateCliOnUpgrade(cliPath)", dispose);

    expect(capture).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(capture);
    expect(dispose).toBeGreaterThan(clear);
    expect(update).toBeGreaterThan(dispose);
  });

  it("disposes the detached client before any lookup can take an early return", () => {
    const capture = fullSessionStart.indexOf("const replacedClient = session.client");
    const clear = fullSessionStart.indexOf("session.client = undefined", capture);
    const dispose = fullSessionStart.indexOf("await replacedClient.dispose()", clear);
    const lookup = fullSessionStart.indexOf("const cliPath = locateGrokCli", dispose);
    expect(dispose).toBeGreaterThan(clear);
    expect(lookup).toBeGreaterThan(dispose);
    expect(fullSessionStart.slice(clear, dispose)).not.toMatch(/\breturn(?:\s+undefined)?;/);
  });
});
