/**
 * Fence tests for remote project file access (browse + edit existing files).
 *
 * Composes repoScopeFor (which root) + resolveTreePath / listTreeDir /
 * readTreeFile / writeTreeFile (paths inside). A phone must not reach outside
 * the tab's selected repo, must not follow outbound symlinks, and must not
 * silently overwrite a stale stamp or a cross-project path.
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
  writeRemoteProjectFile,
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
    // Protocol gate — list, read, AND write (write is a mutation; without the
    // case the default branch returns true).
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
    expect(
      allowRemoteRepoTarget(
        {
          type: "writeProjectFile",
          cwd: "/etc",
          relPath: "passwd",
          text: "x",
          stamp: { mtimeMs: 1, size: 1 },
          expectedAbsPath: "/etc/passwd",
        },
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

  it("reads a contained text file and strips absPath for the wire without edit meta", () => {
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
    expect((wire as { stamp?: unknown }).stamp).toBeUndefined();
  });

  it("includes stamp + absPath on the wire only when edit meta is requested", () => {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, "notes.txt"), "hi\n");
    const read = readRemoteProjectFile(root, "notes.txt");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const wire = projectFileContentForWire(read, { includeEditMeta: true });
    expect(wire.ok).toBe(true);
    if (!wire.ok) return;
    expect(wire.stamp).toEqual(read.stamp);
    expect(wire.absPath).toBe(read.absPath);
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

describe("writeRemoteProjectFile (existing files only)", () => {
  const noExec = () => false;

  it("refuses a stale stamp", () => {
    const root = mkTmp();
    const abs = path.join(root, "notes.txt");
    fs.writeFileSync(abs, "original\n");
    const read = readRemoteProjectFile(root, "notes.txt");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // Mutate under the client so its stamp is stale.
    fs.writeFileSync(abs, "changed on disk\n");
    const result = writeRemoteProjectFile(root, "notes.txt", "my edits\n", read.stamp!, {
      expectedAbsPath: read.absPath,
      isExecutableOpenTarget: noExec,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("changed");
    // Original disk content after the under-me write must not be clobbered.
    expect(fs.readFileSync(abs, "utf8")).toBe("changed on disk\n");
  });

  it("refuses a correct stamp with the WRONG expectedAbsPath (cross-project case)", () => {
    // Tab was read in repo A; save resolves under repo B with the same relPath.
    // Stamp may even match by coincidence — the absPath binding is the fence.
    const repoA = mkTmp();
    const repoB = mkTmp();
    fs.writeFileSync(path.join(repoA, "README.md"), "A content\n");
    fs.writeFileSync(path.join(repoB, "README.md"), "B content\n");
    const readA = readRemoteProjectFile(repoA, "README.md");
    expect(readA.ok).toBe(true);
    if (!readA.ok) return;
    const result = writeRemoteProjectFile(
      repoB,
      "README.md",
      "A's text into B\n",
      readA.stamp!,
      {
        expectedAbsPath: readA.absPath, // still points at A
        isExecutableOpenTarget: noExec,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("workspace changed");
    expect(fs.readFileSync(path.join(repoB, "README.md"), "utf8")).toBe("B content\n");
  });

  it("refuses a path escaping the root", () => {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, "ok.txt"), "inside\n");
    const read = readRemoteProjectFile(root, "ok.txt");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const result = writeRemoteProjectFile(root, "../escape.txt", "nope\n", read.stamp!, {
      expectedAbsPath: read.absPath,
      isExecutableOpenTarget: noExec,
    });
    expect(result.ok).toBe(false);
  });

  it("writes when stamp and expectedAbsPath both match", () => {
    const root = mkTmp();
    const abs = path.join(root, "notes.txt");
    fs.writeFileSync(abs, "original\n");
    const read = readRemoteProjectFile(root, "notes.txt");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const result = writeRemoteProjectFile(root, "notes.txt", "saved\n", read.stamp!, {
      expectedAbsPath: read.absPath,
      isExecutableOpenTarget: noExec,
    });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(abs, "utf8")).toBe("saved\n");
    if (result.ok) {
      expect(result.stamp.mtimeMs).toBeTypeOf("number");
      expect(result.stamp.size).toBeTypeOf("number");
    }
  });
});

describe("capability advertisement", () => {
  it("current hosts advertise browseProjectFiles and editProjectFiles", () => {
    expect(HOST_CAPABILITIES.browseProjectFiles).toBe(true);
    expect(HOST_CAPABILITIES.editProjectFiles).toBe(true);
  });

  it("unsupported host advertises nothing (field absent is the gate)", () => {
    // Older hosts never sent the field — client treats absence as false.
    const oldCaps: HostUiCapabilities = {
      uploadFile: true,
      remoteVoice: true,
    };
    expect(oldCaps.browseProjectFiles).toBeUndefined();
    expect(!!oldCaps.browseProjectFiles).toBe(false);
    expect(oldCaps.editProjectFiles).toBeUndefined();
    expect(!!oldCaps.editProjectFiles).toBe(false);
  });

  it("browse without edit is a valid host: client must not offer a write path", () => {
    // Field-presence convention: a host can advertise browse alone.
    const browseOnly: HostUiCapabilities = {
      uploadFile: true,
      remoteVoice: true,
      browseProjectFiles: true,
      // editProjectFiles deliberately absent
    };
    expect(!!browseOnly.browseProjectFiles).toBe(true);
    expect(!!browseOnly.editProjectFiles).toBe(false);
    // Client gate in chat.js is remoteFilesEditAvailable() — both flags.
    // Structural: chat only posts writeProjectFile when edit is advertised.
    const chatSrc = fs.readFileSync(
      path.join(__dirname, "..", "media", "chat.js"),
      "utf8",
    );
    expect(chatSrc).toContain("editProjectFiles");
    expect(chatSrc).toContain("remoteFilesEditAvailable");
    // The shared adapter only receives a write method when the separate edit
    // capability is present. With browse-only access the component therefore
    // cannot construct a write request at all.
    const sharedStart = chatSrc.indexOf("function ensureSharedRemoteFilePanel");
    const sharedEnd = chatSrc.indexOf("function remoteFilesButtonHost", sharedStart);
    expect(sharedStart).toBeGreaterThan(0);
    expect(sharedEnd).toBeGreaterThan(sharedStart);
    const sharedAdapter = chatSrc.slice(sharedStart, sharedEnd);
    expect(sharedAdapter).toContain("if (remoteFilesEditAvailable())");
    expect(sharedAdapter).toContain('type: "writeProjectFile"');
  });

  it("classifies list/read as view and write as propose (mutation tier)", () => {
    expect(INBOUND_DISPOSITION.listProjectDir).toBe("view");
    expect(INBOUND_DISPOSITION.readProjectFile).toBe("view");
    // Mutation must not sit at the read (view) tier.
    expect(INBOUND_DISPOSITION.writeProjectFile).toBe("propose");
    expect(OUTBOUND_DISPOSITION.projectDirListing).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.projectFileContent).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.projectFileWriteResult).toBe("mirror");
    expect(OUTBOUND_PROJECT_AUTH.projectDirListing).toBe("message-cwd");
    expect(OUTBOUND_PROJECT_AUTH.projectFileContent).toBe("message-cwd");
    expect(OUTBOUND_PROJECT_AUTH.projectFileWriteResult).toBe("message-cwd");
  });
});

// The read path withholds the stamp and absolute path for an image, so the
// client paints no Edit control — but that is a UI affordance and the client is
// untrusted. The host must refuse a crafted write on its own.
describe("remote writes are text-only, enforced host-side", () => {
  it("refuses a non-text file even with a valid stamp and path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-rfiles-"));
    const rel = "logo.png";
    const abs = path.join(root, rel);
    fs.writeFileSync(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const st = fs.statSync(abs);

    const result = writeRemoteProjectFile(root, rel, "not a png any more", {
      mtimeMs: st.mtimeMs,
      size: st.size,
    }, {
      expectedAbsPath: abs,
      isExecutableOpenTarget: () => false,
    });

    expect(result.ok).toBe(false);
    // ...and the bytes on disk are untouched.
    expect(fs.readFileSync(abs)[0]).toBe(0x89);
  });

  it("still allows the text kinds", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-rfiles-"));
    for (const rel of ["notes.md", "data.json", "plain.txt"]) {
      const abs = path.join(root, rel);
      fs.writeFileSync(abs, "before");
      const st = fs.statSync(abs);
      const result = writeRemoteProjectFile(root, rel, "after", {
        mtimeMs: st.mtimeMs,
        size: st.size,
      }, { expectedAbsPath: abs, isExecutableOpenTarget: () => false });
      expect(result.ok, `${rel} should be writable`).toBe(true);
      expect(fs.readFileSync(abs, "utf8")).toBe("after");
    }
  });
});

// The read path withholds the stamp and absolute path for an image, so the
// client paints no Edit control. That is a UI affordance, and the client is
// untrusted — the host has to refuse a crafted write on its own.
describe("remote writes are text-only, enforced host-side", () => {
  it("refuses a non-text file even with a valid stamp and path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-rfiles-"));
    const rel = "logo.png";
    const abs = path.join(root, rel);
    fs.writeFileSync(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const st = fs.statSync(abs);

    const result = writeRemoteProjectFile(
      root,
      rel,
      "not a png any more",
      { mtimeMs: st.mtimeMs, size: st.size },
      { expectedAbsPath: abs, isExecutableOpenTarget: () => false },
    );

    expect(result.ok).toBe(false);
    // ...and the bytes on disk are untouched.
    expect(fs.readFileSync(abs)[0]).toBe(0x89);
  });

  it("still allows the text kinds", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-rfiles-"));
    for (const rel of ["notes.md", "data.json", "plain.txt"]) {
      const abs = path.join(root, rel);
      fs.writeFileSync(abs, "before");
      const st = fs.statSync(abs);
      const result = writeRemoteProjectFile(
        root,
        rel,
        "after",
        { mtimeMs: st.mtimeMs, size: st.size },
        { expectedAbsPath: abs, isExecutableOpenTarget: () => false },
      );
      expect(result.ok, `${rel} should be writable`).toBe(true);
      expect(fs.readFileSync(abs, "utf8")).toBe("after");
    }
  });
});
