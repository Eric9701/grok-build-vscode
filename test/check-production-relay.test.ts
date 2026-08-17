/**
 * Package-time relay guard — a staging REMOTE_RELAY_URL must not produce a
 * vsix unless install.ps1 set the awkward escape hatch.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOW_STAGING_RELAY_VSIX_ENV,
  ALLOW_STAGING_RELAY_VSIX_VALUE,
  evaluateRelayPackageGuard,
  formatRelayPackageFailure,
  parseRelayConsts,
} from "../scripts/check-production-relay.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(remoteLine: string, production = "wss://afkpilot.com"): string {
  return [
    `export const PRODUCTION_RELAY_URL = "${production}";`,
    remoteLine,
    "",
  ].join("\n");
}

describe("parseRelayConsts", () => {
  it("resolves the identifier assignment to PRODUCTION_RELAY_URL", () => {
    expect(parseRelayConsts(fixture("export const REMOTE_RELAY_URL = PRODUCTION_RELAY_URL;"))).toEqual({
      production: "wss://afkpilot.com",
      remote: "wss://afkpilot.com",
      remoteForm: "ident",
    });
  });

  it("reads a string-literal REMOTE_RELAY_URL", () => {
    expect(
      parseRelayConsts(fixture('export const REMOTE_RELAY_URL = "wss://staging.example";')),
    ).toEqual({
      production: "wss://afkpilot.com",
      remote: "wss://staging.example",
      remoteForm: "literal",
    });
  });

  it("parses CRLF source, which is how this tree is checked out on Windows", () => {
    const src = [
      'export const PRODUCTION_RELAY_URL = "wss://afkpilot.com";',
      "export const REMOTE_RELAY_URL = PRODUCTION_RELAY_URL;",
      "",
    ].join("\r\n");
    expect(parseRelayConsts(src)).toMatchObject({
      production: "wss://afkpilot.com",
      remote: "wss://afkpilot.com",
      remoteForm: "ident",
    });
  });

  it("reports a missing assignment", () => {
    expect(parseRelayConsts('export const PRODUCTION_RELAY_URL = "wss://afkpilot.com";\n')).toEqual({
      production: "wss://afkpilot.com",
      remote: null,
      remoteForm: "missing",
    });
  });
});

describe("evaluateRelayPackageGuard", () => {
  const productionSrc = fixture("export const REMOTE_RELAY_URL = PRODUCTION_RELAY_URL;");
  const stagingSrc = fixture('export const REMOTE_RELAY_URL = "wss://staging.example";');

  it("accepts the committed identifier form", () => {
    expect(evaluateRelayPackageGuard(productionSrc, {})).toEqual({
      ok: true,
      expected: "wss://afkpilot.com",
      found: "wss://afkpilot.com",
    });
  });

  it("accepts a literal that still equals PRODUCTION_RELAY_URL", () => {
    const src = fixture('export const REMOTE_RELAY_URL = "wss://afkpilot.com";');
    expect(evaluateRelayPackageGuard(src, {}).ok).toBe(true);
  });

  it("refuses a staging URL with no hatch", () => {
    const result = evaluateRelayPackageGuard(stagingSrc, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("wss://staging.example");
    expect(result.message).toContain("wss://afkpilot.com");
    expect(result.message).toContain("export const REMOTE_RELAY_URL = PRODUCTION_RELAY_URL;");
    expect(result.message).not.toContain(ALLOW_STAGING_RELAY_VSIX_VALUE);
  });

  it("refuses true/1 and any other leftover value", () => {
    for (const value of ["1", "true", "yes", "I_AM_SURE"]) {
      const result = evaluateRelayPackageGuard(stagingSrc, {
        [ALLOW_STAGING_RELAY_VSIX_ENV]: value,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.message).toContain("is set but its value is not accepted");
      expect(result.message).not.toContain(ALLOW_STAGING_RELAY_VSIX_VALUE);
    }
  });

  it("allows staging only with the exact required phrase", () => {
    const result = evaluateRelayPackageGuard(stagingSrc, {
      [ALLOW_STAGING_RELAY_VSIX_ENV]: ALLOW_STAGING_RELAY_VSIX_VALUE,
    });
    expect(result).toMatchObject({
      ok: true,
      found: "wss://staging.example",
      expected: "wss://afkpilot.com",
    });
    if (!result.ok) return;
    expect(result.warning).toMatch(/must not be released/);
  });

  it("fails closed when PRODUCTION_RELAY_URL is missing", () => {
    const result = evaluateRelayPackageGuard("export const REMOTE_RELAY_URL = PRODUCTION_RELAY_URL;\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/PRODUCTION_RELAY_URL/);
  });

  it("names found, expected, and the restore line", () => {
    const text = formatRelayPackageFailure({
      found: "wss://staging.example",
      expected: "wss://afkpilot.com",
    });
    expect(text).toMatch(/REMOTE_RELAY_URL is "wss:\/\/staging\.example"/);
    expect(text).toMatch(/expected "wss:\/\/afkpilot\.com"/);
    expect(text).toMatch(/export const REMOTE_RELAY_URL = PRODUCTION_RELAY_URL;/);
  });
});

describe("wiring — the guard is what actually runs", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = fs.readFileSync(path.join(root, "scripts", "check-production-relay.mjs"), "utf8");
  const install = fs.readFileSync(path.join(root, "scripts", "install.ps1"), "utf8");
  const releasePs1 = fs.readFileSync(path.join(root, "scripts", "release.ps1"), "utf8");
  const releaseSh = fs.readFileSync(path.join(root, "scripts", "release.sh"), "utf8");
  const frames = fs.readFileSync(path.join(root, "src", "remote-frames.ts"), "utf8");

  it("accepts the real src/remote-frames.ts", () => {
    expect(evaluateRelayPackageGuard(frames, {}).ok).toBe(true);
    expect(parseRelayConsts(frames)).toMatchObject({
      remoteForm: "ident",
      production: "wss://afkpilot.com",
      remote: "wss://afkpilot.com",
    });
  });

  it("does not hardcode the production hostname in the check or install script", () => {
    // The hostname lives in PRODUCTION_RELAY_URL. A second copy here would
    // keep packaging after a rebrand of the constant.
    expect(script).not.toMatch(/afkpilot\.com/);
    expect(install).not.toMatch(/afkpilot\.com/);
  });

  it("prepackage runs the relay check before the require check", () => {
    expect(pkg.scripts["check:relay"]).toBe("node scripts/check-production-relay.mjs");
    const pre = pkg.scripts.prepackage;
    expect(pre.indexOf("check:relay")).toBeGreaterThan(-1);
    expect(pre.indexOf("check:vsix")).toBeGreaterThan(pre.indexOf("check:relay"));
  });

  it("install.ps1 sets the same hatch the check script accepts", () => {
    expect(install).toContain(ALLOW_STAGING_RELAY_VSIX_ENV);
    expect(install).toContain(ALLOW_STAGING_RELAY_VSIX_VALUE);
    expect(install).toContain("export const REMOTE_RELAY_URL = PRODUCTION_RELAY_URL;");
  });

  it("install.ps1 refuses a leftover vsix when npm never actually built", () => {
    expect(install).toMatch(/Get-Command npm/);
    expect(install).toContain("refusing to install a leftover build");
  });

  it("release scripts drop the hatch before packaging", () => {
    expect(releasePs1).toMatch(/Remove-Item Env:GROK_ALLOW_STAGING_RELAY_VSIX/);
    expect(releaseSh).toMatch(/unset GROK_ALLOW_STAGING_RELAY_VSIX/);
  });
});
