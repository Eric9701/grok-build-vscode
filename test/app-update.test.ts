/**
 * Desktop update-notice pure helpers + remote policy classification.
 * No network — the main process fetch is silence-on-failure and is not
 * exercised here.
 */
import { describe, expect, it } from "vitest";
import {
  compareSemver,
  isDesktopInstallerAsset,
  isNewerVersion,
  noticeIfUpdateAvailable,
  parseSemver,
  pickLatestDesktopRelease,
  type GithubReleaseLike,
  desktopUpdatePageUrl,
} from "../src/desktop/app-update";
import {
  INBOUND_DISPOSITION,
  OUTBOUND_DISPOSITION,
} from "../src/remote-policy";

describe("parseSemver / compareSemver", () => {
  it("parses plain and v-prefixed versions", () => {
    expect(parseSemver("3.2.0")).toEqual({ major: 3, minor: 2, patch: 0 });
    expect(parseSemver("v3.10.1")).toEqual({ major: 3, minor: 10, patch: 1 });
    expect(parseSemver("3.9.0-beta.1")).toEqual({ major: 3, minor: 9, patch: 0 });
  });

  it("returns null for unparseable input", () => {
    expect(parseSemver("")).toBeNull();
    expect(parseSemver(null)).toBeNull();
    expect(parseSemver(undefined)).toBeNull();
    expect(parseSemver("latest")).toBeNull();
    expect(parseSemver("abc")).toBeNull();
    expect(parseSemver("3")).toBeNull();
  });

  it("compares numerically so 3.10.0 > 3.9.0 (string compare would reverse)", () => {
    const a = parseSemver("3.10.0")!;
    const b = parseSemver("3.9.0")!;
    expect(compareSemver(a, b)).toBeGreaterThan(0);
    expect(compareSemver(b, a)).toBeLessThan(0);
    // String compare would claim the opposite:
    expect("3.10.0" < "3.9.0").toBe(true);
    expect(isNewerVersion("3.10.0", "3.9.0")).toBe(true);
    expect(isNewerVersion("3.9.0", "3.10.0")).toBe(false);
    expect(isNewerVersion("3.9.0", "3.9.0")).toBe(false);
  });

  it("ignores unparseable candidates and currents", () => {
    expect(isNewerVersion("nope", "3.2.0")).toBe(false);
    expect(isNewerVersion("3.2.0", "nope")).toBe(false);
    expect(isNewerVersion(null, "3.2.0")).toBe(false);
  });
});

describe("isDesktopInstallerAsset", () => {
  it("matches anchored installer suffixes", () => {
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-3.2.0-mac-arm64.dmg")).toBe(true);
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-3.2.0-mac-x64.dmg")).toBe(true);
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-3.2.0-win-x64.exe")).toBe(true);
  });

  it("excludes .blockmap and other companions", () => {
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-3.2.0-win-x64.exe.blockmap")).toBe(false);
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-3.2.0-mac-arm64.dmg.blockmap")).toBe(false);
    expect(isDesktopInstallerAsset("grok-vscode-phuryn-3.2.0.vsix")).toBe(false);
    expect(isDesktopInstallerAsset("Source code (zip)")).toBe(false);
    expect(isDesktopInstallerAsset("")).toBe(false);
  });
});

describe("pickLatestDesktopRelease / noticeIfUpdateAvailable", () => {
  const releases: GithubReleaseLike[] = [
    {
      tag_name: "v3.1.0",
      html_url: "https://github.com/phuryn/grok-build-vscode/releases/tag/v3.1.0",
      assets: [{ name: "Grok-Build-Desktop-3.1.0-win-x64.exe" }],
    },
    {
      tag_name: "v3.2.0",
      html_url: "https://github.com/phuryn/grok-build-vscode/releases/tag/v3.2.0",
      assets: [
        { name: "Grok-Build-Desktop-3.2.0-win-x64.exe" },
        { name: "Grok-Build-Desktop-3.2.0-win-x64.exe.blockmap" },
      ],
    },
    {
      // Extension-only release: no desktop installers → skip.
      tag_name: "v3.3.0",
      html_url: "https://github.com/phuryn/grok-build-vscode/releases/tag/v3.3.0",
      assets: [{ name: "grok-vscode-phuryn-3.3.0.vsix" }],
    },
    {
      tag_name: "not-a-version",
      assets: [{ name: "Grok-Build-Desktop-x-win-x64.exe" }],
    },
    {
      tag_name: "v9.9.9",
      draft: true,
      assets: [{ name: "Grok-Build-Desktop-9.9.9-win-x64.exe" }],
    },
    {
      // Not a pre-release any more: this app SHIPS pre-release, so excluding
      // them would have meant never notifying the users it exists for. The
      // fixture keeps a non-installer release instead, which is the real reason
      // a release gets skipped.
      tag_name: "v9.8.8",
      assets: [{ name: "grok-vscode-phuryn-9.8.8.vsix" }],
    },
  ];

  it("picks the newest release that actually carries desktop installers", () => {
    const latest = pickLatestDesktopRelease(releases);
    expect(latest).toEqual({
      version: "3.2.0",
      url: "https://github.com/phuryn/grok-build-vscode/releases/tag/v3.2.0",
    });
  });

  it("notifies only when the release is newer than the running app", () => {
    expect(noticeIfUpdateAvailable("3.1.0", releases)).toEqual({
      version: "3.2.0",
      url: "https://github.com/phuryn/grok-build-vscode/releases/tag/v3.2.0",
    });
    expect(noticeIfUpdateAvailable("3.2.0", releases)).toBeNull();
    expect(noticeIfUpdateAvailable("3.10.0", releases)).toBeNull();
  });

  it("produces no notice on empty / null / failed-shaped input", () => {
    expect(noticeIfUpdateAvailable("3.0.0", null)).toBeNull();
    expect(noticeIfUpdateAvailable("3.0.0", undefined)).toBeNull();
    expect(noticeIfUpdateAvailable("3.0.0", [])).toBeNull();
    expect(noticeIfUpdateAvailable("3.0.0", [{ tag_name: "v1.0.0", assets: [] }])).toBeNull();
  });
});

describe("updateAvailable remote policy (host-local both ways)", () => {
  it("keeps updateAvailable outbound host-local so remotes never see the button", () => {
    expect(OUTBOUND_DISPOSITION.updateAvailable).toBe("host-local");
  });

  it("keeps openUpdateRelease inbound host-local so a phone cannot open desk updates", () => {
    expect(INBOUND_DISPOSITION.openUpdateRelease).toBe("host-local");
  });
});

describe("pre-releases count", () => {
  // The desktop app ships pre-release while it is unsigned. A stable-only check
  // is the usual default and was exactly wrong here: it would never fire for
  // anyone on the first builds — the very users the notice exists to reach.
  const asset = { name: "Grok-Build-Desktop-3.3.0-win-x64.exe", browser_download_url: "https://x/y" };

  it("notifies about a newer pre-release", () => {
    const notice = pickLatestDesktopRelease([
      { tag_name: "v3.3.0", draft: false, prerelease: true, assets: [asset] },
    ]);
    expect(notice).not.toBeNull();
    expect(notice!.version).toContain("3.3.0");
  });

  it("still ignores drafts, whose assets 404 for anonymous downloads", () => {
    expect(
      pickLatestDesktopRelease([
        { tag_name: "v3.3.0", draft: true, prerelease: true, assets: [asset] },
      ]),
    ).toBeNull();
  });
});

describe("where the update button sends people", () => {
  it("goes to our own update page, never the GitHub release page", () => {
    // The release page is a developer artifact — .dmg, .zip, .exe, .blockmap and
    // a .vsix with nothing saying which is yours.
    const url = desktopUpdatePageUrl("3.2.4");
    expect(url.startsWith("https://afkpilot.com/desktop-update")).toBe(true);
    expect(url).not.toContain("github.com");
  });

  it("carries the running version and nothing else", () => {
    // This URL is compiled into every installed copy and can never be changed
    // for builds already out there, so it stays generic: the app says where it
    // is, the page decides what to show. Anything more specific baked in here
    // would be a decision we could not take back.
    expect(desktopUpdatePageUrl("3.2.4")).toBe("https://afkpilot.com/desktop-update?from=3.2.4");
    expect(desktopUpdatePageUrl("")).toBe("https://afkpilot.com/desktop-update");
    expect(desktopUpdatePageUrl(null)).toBe("https://afkpilot.com/desktop-update");
    expect(desktopUpdatePageUrl("3.2.4 &x=1")).toContain("from=3.2.4%20%26x%3D1");
  });
});
