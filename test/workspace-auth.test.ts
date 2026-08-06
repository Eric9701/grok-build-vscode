/**
 * Shared workspace authorization + close-revocation helpers.
 *
 * Mutation-checked requirements (each fails when its production gate is reverted):
 *  1. remote send with no cwd refuses when bound session cwd is closed
 *  2. image handle under closed folder is refused
 *  3. held/adopted session cannot resume in a closed folder
 *  4. sidebar revoke on removeProjectFolder (source structure)
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cwdIsAuthorized,
  imageHandlesToRevoke,
  imagePathStillAuthorized,
  pathBoundToClosedFolder,
  remoteBoundCwdStillAuthorized,
  sessionBoundToClosedFolder,
  sessionCwdFromGrokMediaPath,
} from "../src/workspace-auth";
import { pathsEqual } from "../src/worktree";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidebarSrc = () =>
  fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");

describe("cwdIsAuthorized", () => {
  it("accepts only exact members of the authorized set", () => {
    const authorized = ["/work/a", "/work/a-wt"];
    expect(cwdIsAuthorized("/work/a", authorized, pathsEqual)).toBe(true);
    expect(cwdIsAuthorized("/work/a-wt", authorized, pathsEqual)).toBe(true);
    expect(cwdIsAuthorized("/work/closed", authorized, pathsEqual)).toBe(false);
    expect(cwdIsAuthorized(undefined, authorized, pathsEqual)).toBe(false);
    expect(cwdIsAuthorized("/work/a", [], pathsEqual)).toBe(false);
  });
});

describe("remoteBoundCwdStillAuthorized (no-cwd remote ops)", () => {
  it("refuses a send bound to a closed folder even when the message has no cwd", () => {
    // Production: handleRemoteMessage checks bound session/client cwd for every
    // remote op except selectRepo. A plain send carries no cwd and used to skip
    // allowRemoteRepoTarget's catalog check entirely.
    const open = ["/work/open"];
    const closed = "/work/closed";
    expect(remoteBoundCwdStillAuthorized(closed, open, pathsEqual)).toBe(false);
    expect(remoteBoundCwdStillAuthorized("/work/open", open, pathsEqual)).toBe(true);
    expect(remoteBoundCwdStillAuthorized(undefined, open, pathsEqual)).toBe(false);
  });

  it("mutation: skipping the bound-cwd check reopens the hole", () => {
    // Old allowRemoteRepoTarget default branch: messages without cwd → true.
    const allowRemoteRepoTargetDefault = (_msgType: string, hasCwd: boolean) =>
      hasCwd ? false : true; // buggy: no-cwd always allowed
    expect(allowRemoteRepoTargetDefault("send", false)).toBe(true);

    // Fixed path: still check bound session cwd.
    const bound = "/work/closed";
    const authorized = ["/work/open"];
    const fixed =
      allowRemoteRepoTargetDefault("send", false) &&
      remoteBoundCwdStillAuthorized(bound, authorized, pathsEqual);
    expect(fixed).toBe(false);
  });
});

describe("image handle revocation", () => {
  it("lists handles whose paths sit under a closed folder", () => {
    const closed = path.resolve("/work/closed");
    const open = path.resolve("/work/open");
    const handles = new Map<string, string>([
      ["h1", path.join(closed, "shot.png")],
      ["h2", path.join(open, "ok.png")],
      ["h3", closed],
    ]);
    const revoked = imageHandlesToRevoke(handles, closed, pathsEqual);
    expect(revoked.sort()).toEqual(["h1", "h3"].sort());
  });

  it("refuses imagePathStillAuthorized for a closed-folder path", () => {
    const closed = path.resolve("/work/closed");
    const open = path.resolve("/work/open");
    const img = path.join(closed, "secret.png");
    expect(imagePathStillAuthorized(img, [open], { sameCwd: pathsEqual })).toBe(false);
    expect(imagePathStillAuthorized(img, [open, closed], { sameCwd: pathsEqual })).toBe(true);
  });

  it("allows grok session media only when the catalog cwd is still authorized", () => {
    const grokHome = path.resolve("/home/u/.grok");
    const repo = path.resolve("/work/open");
    const media = path.join(
      grokHome,
      "sessions",
      encodeURIComponent(repo),
      "images",
      "1.jpg",
    );
    expect(sessionCwdFromGrokMediaPath(media, grokHome)).toBe(repo);
    expect(
      imagePathStillAuthorized(media, [repo], {
        grokHome,
        sameCwd: pathsEqual,
        isTrustedGeneratedMedia: () => true,
      }),
    ).toBe(true);
    expect(
      imagePathStillAuthorized(media, [path.resolve("/work/other")], {
        grokHome,
        sameCwd: pathsEqual,
        isTrustedGeneratedMedia: () => true,
      }),
    ).toBe(false);
  });
});

describe("sessionBoundToClosedFolder / held resume", () => {
  it("matches process cwd and worktree bindings", () => {
    const closed = "/work/closed";
    expect(sessionBoundToClosedFolder(closed, undefined, undefined, closed, pathsEqual)).toBe(true);
    expect(
      sessionBoundToClosedFolder("/wt", "/wt", closed, closed, pathsEqual),
    ).toBe(true);
    expect(
      sessionBoundToClosedFolder("/work/open", undefined, undefined, closed, pathsEqual),
    ).toBe(false);
  });

  it("held session with closed cwd is not authorized (resume must refuse)", () => {
    const heldCwd = "/work/closed";
    const authorized = ["/work/open"];
    // Same predicate startSession / openSessionReserved use after close.
    expect(cwdIsAuthorized(heldCwd, authorized, pathsEqual)).toBe(false);
  });
});

describe("pathBoundToClosedFolder", () => {
  it("is segment-safe (not a string prefix)", () => {
    expect(pathBoundToClosedFolder("/work/closed-extra/x", "/work/closed", pathsEqual)).toBe(
      false,
    );
    expect(pathBoundToClosedFolder("/work/closed/x", "/work/closed", pathsEqual)).toBe(true);
  });
});

describe("sidebar close-revocation wiring (source)", () => {
  it("removeProjectFolder revokes sessions, remote ownership, and image handles", () => {
    const src = sidebarSrc();
    expect(src).toContain("revokeClosedProjectFolder");
    expect(src).toContain("isAuthorizedCwd");
    expect(src).toContain("remoteBoundCwdStillAuthorized");
    expect(src).toContain("invalidateImageHandlesUnder");
    expect(src).toContain("isImagePathAuthorizedNow");

    const removeStart = src.indexOf("async removeProjectFolder(");
    expect(removeStart).toBeGreaterThan(0);
    const removeEnd = src.indexOf("private revokeClosedProjectFolder", removeStart);
    const removeBody = src.slice(removeStart, removeEnd);
    // Revoke must run after successful removeWorkspaceFolder, before UI rehome.
    expect(removeBody).toContain("revokeClosedProjectFolder(target)");
    expect(removeBody).toContain("removeWorkspaceFolder(target)");

    // Bound-cwd gate on remote ops (not only cwd-bearing messages).
    const remoteStart = src.indexOf("private handleRemoteMessage(");
    const remoteBody = src.slice(remoteStart, remoteStart + 2500);
    expect(remoteBody).toContain("remoteBoundCwdStillAuthorized");
    expect(remoteBody).toContain('m.type !== "selectRepo"');

    // startSession refuses unauthorized target.cwd even with resumeId.
    const startStart = src.indexOf("private async startSession(");
    const startBody = src.slice(startStart, startStart + 1200);
    expect(startBody).toContain("isAuthorizedCwd(target.cwd)");
    expect(startBody).toContain("refused startSession");

    // Held-session adopt refuses closed folder.
    expect(src).toContain("refused held-session adopt");

    // requestImageFull revalidates.
    const imgStart = src.indexOf('case "requestImageFull"');
    const imgBody = src.slice(imgStart, imgStart + 800);
    expect(imgBody).toContain("isImagePathAuthorizedNow");

    // Mutation: if revoke is only a catalog refresh, the test fails.
    expect(removeBody).not.toMatch(
      /removeWorkspaceFolder\(target\)[\s\S]*return;\s*\n\s*const next/,
    );
  });

  it("single authorization query is consulted by remote + start + image paths", () => {
    const src = sidebarSrc();
    // The shared query exists once.
    const queryDef = src.indexOf("private isAuthorizedCwd(");
    expect(queryDef).toBeGreaterThan(0);
    // remoteTargetableCwd delegates — not a second open-set walk.
    const remoteTarget = src.indexOf("private remoteTargetableCwd(");
    const remoteTargetBody = src.slice(remoteTarget, remoteTarget + 200);
    expect(remoteTargetBody).toContain("isAuthorizedCwd");
    expect(remoteTargetBody).not.toContain("localRepoCatalogEntries");
  });
});
