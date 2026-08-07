/**
 * Packaged-layout resolution for the desktop app root (media/ + resources/).
 * Pure — no Electron process. Mirrors electron-builder's asar/dir layout.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  brandedDesktopProfilePath,
  brandedDesktopProfileStagingPath,
  DESKTOP_PROFILE_DIRNAME,
  desktopProfileLooksOccupied,
  isExtensionRoot,
  legacyDesktopProfilePaths,
  profileTreeFullyCopied,
  resolveDesktopProfileDir,
  resolveExtensionRootFrom,
} from "../src/desktop/paths";

describe("resolveExtensionRootFrom", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-paths-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeMedia(root: string): void {
    fs.mkdirSync(path.join(root, "media"), { recursive: true });
    fs.writeFileSync(path.join(root, "media", "chat.js"), "// stub\n");
  }

  it("isExtensionRoot requires media/chat.js", () => {
    expect(isExtensionRoot(tmp)).toBe(false);
    writeMedia(tmp);
    expect(isExtensionRoot(tmp)).toBe(true);
  });

  it("resolves the compile-tree layout (out/desktop → root)", () => {
    writeMedia(tmp);
    const moduleDir = path.join(tmp, "out", "desktop");
    fs.mkdirSync(moduleDir, { recursive: true });
    expect(resolveExtensionRootFrom(moduleDir)).toBe(path.resolve(tmp));
  });

  it("resolves the packaged asar layout (app.asar/out/desktop → app.asar)", () => {
    // electron-builder: resources/app.asar/{out,media,package.json}
    const asarRoot = path.join(tmp, "resources", "app.asar");
    writeMedia(asarRoot);
    const moduleDir = path.join(asarRoot, "out", "desktop");
    fs.mkdirSync(moduleDir, { recursive: true });
    expect(resolveExtensionRootFrom(moduleDir)).toBe(path.resolve(asarRoot));
  });

  it("falls back to appPath when moduleDir is not under the media root", () => {
    const appPath = path.join(tmp, "app-root");
    writeMedia(appPath);
    const moduleDir = path.join(tmp, "elsewhere", "out", "desktop");
    fs.mkdirSync(moduleDir, { recursive: true });
    expect(
      resolveExtensionRootFrom(moduleDir, { appPath }),
    ).toBe(path.resolve(appPath));
  });

  it("falls back to resourcesPath/app when media is next to asar", () => {
    const resourcesPath = path.join(tmp, "resources");
    const appDir = path.join(resourcesPath, "app");
    writeMedia(appDir);
    const moduleDir = path.join(tmp, "orphan", "desktop");
    fs.mkdirSync(moduleDir, { recursive: true });
    expect(
      resolveExtensionRootFrom(moduleDir, { resourcesPath }),
    ).toBe(path.resolve(appDir));
  });

  it("falls back to resourcesPath when media is an extraResource", () => {
    const resourcesPath = path.join(tmp, "resources");
    writeMedia(resourcesPath);
    const moduleDir = path.join(tmp, "orphan", "desktop");
    fs.mkdirSync(moduleDir, { recursive: true });
    expect(
      resolveExtensionRootFrom(moduleDir, { resourcesPath }),
    ).toBe(path.resolve(resourcesPath));
  });

  it("returns fromOut when nothing matches (caller logs a bad root)", () => {
    const moduleDir = path.join(tmp, "out", "desktop");
    fs.mkdirSync(moduleDir, { recursive: true });
    expect(resolveExtensionRootFrom(moduleDir)).toBe(
      path.resolve(moduleDir, "..", ".."),
    );
  });
});

describe("desktop userData branding + legacy migration", () => {
  let appData: string;

  beforeEach(() => {
    appData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-appdata-"));
  });

  afterEach(() => {
    fs.rmSync(appData, { recursive: true, force: true });
  });

  it("resolves userData under a branded directory (not Electron/)", () => {
    const branded = brandedDesktopProfilePath(appData);
    expect(path.basename(branded)).toBe(DESKTOP_PROFILE_DIRNAME);
    expect(branded).not.toMatch(/Electron/i);
    const { userData, migratedFrom } = resolveDesktopProfileDir({ appData });
    expect(userData).toBe(branded);
    expect(migratedFrom).toBeUndefined();
    expect(fs.existsSync(userData)).toBe(true);
  });

  it("migrates an existing profile from Electron/grok-desktop rather than ignoring it", () => {
    const legacy = legacyDesktopProfilePaths(appData)[0];
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ theme: "dark" }));
    fs.writeFileSync(path.join(legacy, "globalState.json"), "{}");
    expect(desktopProfileLooksOccupied(legacy)).toBe(true);

    const { userData, migratedFrom } = resolveDesktopProfileDir({ appData });
    expect(migratedFrom).toBe(legacy);
    expect(userData).toBe(brandedDesktopProfilePath(appData));
    expect(fs.existsSync(path.join(userData, "config.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(userData, "config.json"), "utf8"))).toEqual({
      theme: "dark",
    });
    // Legacy path should not still hold the only copy.
    expect(desktopProfileLooksOccupied(legacy)).toBe(false);
  });

  it("does not overwrite a branded profile that already has data", () => {
    const branded = brandedDesktopProfilePath(appData);
    const legacy = legacyDesktopProfilePaths(appData)[0];
    fs.mkdirSync(branded, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(branded, "config.json"), JSON.stringify({ keep: true }));
    fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ stale: true }));

    const { userData, migratedFrom } = resolveDesktopProfileDir({ appData });
    expect(userData).toBe(branded);
    expect(migratedFrom).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(userData, "config.json"), "utf8"))).toEqual({
      keep: true,
    });
  });

  it("honours an explicit override without migrating into the branded path", () => {
    const override = path.join(appData, "test-ud");
    const legacy = legacyDesktopProfilePaths(appData)[0];
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "config.json"), "{}");

    const { userData, migratedFrom } = resolveDesktopProfileDir({
      appData,
      override,
    });
    expect(userData).toBe(path.resolve(override));
    expect(migratedFrom).toBeUndefined();
    expect(fs.existsSync(path.join(userData, "config.json"))).toBe(false);
  });

  it("preserves legacy when branded shell has colliding non-marker entries", () => {
    // Branded path exists without profile markers (empty shell / junk) but a
    // name collides with legacy — force:false would skip the legacy file and
    // the old code then deleted the source. Must leave legacy intact.
    const branded = brandedDesktopProfilePath(appData);
    const legacy = legacyDesktopProfilePaths(appData)[0];
    fs.mkdirSync(branded, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(branded, "notes.txt"), "branded junk");
    fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ theme: "dark" }));
    fs.writeFileSync(path.join(legacy, "notes.txt"), "legacy notes — must not be deleted");
    fs.writeFileSync(path.join(legacy, "globalState.json"), "{}");

    const { userData, migratedFrom } = resolveDesktopProfileDir({ appData });
    expect(userData).toBe(branded);
    expect(migratedFrom).toBeUndefined();
    // Legacy still holds the only full profile.
    expect(desktopProfileLooksOccupied(legacy)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(legacy, "config.json"), "utf8"))).toEqual({
      theme: "dark",
    });
    expect(fs.readFileSync(path.join(legacy, "notes.txt"), "utf8")).toBe(
      "legacy notes — must not be deleted",
    );
    // Branded junk was not overwritten.
    expect(fs.readFileSync(path.join(branded, "notes.txt"), "utf8")).toBe("branded junk");
    expect(fs.existsSync(path.join(branded, "config.json"))).toBe(false);
  });

  it("mutation: deleting legacy after a partial force:false copy loses data", () => {
    // Documents the bug the conflict check prevents: skip colliding names,
    // then rmSync(legacy) would destroy the uncopied legacy bytes.
    const branded = brandedDesktopProfilePath(appData);
    const legacy = legacyDesktopProfilePaths(appData)[0];
    fs.mkdirSync(branded, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(branded, "config.json"), "branded-shell-collision");
    // No markers under branded if we only write a colliding non-marker? config.json
    // IS a marker — use a path that looks occupied on legacy only. Simulate the
    // intermediate "copy with force:false" outcome:
    fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ keep: true }));
    fs.writeFileSync(path.join(legacy, "secrets.enc.json"), "enc");
    // Branded has no markers (only unrelated shell file) + collision on secrets:
    fs.unlinkSync(path.join(branded, "config.json"));
    fs.writeFileSync(path.join(branded, "secrets.enc.json"), "partial-shell");

    const { migratedFrom } = resolveDesktopProfileDir({ appData });
    expect(migratedFrom).toBeUndefined();
    expect(fs.existsSync(path.join(legacy, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(legacy, "secrets.enc.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(legacy, "config.json"), "utf8"))).toEqual({
      keep: true,
    });
  });

  it("merges into an empty branded shell when there are no name collisions", () => {
    const branded = brandedDesktopProfilePath(appData);
    const legacy = legacyDesktopProfilePaths(appData)[0];
    fs.mkdirSync(branded, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    // Empty shell: directory exists, no files.
    fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ ok: 1 }));
    fs.writeFileSync(path.join(legacy, "globalState.json"), "{}");

    const { userData, migratedFrom } = resolveDesktopProfileDir({ appData });
    expect(userData).toBe(branded);
    expect(migratedFrom).toBe(legacy);
    expect(JSON.parse(fs.readFileSync(path.join(branded, "config.json"), "utf8"))).toEqual({
      ok: 1,
    });
    expect(desktopProfileLooksOccupied(legacy)).toBe(false);
  });

  it("profileTreeFullyCopied requires nested files, not only top-level names", () => {
    const src = path.join(appData, "src");
    const dst = path.join(appData, "dst");
    fs.mkdirSync(path.join(src, "nested"), { recursive: true });
    fs.mkdirSync(path.join(dst, "nested"), { recursive: true });
    fs.writeFileSync(path.join(src, "config.json"), "{}");
    fs.writeFileSync(path.join(src, "nested", "deep.json"), "x");
    fs.writeFileSync(path.join(dst, "config.json"), "{}");
    // Top-level nested/ exists but deep file missing.
    expect(profileTreeFullyCopied(src, dst)).toBe(false);
    fs.writeFileSync(path.join(dst, "nested", "deep.json"), "x");
    expect(profileTreeFullyCopied(src, dst)).toBe(true);
  });

  it("interrupted mid-copy into branded is never treated as a complete profile", () => {
    // Simulates the old bug: copy writes config.json into branded, then throws
    // before secrets land. Next launch must NOT see branded as occupied and
    // skip migration — credentials would stay split across two trees.
    const branded = brandedDesktopProfilePath(appData);
    const legacy = legacyDesktopProfilePaths(appData)[0];
    const staging = brandedDesktopProfileStagingPath(appData);
    fs.mkdirSync(branded, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ theme: "dark" }));
    fs.writeFileSync(path.join(legacy, "secrets.enc.json"), "enc-blob");
    fs.writeFileSync(path.join(legacy, "globalState.json"), "{}");

    let copies = 0;
    const flakyFs = {
      existsSync: (p: string) => fs.existsSync(p),
      mkdirSync: (p: string, opts?: { recursive?: boolean }) => {
        fs.mkdirSync(p, opts);
      },
      readdirSync: (p: string) => fs.readdirSync(p),
      renameSync: (from: string, to: string) => fs.renameSync(from, to),
      rmSync: (p: string, opts?: { recursive?: boolean; force?: boolean }) => {
        fs.rmSync(p, opts);
      },
      cpSync: (from: string, to: string, opts?: { recursive?: boolean; force?: boolean }) => {
        // Fail after the first top-level marker would have been placed if we
        // copied straight into branded. Staging must absorb the failure instead.
        copies += 1;
        if (copies >= 2 && path.basename(to) === "secrets.enc.json") {
          throw new Error("simulated crash mid-copy");
        }
        fs.cpSync(from, to, opts);
      },
    };

    const first = resolveDesktopProfileDir({ appData, fs: flakyFs });
    // Migration failed — branded must not look complete, legacy intact.
    expect(first.migratedFrom).toBeUndefined();
    expect(desktopProfileLooksOccupied(legacy)).toBe(true);
    // Staging wiped on failure; branded has no markers from a direct partial copy.
    expect(desktopProfileLooksOccupied(branded)).toBe(false);
    expect(fs.existsSync(path.join(branded, "config.json"))).toBe(false);
    expect(fs.existsSync(staging)).toBe(false);

    // Second launch with healthy fs completes the migration from intact legacy.
    const second = resolveDesktopProfileDir({ appData });
    expect(second.migratedFrom).toBe(legacy);
    expect(desktopProfileLooksOccupied(second.userData)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(second.userData, "config.json"), "utf8"))).toEqual({
      theme: "dark",
    });
    expect(fs.readFileSync(path.join(second.userData, "secrets.enc.json"), "utf8")).toBe("enc-blob");
  });

  it("mutation: copying markers straight into branded strands a half profile", () => {
    // Documents why promote is atomic: if config.json lands in branded mid-
    // failure, desktopProfileLooksOccupied becomes true and migration is skipped.
    const branded = brandedDesktopProfilePath(appData);
    const legacy = legacyDesktopProfilePaths(appData)[0];
    fs.mkdirSync(branded, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ full: true }));
    fs.writeFileSync(path.join(legacy, "secrets.enc.json"), "secret");
    // Half-copy outcome of the old path:
    fs.writeFileSync(path.join(branded, "config.json"), JSON.stringify({ partial: true }));
    expect(desktopProfileLooksOccupied(branded)).toBe(true);

    const { userData, migratedFrom } = resolveDesktopProfileDir({ appData });
    expect(userData).toBe(branded);
    expect(migratedFrom).toBeUndefined();
    // Secrets never arrived; user looks logged out.
    expect(fs.existsSync(path.join(branded, "secrets.enc.json"))).toBe(false);
    expect(desktopProfileLooksOccupied(legacy)).toBe(true);
  });

  it("clears a leftover staging directory before migrating", () => {
    const branded = brandedDesktopProfilePath(appData);
    const legacy = legacyDesktopProfilePaths(appData)[0];
    const staging = brandedDesktopProfileStagingPath(appData);
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ ok: true }));
    fs.writeFileSync(path.join(legacy, "globalState.json"), "{}");
    // Crash husk: partial marker under staging only.
    fs.writeFileSync(path.join(staging, "config.json"), "stale");

    const { userData, migratedFrom } = resolveDesktopProfileDir({ appData });
    expect(migratedFrom).toBe(legacy);
    expect(userData).toBe(branded);
    expect(JSON.parse(fs.readFileSync(path.join(branded, "config.json"), "utf8"))).toEqual({
      ok: true,
    });
    expect(fs.existsSync(staging)).toBe(false);
  });
});
