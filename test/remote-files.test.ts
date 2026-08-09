/**
 * Fence tests for remote read-only project file access.
 *
 * Composes repoScopeFor (which root) + resolveTreePath / listTreeDir /
 * readTreeFile (paths inside). A phone must not reach outside the tab's
 * selected repo, and must not follow outbound symlinks.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HOST_CAPABILITIES,
  type HostUiCapabilities,
} from "../src/protocol";
import {
  allowRemoteRepoTarget,
  INBOUND_DISPOSITION,
  OUTBOUND_DISPOSITION,
  OUTBOUND_PROJECT_AUTH,
  repoScopeFor,
} from "../src/remote-policy";
import {
  listRemoteProjectDir,
  projectFileContentForWire,
  readRemoteProjectFile,
  resolveRemoteFileRoot,
} from "../src/remote-files";
import { resolveTreePath } from "../src/file-tree";

const tmpDirs: string[] = [];

function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "grok-rfiles-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

const sameCwd = (a: string, b: string) =>
  path.resolve(a).replace(/\\/g, "/").toLowerCase() ===
  path.resolve(b).replace(/\\/g, "/").toLowerCase();

describe("resolveRemoteFileRoot (fence)", () => {
  const WS = "/work/workspace";
  const PICKED = "/work/picked";
  const OTHER = "/work/other";
  const known = new Set([PICKED, OTHER, WS]);
  const isKnown = (cwd: string) => known.has(cwd);

  it("uses repoScopeFor: remote root is the tab's selected cwd", () => {
    expect(repoScopeFor("remote", { selectedCwd: PICKED, workspaceRoot: WS })).toBe(PICKED);
    const r = resolveRemoteFileRoot({
      origin: "remote",
      claimedCwd: PICKED,
      selectedCwd: PICKED,
      workspaceRoot: WS,
      isKnownCwd: isKnown,
      sameCwd,
    });
    expect(r).toEqual({ ok: true, root: PICKED });
  });

  it("refuses an unknown cwd from a remote (allowRemoteRepoTarget trap)", () => {
    // Protocol gate
    expect(
      allowRemoteRepoTarget(
        { type: "listProjectDir", cwd: "/etc", relPath: "" },
        isKnown,
      ),
    ).toBe(false);
    expect(
      allowRemoteRepoTarget(
        { type: "readProjectFile", cwd: "/etc", relPath: "passwd" },
        isKnown,
      ),
    ).toBe(false);
    // Pure root resolver (defense in depth if a caller skipped the policy gate)
    const r = resolveRemoteFileRoot({
      origin: "remote",
      claimedCwd: "/etc",
      selectedCwd: PICKED,
      workspaceRoot: WS,
      isKnownCwd: isKnown,
      sameCwd,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not discovered/i);
  });

  it("refuses a known cwd that is not this tab's selected repository", () => {
    expect(
      allowRemoteRepoTarget(
        { type: "listProjectDir", cwd: OTHER },
        isKnown,
      ),
    ).toBe(true); // catalog-known → policy lets it through
    const r = resolveRemoteFileRoot({
      origin: "remote",
      claimedCwd: OTHER,
      selectedCwd: PICKED,
      workspaceRoot: WS,
      isKnownCwd: isKnown,
      sameCwd,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/selected repository/i);
  });

  it("local origin scopes to workspaceRoot, not selectedCwd", () => {
    const r = resolveRemoteFileRoot({
      origin: "local",
      claimedCwd: WS,
      selectedCwd: PICKED,
      workspaceRoot: WS,
      isKnownCwd: (cwd) => sameCwd(cwd, WS),
      sameCwd,
    });
    expect(r).toEqual({ ok: true, root: WS });
  });
});

describe("path containment (escape + symlink)", () => {
  it("refuses a path escaping the root", () => {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, "ok.txt"), "inside");
    expect(resolveTreePath(root, "..").ok).toBe(false);
    expect(resolveTreePath(root, "../outside").ok).toBe(false);
    expect(resolveTreePath(root, "a/../../outside").ok).toBe(false);
    const listed = listRemoteProjectDir(root, "..");
    expect(listed.ok).toBe(false);
    const read = readRemoteProjectFile(root, "../outside");
    expect(read.ok).toBe(false);
  });

  it("refuses a symlink pointing outside the root", () => {
    const root = mkTmp();
    const outside = mkTmp();
    fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
    const link = path.join(root, "escape-link");
    try {
      fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      // Windows without symlink privilege — skip rather than false-fail CI.
      if (process.platform === "win32") {
        return;
      }
      throw e;
    }
    expect(resolveTreePath(root, "escape-link").ok).toBe(false);
    expect(resolveTreePath(root, "escape-link/secret.txt").ok).toBe(false);
    const listed = listRemoteProjectDir(root, "");
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.entries.some((e) => e.name === "escape-link")).toBe(false);
    }
    const read = readRemoteProjectFile(root, "escape-link/secret.txt");
    expect(read.ok).toBe(false);
  });

  it("reads a contained text file and strips absPath for the wire", () => {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, "readme.md"), "# Hello\n");
    const read = readRemoteProjectFile(root, "readme.md");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.kind).toBe("markdown");
    expect(read.text).toContain("Hello");
    expect(read.absPath).toBeTruthy();
    const wire = projectFileContentForWire(read);
    expect(wire.ok).toBe(true);
    if (!wire.ok) return;
    expect(wire.relPath).toBe("readme.md");
    expect(wire.kind).toBe("markdown");
    expect((wire as { absPath?: string }).absPath).toBeUndefined();
  });

  it("refuses binary-looking files for remote preview", () => {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 4]));
    const read = readRemoteProjectFile(root, "blob.bin");
    expect(read.ok).toBe(false);
    const wire = projectFileContentForWire(read);
    expect(wire.ok).toBe(false);
  });
});

describe("capability advertisement", () => {
  it("current hosts advertise browseProjectFiles", () => {
    expect(HOST_CAPABILITIES.browseProjectFiles).toBe(true);
  });

  it("unsupported host advertises nothing (field absent is the gate)", () => {
    // Older hosts never sent the field — client treats absence as false.
    const oldCaps: HostUiCapabilities = {
      uploadFile: true,
      remoteVoice: true,
    };
    expect(oldCaps.browseProjectFiles).toBeUndefined();
    expect(!!oldCaps.browseProjectFiles).toBe(false);
  });

  it("classifies new messages in remote policy exhaustively", () => {
    expect(INBOUND_DISPOSITION.listProjectDir).toBe("view");
    expect(INBOUND_DISPOSITION.readProjectFile).toBe("view");
    expect(OUTBOUND_DISPOSITION.projectDirListing).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.projectFileContent).toBe("mirror");
    expect(OUTBOUND_PROJECT_AUTH.projectDirListing).toBe("message-cwd");
    expect(OUTBOUND_PROJECT_AUTH.projectFileContent).toBe("message-cwd");
  });
});
