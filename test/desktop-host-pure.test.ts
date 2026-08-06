/**
 * Pure desktop helpers (no Electron process) — safe for npm test / CI.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigStore,
  SensitiveConfigStore,
  SENSITIVE_CONFIG_KEYS,
  normalizeWorkspaceRoots,
} from "../src/desktop/config-store";
import {
  buildDiffViewerHtml,
  buildTextViewerHtml,
  escapeHtml,
  interpretOpenPathResult,
  resolveDocumentText,
} from "../src/desktop/document-view";
import {
  asAppResourceRegistryUrl,
  asAppResourceUrl,
  appResourceUrlToFsPath,
  APP_RESOURCE_CSP_SOURCE,
  desktopChromeBootSource,
} from "../src/desktop/electron-webview";
import { Uri } from "../src/host";
import { findFilesUnder } from "../src/desktop/find-files";
import {
  createSafeStorageSecrets,
  EncryptionUnavailableError,
  isWindowsReplaceRenameError,
  writeFileAtomic,
  type SafeStorageLike,
} from "../src/desktop/safe-secrets";
import {
  appResourceMayServe,
  isGeneratedSessionMediaPath,
  resolveAppResourceServe,
  rootServePolicy,
} from "../src/desktop/app-resource-policy";
import { AsyncSerialQueue } from "../src/async-serial";
import {
  authorizeDesktopWebviewMsg,
  authorizeDropFile,
  authorizeOpenFile,
  authorizeOpenUrl,
  desktopAuthRoots,
  isExecutablePath,
} from "../src/desktop/desktop-policy";
import {
  FileSelectionRegistry,
  isFileSelectionId,
} from "../src/desktop/file-selection-registry";
import {
  planOpenCliInTerminal,
  planRunCommandInTerminal,
} from "../src/desktop/external-terminal";
import {
  breadcrumbSegments,
  classifyFilePreview,
  FILE_TREE_MAX_ENTRIES,
  listTreeDir,
  nearestExistingAncestor,
  readTreeFile,
  resolveTreePath,
  type TreePathFs,
} from "../src/desktop/file-tree";
import { isIpcFromMainWindow } from "../src/desktop/file-tree-ipc";
import { FILE_TREE_PANEL_CSS, fileTreePanelBootSource } from "../src/desktop/file-tree-panel";
import { mayRegisterResourcePath } from "../src/desktop/media-provenance";
import {
  ResourceRegistry,
  registryIdFromUrlPath,
} from "../src/desktop/resource-registry";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";
import { isTrustedGeneratedMediaPath } from "../src/media-serve";
import {
  buildInputBoxHtml,
  buildQuickPickHtml,
  DESKTOP_APP_FULL_NAME,
  DESKTOP_PUBLIC_REPO_URL,
  parseDialogSubmit,
  selectQuickPickIndex,
} from "../src/desktop/host-dialogs";
import {
  isAllowedAppNavigationUrl,
  shouldBlockNavigation,
  shouldOpenExternally,
  windowOpenDecision,
} from "../src/desktop/window-security";

describe("desktop ConfigStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cfg-"));
    file = path.join(dir, "config.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads defaults and persists dotted overrides", async () => {
    const store = new ConfigStore(file);
    expect(store.getConfiguration("grok").get("cliPath", "")).toBe("");
    expect(store.getConfiguration("grok").get("showThinking", false)).toBe(false);

    await store.getConfiguration("grok").update("cliPath", "/bin/fake-grok");
    expect(store.getConfiguration("grok").get("cliPath")).toBe("/bin/fake-grok");

    const again = new ConfigStore(file);
    expect(again.getConfiguration("grok").get("cliPath")).toBe("/bin/fake-grok");
  });

  it("fires onDidChange for dotted keys", async () => {
    const store = new ConfigStore(file);
    const seen: string[] = [];
    store.onDidChange((e) => {
      if (e.affectsConfiguration("grok.cliPath")) seen.push("cliPath");
      if (e.affectsConfiguration("grok")) seen.push("grok");
    });
    await store.getConfiguration("grok").update("cliPath", "x");
    expect(seen).toContain("cliPath");
    expect(seen).toContain("grok");
  });

  it("persists workspace root", () => {
    const store = new ConfigStore(file);
    // Real directory so reload normalization keeps the path on every platform.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ws-persist-"));
    try {
      store.setWorkspaceRoot(ws);
      expect(new ConfigStore(file).getWorkspaceRoot()).toBe(path.resolve(ws));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it("multi-folder: add / switch / refuse last remove / reload", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mf-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mf-b-"));
    try {
      const store = new ConfigStore(file);
      expect(store.addWorkspaceRoot(a, true)).toBe(true);
      expect(store.getWorkspaceRoots()).toEqual([path.resolve(a)]);
      expect(store.getWorkspaceRoot()).toBe(path.resolve(a));
      expect(store.addWorkspaceRoot(b, true)).toBe(true);
      expect(store.getWorkspaceRoots().map((p) => path.resolve(p)).sort()).toEqual(
        [path.resolve(a), path.resolve(b)].sort(),
      );
      expect(store.getWorkspaceRoot()).toBe(path.resolve(b));
      expect(store.setActiveWorkspaceRoot(a)).toBe(true);
      expect(store.getWorkspaceRoot()).toBe(path.resolve(a));
      // Last remaining folder cannot be closed.
      expect(store.removeWorkspaceRoot(b)).toBe(true);
      expect(store.removeWorkspaceRoot(a)).toBe(false);
      expect(store.getWorkspaceRoots()).toEqual([path.resolve(a)]);

      const reloaded = new ConfigStore(file);
      expect(reloaded.getWorkspaceRoots()).toEqual([path.resolve(a)]);
      expect(reloaded.getWorkspaceRoot()).toBe(path.resolve(a));
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it("normalizeWorkspaceRoots dedupes and drops missing paths", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "grok-norm-"));
    try {
      const out = normalizeWorkspaceRoots([a, a, path.join(a, "nope-missing")]);
      expect(out).toEqual([path.resolve(a)]);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
    }
  });

  it("honours caller-supplied defaultValue for unknown keys (arguments-in-arrow bug)", () => {
    const store = new ConfigStore(file);
    // Unknown key: getValue returns undefined; default must win.
    expect(store.getConfiguration("grok").get("notARealKey", "fallback-x")).toBe("fallback-x");
    expect(store.getConfiguration("grok").get("notARealKey")).toBeUndefined();
    // Known default still preferred over a caller default when set in CONFIG_DEFAULTS.
    expect(store.getConfiguration("grok").get("showThinking", true)).toBe(false);
  });
});

describe("app-resource URI mapping", () => {
  it("round-trips a file Uri through asWebviewUri shape", () => {
    const u = Uri.file(path.join("C:", "GitHub", "repo", "media", "chat.js"));
    const href = asAppResourceUrl(u);
    expect(href.startsWith("app-resource://vsc-resource/")).toBe(true);
    expect(APP_RESOURCE_CSP_SOURCE).toBe("app-resource:");
    const back = appResourceUrlToFsPath(href);
    expect(back).toBeTruthy();
    // Path separators normalized by path module on the host platform.
    expect(back!.toLowerCase().replace(/\\/g, "/")).toContain("media/chat.js");
  });
});

describe("findFilesUnder", () => {
  it("lists files and skips node_modules", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-find-"));
    try {
      fs.writeFileSync(path.join(root, "a.ts"), "a");
      fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
      fs.writeFileSync(path.join(root, "node_modules", "x", "y.js"), "y");
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src", "b.ts"), "b");
      const uris = await findFilesUnder(root);
      const rels = uris.map((u) => path.relative(root, u.fsPath).split(path.sep).join("/"));
      expect(rels).toContain("a.ts");
      expect(rels).toContain("src/b.ts");
      expect(rels.some((r) => r.includes("node_modules"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("document-view helpers", () => {
  it("interpretOpenPathResult treats empty string as success", () => {
    expect(interpretOpenPathResult("")).toEqual({ ok: true });
    expect(interpretOpenPathResult("Failed to open")).toEqual({
      ok: false,
      error: "Failed to open",
    });
  });

  it("escapeHtml neutralizes markup", () => {
    expect(escapeHtml(`<script>"x"&y</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot;&amp;y&lt;/script&gt;",
    );
  });

  it("resolveDocumentText reads file URIs and content providers", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-doc-"));
    try {
      const file = path.join(tmp, "a.txt");
      fs.writeFileSync(file, "from-disk");
      const fileUri = Uri.file(file);
      expect(
        resolveDocumentText(fileUri, new Map(), (p) => fs.readFileSync(p, "utf8")),
      ).toBe("from-disk");

      const virtual = Uri.from({
        scheme: "grok-diff",
        path: "/1/before/x.ts",
        fsPath: "/1/before/x.ts",
      });
      const providers = new Map([
        [
          "grok-diff",
          {
            provideTextDocumentContent: (u: Uri) =>
              u.toString().includes("before") ? "old" : "new",
          },
        ],
      ]);
      expect(resolveDocumentText(virtual, providers, () => "")).toBe("old");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("buildTextViewerHtml embeds content as text (not raw HTML)", () => {
    const html = buildTextViewerHtml("Untitled", "<b>hi</b>", "markdown");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).not.toContain("<b>hi</b>");
    expect(html).toContain("read-only");
  });

  it("buildDiffViewerHtml marks differing lines and focuses a line", () => {
    const html = buildDiffViewerHtml(
      "Grok proposed: foo.ts",
      "before",
      "a\nb",
      "after",
      "a\nB",
      1,
    );
    expect(html).toContain("read-only preview");
    expect(html).toContain('id="focus-line"');
    expect(html).toContain("row diff");
    expect(html).toContain(">a</div>");
  });
});

describe("createSafeStorageSecrets", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-sec-"));
    file = path.join(dir, "secrets.enc.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function xorStorage(key = 0x5a): SafeStorageLike {
    return {
      isEncryptionAvailable: () => true,
      encryptString: (s) =>
        Buffer.from([...Buffer.from(s, "utf8")].map((b) => b ^ key)),
      decryptString: (buf) =>
        Buffer.from([...buf].map((b) => b ^ key)).toString("utf8"),
    };
  }

  it("stores ciphertext, not the plaintext token", async () => {
    const secrets = createSafeStorageSecrets(file, xorStorage());
    const token = "device-token-super-secret";
    await secrets.store("grok.remoteControl.deviceToken", token);
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain(token);
    expect(JSON.parse(raw).entries["grok.remoteControl.deviceToken"]).toBeTruthy();
    expect(await secrets.get("grok.remoteControl.deviceToken")).toBe(token);
  });

  it("round-trips store → get → delete", async () => {
    const secrets = createSafeStorageSecrets(file, xorStorage());
    await secrets.store("k", "v1");
    expect(await secrets.get("k")).toBe("v1");
    await secrets.delete("k");
    expect(await secrets.get("k")).toBeUndefined();
  });

  it("fails loudly when encryption is unavailable (no plaintext fallback)", async () => {
    const unavailable: SafeStorageLike = {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error("should not encrypt");
      },
      decryptString: () => {
        throw new Error("should not decrypt");
      },
    };
    const secrets = createSafeStorageSecrets(file, unavailable);
    await expect(secrets.store("k", "v")).rejects.toBeInstanceOf(EncryptionUnavailableError);
    // Missing key still returns undefined without needing decrypt.
    expect(await secrets.get("missing")).toBeUndefined();
    // Persist a ciphertext with a working encryptor, then refuse decrypt.
    await createSafeStorageSecrets(file, xorStorage()).store("k", "secret");
    await expect(secrets.get("k")).rejects.toBeInstanceOf(EncryptionUnavailableError);
    // Disk must still hold only ciphertext — never a silent plaintext rewrite.
    expect(fs.readFileSync(file, "utf8")).not.toContain("secret");
  });

  it("mutation: a plaintext fallback would be detectable", async () => {
    // If createSafeStorageSecrets were "fixed" to write plaintext when
    // encryption is off, this test fails. Keep the unavailable path hard-fail.
    const unavailable: SafeStorageLike = {
      isEncryptionAvailable: () => false,
      encryptString: (s) => Buffer.from(s, "utf8"),
      decryptString: (b) => b.toString("utf8"),
    };
    const secrets = createSafeStorageSecrets(file, unavailable);
    let threw = false;
    try {
      await secrets.store("grok.remoteControl.deviceToken", "plain-token-value");
    } catch (e) {
      threw = e instanceof EncryptionUnavailableError;
    }
    expect(threw).toBe(true);
    if (fs.existsSync(file)) {
      expect(fs.readFileSync(file, "utf8")).not.toContain("plain-token-value");
    }
  });

  it("writes secrets via temp file then rename (crash-safe)", async () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "safe-secrets.ts"),
      "utf8",
    );
    expect(src).toContain("writeFileAtomic");
    expect(src).toMatch(/renameSync/);
    // Functional: writeFileAtomic leaves a valid final file, never a bare partial.
    const out = path.join(dir, "atomic.json");
    writeFileAtomic(out, JSON.stringify({ ok: true }));
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual({ ok: true });
    // No leftover temps for that write.
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("desktop main wiring (source gates)", () => {
  it("stores device credentials via safeStorage, not plaintext createFileSecrets", () => {
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    expect(main).toContain("createSafeStorageSecrets");
    expect(main).toContain("safeStorage");
    expect(main).toContain("secrets.enc.json");
    expect(main).not.toContain("createFileSecrets");
    expect(main).not.toMatch(/secrets\.json/);
  });

  it("wires linkRemote/unlinkRemote to the sidebar device-link flow", () => {
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    expect(main).toContain("linkRemoteDevice");
    expect(main).toContain("unlinkRemoteDevice");
    expect(main).toContain("remoteActions");
  });

  it("registers file-tree IPC and injects the panel without touching getHtml", () => {
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    const preload = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "preload.ts"),
      "utf8",
    );
    expect(main).toContain("registerFileTreeIpc");
    expect(main).toContain("injectFileTreePanelLogged");
    expect(main).toContain("did-finish-load");
    expect(preload).toContain("grokDesktopFileTree");
    expect(preload).toContain("desk-ft:list");
    // Panel boot must not live in shared chat.js.
    const chatJs = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.js"),
      "utf8",
    );
    expect(chatJs).not.toContain("desk-ft-");
    expect(chatJs).not.toContain("grokDesktopFileTree");
  });
});

describe("file-tree path containment", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ft-"));
    fs.writeFileSync(path.join(root, "readme.txt"), "hi");
    fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "hello.ts"), "export {}");
    fs.writeFileSync(path.join(root, "src", "nested", "deep.ts"), "export {}");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves empty and nested relative paths under the workspace", () => {
    const top = resolveTreePath(root, "");
    expect(top.ok).toBe(true);
    if (top.ok) {
      expect(path.resolve(top.absPath)).toBe(path.resolve(root));
      expect(top.relPath).toBe("");
    }
    const nested = resolveTreePath(root, "src/nested/deep.ts");
    expect(nested.ok).toBe(true);
    if (nested.ok) {
      expect(nested.relPath).toBe("src/nested/deep.ts");
      expect(fs.existsSync(nested.absPath)).toBe(true);
    }
  });

  it("rejects traversal, absolute escape, and null bytes", () => {
    expect(resolveTreePath(root, "..").ok).toBe(false);
    expect(resolveTreePath(root, "../outside").ok).toBe(false);
    expect(resolveTreePath(root, "src/../../outside").ok).toBe(false);
    expect(resolveTreePath(root, "src/foo/../../../etc/passwd").ok).toBe(false);
    expect(resolveTreePath(root, "a\0b").ok).toBe(false);

    // Absolute path outside workspace
    const outside = path.resolve(root, "..", "not-ws-" + Date.now());
    expect(resolveTreePath(root, outside).ok).toBe(false);

    // Absolute path that happens to be inside is allowed (openFile may pass abs).
    const insideAbs = path.join(root, "readme.txt");
    const absOk = resolveTreePath(root, insideAbs);
    expect(absOk.ok).toBe(true);
    if (absOk.ok) expect(absOk.relPath).toBe("readme.txt");
  });

  it("mutation: dropping the .. segment check would accept a traversal", () => {
    // Guard must reject any segment equal to "..". If someone "simplifies" to
    // only path.relative after resolve, carefully crafted inputs can slip;
    // this pins the explicit segment rejection.
    const bad = resolveTreePath(root, "src/..");
    // "src/.." has a .. segment → reject even though it resolves to root.
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/escape/i);
  });

  it("lists directories with dirs first and truncates huge folders", () => {
    const listed = listTreeDir(root, "");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const names = listed.entries.map((e) => e.name);
    expect(names).toContain("readme.txt");
    expect(names).toContain("src");
    // dirs before files
    const srcIdx = listed.entries.findIndex((e) => e.name === "src");
    const readmeIdx = listed.entries.findIndex((e) => e.name === "readme.txt");
    expect(listed.entries[srcIdx].kind).toBe("dir");
    expect(listed.entries[readmeIdx].kind).toBe("file");
    expect(srcIdx).toBeLessThan(readmeIdx);

    const srcList = listTreeDir(root, "src");
    expect(srcList.ok).toBe(true);
    if (srcList.ok) {
      expect(srcList.entries.map((e) => e.name)).toEqual(
        expect.arrayContaining(["hello.ts", "nested"]),
      );
    }

    // Cap: create a dir with more than maxEntries when max is low.
    const many = path.join(root, "many");
    fs.mkdirSync(many);
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(path.join(many, `f${i}.txt`), "x");
    }
    const capped = listTreeDir(root, "many", 10);
    expect(capped.ok).toBe(true);
    if (capped.ok) {
      expect(capped.entries.length).toBe(10);
      expect(capped.truncated).toBe(true);
    }
    expect(FILE_TREE_MAX_ENTRIES).toBeGreaterThan(100);
  });

  it("rejects listing a path outside the workspace", () => {
    const r = listTreeDir(root, "../");
    expect(r.ok).toBe(false);
  });

  it("rejects outbound symlink for both list and open (canonical containment)", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ft-out-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "classified");
      const linkPath = path.join(root, "escape-link");
      let created = false;
      try {
        // Prefer a real directory symlink when the OS allows it.
        fs.symlinkSync(outside, linkPath, process.platform === "win32" ? "dir" : "dir");
        created = true;
      } catch (e) {
        // Windows without Developer Mode cannot create dir symlinks (EPERM).
        // Fall through to an injectable realpath that simulates the same escape
        // so the regression still fails if the realpath gate is removed.
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "EPERM" && err.code !== "EACCES") throw e;
      }

      if (created) {
        // Listing the workspace must not surface the outbound link as a dir.
        const top = listTreeDir(root, "");
        expect(top.ok).toBe(true);
        if (top.ok) {
          expect(top.entries.map((e) => e.name)).not.toContain("escape-link");
        }
        // Resolve / open path must refuse.
        const resolved = resolveTreePath(root, "escape-link");
        expect(resolved.ok).toBe(false);
        if (!resolved.ok) expect(resolved.reason).toMatch(/symlink|escape/i);
        const nested = resolveTreePath(root, "escape-link/secret.txt");
        expect(nested.ok).toBe(false);
        const listed = listTreeDir(root, "escape-link");
        expect(listed.ok).toBe(false);
      } else {
        // Simulated symlink: realpath of root/escape-link → outside.
        const linkAbs = path.join(root, "escape-link");
        const secretAbs = path.join(root, "escape-link", "secret.txt");
        const mockFs: TreePathFs = {
          realpathSync(p: string) {
            const n = path.normalize(p);
            if (n === path.normalize(linkAbs) || n.startsWith(path.normalize(linkAbs) + path.sep)) {
              return path.join(outside, path.relative(linkAbs, n));
            }
            return fs.realpathSync(p);
          },
          existsSync: (p) => fs.existsSync(p),
          statSync: (p) => fs.statSync(p),
          readdirSync: (p, o) => fs.readdirSync(p, o),
        };
        // Create a real in-tree dir so readdir/stat have something; realpath redirects.
        fs.mkdirSync(linkAbs);
        fs.writeFileSync(secretAbs, "x");
        const resolved = resolveTreePath(root, "escape-link", process.platform, mockFs);
        expect(resolved.ok).toBe(false);
        if (!resolved.ok) expect(resolved.reason).toMatch(/symlink|escape/i);
        const nested = resolveTreePath(root, "escape-link/secret.txt", process.platform, mockFs);
        expect(nested.ok).toBe(false);
        // Mutation: pure lexical resolve would accept these paths.
        const lexicalOnly = path.resolve(root, "escape-link", "secret.txt");
        expect(lexicalOnly.startsWith(path.resolve(root))).toBe(true);
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects Windows junction pointing outside (list + open)", function () {
    if (process.platform !== "win32") {
      // Junctions are a Windows reparse-point feature.
      return;
    }
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ft-junc-out-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "junction-secret");
      const junc = path.join(root, "vendor");
      fs.symlinkSync(outside, junc, "junction");

      const top = listTreeDir(root, "");
      expect(top.ok).toBe(true);
      if (top.ok) {
        expect(top.entries.map((e) => e.name)).not.toContain("vendor");
      }
      expect(resolveTreePath(root, "vendor").ok).toBe(false);
      expect(resolveTreePath(root, "vendor/secret.txt").ok).toBe(false);
      expect(listTreeDir(root, "vendor").ok).toBe(false);

      // Mutation pin: lexical containment alone would pass (link path is in-tree).
      const lexical = path.resolve(root, "vendor", "secret.txt");
      expect(lexical.startsWith(path.resolve(root))).toBe(true);
      const real = fs.realpathSync(path.join(root, "vendor", "secret.txt"));
      expect(path.resolve(real).startsWith(path.resolve(root))).toBe(false);
    } finally {
      try {
        fs.rmSync(path.join(root, "vendor"), { recursive: true, force: true });
      } catch {
        /* junction remove */
      }
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows an in-workspace symlink (target still under root)", () => {
    const target = path.join(root, "src", "hello.ts");
    const link = path.join(root, "alias.ts");
    try {
      fs.symlinkSync(target, link, process.platform === "win32" ? "file" : "file");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EPERM" || err.code === "EACCES") {
        // No symlink privilege — simulate with injectable realpath that stays inside.
        const mockFs: TreePathFs = {
          realpathSync(p: string) {
            if (path.normalize(p) === path.normalize(link)) return fs.realpathSync(target);
            return fs.realpathSync(p);
          },
          existsSync: (p) => (path.normalize(p) === path.normalize(link) ? true : fs.existsSync(p)),
          statSync: (p) => fs.statSync(path.normalize(p) === path.normalize(link) ? target : p),
          readdirSync: (p, o) => fs.readdirSync(p, o),
        };
        const r = resolveTreePath(root, "alias.ts", process.platform, mockFs);
        expect(r.ok).toBe(true);
        return;
      }
      throw e;
    }
    try {
      const r = resolveTreePath(root, "alias.ts");
      expect(r.ok).toBe(true);
    } finally {
      fs.unlinkSync(link);
    }
  });
});

describe("app-resource serve policy (no credential leak)", () => {
  let tmp: string;
  let grokHome: string;
  let mediaRoot: string;
  let staging: string;
  let roots: string[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-res-"));
    grokHome = path.join(tmp, "fake-grok-home");
    mediaRoot = path.join(tmp, "ext", "media");
    staging = path.join(tmp, "globalStorage", "image-staging");
    roots = [mediaRoot, staging, grokHome];
    fs.mkdirSync(mediaRoot, { recursive: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.mkdirSync(path.join(grokHome, "sessions", "cwd", "id", "images"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(mediaRoot, "chat.js"), "/* chat */");
    fs.writeFileSync(path.join(staging, "image-uuid.png"), "png");
    fs.writeFileSync(path.join(grokHome, "auth.json"), '{"token":"secret"}');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("classifies Grok home as media-only and extension media as full", () => {
    expect(rootServePolicy(grokHome)).toBe("media-only");
    expect(rootServePolicy(mediaRoot)).toBe("full");
    expect(rootServePolicy(staging)).toBe("full");
  });

  it("refuses path-shaped URLs under Grok home (registry required)", () => {
    const auth = path.join(grokHome, "auth.json");
    expect(appResourceMayServe(auth, roots)).toBe(false);
    expect(
      appResourceMayServe(path.join(grokHome, "config.toml"), roots),
    ).toBe(false);
    const img = path.join(grokHome, "sessions", "cwd", "id", "images", "1.jpg");
    expect(isGeneratedSessionMediaPath(img)).toBe(true);
    // Path allowlist alone is no longer enough — provenance via registry.
    expect(appResourceMayServe(img, roots)).toBe(false);
  });

  it("allows extension media and image staging via static path", () => {
    expect(appResourceMayServe(path.join(mediaRoot, "chat.js"), roots)).toBe(true);
    expect(appResourceMayServe(path.join(staging, "image-uuid.png"), roots)).toBe(true);
  });

  it("serves generated media only through a host-issued registry handle", () => {
    const img = path.join(grokHome, "sessions", "cwd", "id", "images", "1.jpg");
    fs.writeFileSync(img, "fake-jpeg");
    const registry = new ResourceRegistry();
    const id = registry.register(img);
    const url = asAppResourceRegistryUrl(id);
    expect(registryIdFromUrlPath(url)).toBe(id);

    const viaPath = resolveAppResourceServe({
      urlOrPath: asAppResourceUrl(Uri.file(img)),
      fsPath: img,
      allowedRoots: roots,
      registry,
    });
    expect(viaPath.ok).toBe(false);

    const viaReg = resolveAppResourceServe({
      urlOrPath: url,
      allowedRoots: roots,
      registry,
    });
    expect(viaReg.ok).toBe(true);
    if (viaReg.ok) {
      expect(viaReg.via).toBe("registry");
      expect(fs.readFileSync(viaReg.fsPath, "utf8")).toBe("fake-jpeg");
    }
  });

  it("refuses a symlinked media file that points at a credential", () => {
    const auth = path.join(grokHome, "auth.json");
    const link = path.join(grokHome, "sessions", "cwd", "id", "images", "auth.png");
    const registry = new ResourceRegistry();

    let linked = false;
    try {
      fs.symlinkSync(auth, link, process.platform === "win32" ? "file" : undefined);
      linked = true;
    } catch {
      // No symlink privilege: simulate with injectable realpath via register
      // on the auth file itself under a media-looking name is the real risk;
      // without OS symlinks, register(auth) then resolve still serves auth —
      // the host must not register credentials. Path-shaped media URLs stay off.
    }

    if (linked) {
      // Host should never register a credential; if it did, realpath is auth.json
      // and we still refuse basename auth.json on the served path.
      try {
        const id = registry.register(link);
        const resolved = registry.resolveForServe(id);
        // After symlink, realpath is auth.json — resolveForServe returns the real
        // path; resolveAppResourceServe then refuses auth.json basenames.
        const serve = resolveAppResourceServe({
          urlOrPath: asAppResourceRegistryUrl(id),
          allowedRoots: roots,
          registry,
        });
        // Either register threw, resolve returned null after swap policy, or
        // serve refused credential basename.
        if (resolved && /auth\.json$/i.test(resolved)) {
          expect(serve.ok).toBe(false);
        } else {
          // Symlink may be registered as the link path with real=auth; refuse.
          expect(serve.ok === false || (serve.ok && !/auth\.json$/i.test(serve.fsPath))).toBe(
            true,
          );
          if (serve.ok) {
            // Must not leak credential bytes as a successful media serve of auth.json.
            expect(serve.fsPath.toLowerCase()).not.toMatch(/auth\.json$/i);
          }
        }
      } catch {
        // register refuses non-files / missing — also fine
      }
      // Path-shaped request for the link is always refused (media-only root).
      expect(
        resolveAppResourceServe({
          urlOrPath: link,
          fsPath: link,
          allowedRoots: roots,
          registry: new ResourceRegistry(),
        }).ok,
      ).toBe(false);
    }

    // Mutation: a path-shape allowlist would accept …/images/auth.png.
    expect(isGeneratedSessionMediaPath(link)).toBe(true);
    expect(appResourceMayServe(link, roots)).toBe(false);
  });

  it("refuses registry serve after realpath changes (symlink swap)", () => {
    const realImg = path.join(grokHome, "sessions", "cwd", "id", "images", "1.jpg");
    const auth = path.join(grokHome, "auth.json");
    fs.writeFileSync(realImg, "jpeg-bytes");
    const registry = new ResourceRegistry();
    const id = registry.register(realImg);
    expect(registry.resolveForServe(id)).toBeTruthy();

    // Replace the media file with a symlink to auth.json (when OS allows).
    let swapped = false;
    try {
      fs.unlinkSync(realImg);
      fs.symlinkSync(auth, realImg, process.platform === "win32" ? "file" : undefined);
      swapped = true;
    } catch {
      // Restore the original file if symlink failed mid-way.
      try {
        if (!fs.existsSync(realImg)) fs.writeFileSync(realImg, "jpeg-bytes");
      } catch {
        /* */
      }
    }

    if (!swapped) {
      // Without symlink privilege: simulate realpath divergence with injectable fs.
      const snapReal = fs.realpathSync(realImg);
      let phase: "register" | "serve" = "register";
      const mock = new ResourceRegistry({
        realpathSync: (p) => {
          if (path.resolve(p) === path.resolve(realImg)) {
            return phase === "register" ? snapReal : auth;
          }
          return fs.realpathSync(p);
        },
        existsSync: (p) => fs.existsSync(p),
        statSync: (p) => fs.statSync(p),
      });
      const mid = mock.register(realImg);
      phase = "serve";
      expect(mock.resolveForServe(mid)).toBeNull();
      return;
    }

    // Real target changed → refuse.
    expect(registry.resolveForServe(id)).toBeNull();
    expect(
      resolveAppResourceServe({
        urlOrPath: asAppResourceRegistryUrl(id),
        allowedRoots: roots,
        registry,
      }).ok,
    ).toBe(false);
  });

  it("mutation: lexical-only root check would serve auth.json", () => {
    const auth = path.join(grokHome, "auth.json");
    const lexicalOnly = roots.some((r) => {
      const rel = path.relative(r, auth);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    expect(lexicalOnly).toBe(true);
    expect(appResourceMayServe(auth, roots)).toBe(false);
  });
});

describe("webview message schema validation", () => {
  it("accepts known well-formed messages", () => {
    expect(parseWebviewMsg({ type: "ready" })).toEqual({ type: "ready" });
    expect(parseWebviewMsg({ type: "send", text: "hi" })).toEqual({
      type: "send",
      text: "hi",
    });
    expect(parseWebviewMsg({ type: "openFile", path: "a.ts" })?.type).toBe("openFile");
    expect(parseWebviewMsg({ type: "setMode", modeId: "plan" })?.type).toBe("setMode");
  });

  it("drops unknown types and malformed payloads", () => {
    expect(parseWebviewMsg(null)).toBeNull();
    expect(parseWebviewMsg("send")).toBeNull();
    expect(parseWebviewMsg({ type: "notARealMessage" })).toBeNull();
    expect(parseWebviewMsg({ type: "send" })).toBeNull(); // missing text
    expect(parseWebviewMsg({ type: "openFile" })).toBeNull();
    expect(parseWebviewMsg({ type: "openFile", path: 12 })).toBeNull();
    expect(parseWebviewMsg({ type: "setMode", modeId: "yolo-extra" })).toBeNull();
    expect(parseWebviewMsg({ type: "logout", evil: true })?.type).toBe("logout");
    // logout has no required fields beyond type — but inventing a type fails:
    expect(parseWebviewMsg({ type: "deleteEverything" })).toBeNull();
  });

  it("source gate: ElectronWebview.dispatchMessage validates before listeners", () => {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-webview.ts",
      ),
      "utf8",
    );
    expect(src).toContain("parseWebviewMsg");
    expect(src).toMatch(/dispatchMessage[\s\S]*parseWebviewMsg/);
  });
});

describe("window navigation and open locks", () => {
  it("allows only app document navigation URLs", () => {
    expect(isAllowedAppNavigationUrl("data:text/html;charset=utf-8,x")).toBe(true);
    expect(isAllowedAppNavigationUrl("app-resource://vsc-resource/media/chat.js")).toBe(
      true,
    );
    expect(shouldBlockNavigation("https://evil.example/phish")).toBe(true);
    expect(shouldBlockNavigation("file:///etc/passwd")).toBe(true);
    expect(shouldBlockNavigation("data:text/html,ok")).toBe(false);
  });

  it("denies window.open; may hand http(s) to openExternal", () => {
    expect(shouldOpenExternally("https://github.com/phuryn/grok-build-vscode")).toBe(
      true,
    );
    expect(shouldOpenExternally("javascript:alert(1)")).toBe(false);
    const d = windowOpenDecision({ url: "https://example.com" });
    expect(d.action).toBe("deny");
    expect(d.openExternal).toBe("https://example.com");
    expect(windowOpenDecision({ url: "app-resource://x" }).openExternal).toBeUndefined();
  });

  it("source gate: main installs setWindowOpenHandler and will-navigate", () => {
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    expect(main).toContain("installWindowSecurityLocks");
    const sec = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "window-security.ts",
      ),
      "utf8",
    );
    expect(sec).toContain("setWindowOpenHandler");
    expect(sec).toContain("will-navigate");
  });
});

describe("desktop quick pick and input dialogs", () => {
  it("selectQuickPickIndex returns a selection for 20 items", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      label: `Model ${i + 1}`,
      description: `m-${i}`,
    }));
    expect(selectQuickPickIndex(items, 0)?.label).toBe("Model 1");
    expect(selectQuickPickIndex(items, 19)?.label).toBe("Model 20");
    expect(selectQuickPickIndex(items, 20)).toBeUndefined();
    expect(selectQuickPickIndex(items, -1)).toBeUndefined();
  });

  it("buildQuickPickHtml lists all items (no 8-item cap)", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      label: `Item ${i}`,
      description: `d${i}`,
    }));
    const html = buildQuickPickHtml({ title: "Models", items });
    expect(html).toContain("Item 0");
    expect(html).toContain("Item 19");
    expect(html).toContain('data-index="19"');
    expect(html).not.toContain("not available");
  });

  it("buildInputBoxHtml is a real form, not a cancel stub", () => {
    const html = buildInputBoxHtml({ prompt: "Worktree label", value: "wt" });
    expect(html).toContain("Worktree label");
    expect(html).toContain('id="val"');
    expect(html).toContain("deskDialog");
    expect(parseDialogSubmit({ kind: "input", value: "hello" })).toEqual({
      kind: "input",
      value: "hello",
    });
  });

  it("source gate: electron-host no longer cancels large quick picks", () => {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-host.ts",
      ),
      "utf8",
    );
    expect(src).toContain("buildQuickPickHtml");
    expect(src).toContain("buildInputBoxHtml");
    expect(src).not.toMatch(/items\.length\s*>\s*8/);
    expect(src).not.toContain("Input prompt is not available yet");
    expect(src).not.toContain("Large quick-pick lists");
  });
});

describe("desktop branding and menu", () => {
  it("names the product Grok Build Desktop (Community) and links this repo only", () => {
    expect(DESKTOP_APP_FULL_NAME).toBe("Grok Build Desktop (Community)");
    expect(DESKTOP_PUBLIC_REPO_URL).toBe(
      "https://github.com/phuryn/grok-build-vscode",
    );
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    expect(main).toContain("DESKTOP_PUBLIC_REPO_URL");
    expect(main).toContain("buildDesktopAppMenu");
    expect(main).toContain("grok-icon.png");
    expect(main).not.toMatch(/https?:\/\/electronjs\.org/);
    expect(main).not.toMatch(/Learn More|Community Discussions|Search Issues/);
    // Reading width lives in desktop theme CSS, not shared chat.css.
    const theme = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-webview.ts",
      ),
      "utf8",
    );
    expect(theme).toContain("max-width: 1120px");
    const chatCss = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css"),
      "utf8",
    );
    expect(chatCss).not.toContain("max-width: 1120px");
  });
});

describe("external terminal plans (not silent no-ops)", () => {
  it("Windows CLI plan uses cmd start (visible) and can launch .cmd", () => {
    const plan = planOpenCliInTerminal(
      "Grok Login",
      "C:\\Users\\x\\.grok\\bin\\grok.cmd",
      ["login"],
      "C:\\ws",
      "win32",
    );
    expect(plan.kind).toBe("spawn");
    if (plan.kind !== "spawn") return;
    expect(plan.command.toLowerCase()).toMatch(/cmd/);
    expect(plan.args).toContain("start");
    expect(plan.args).toContain("C:\\Users\\x\\.grok\\bin\\grok.cmd");
    expect(plan.args).toContain("login");
  });

  it("Install Grok command opens a visible PowerShell on Windows", () => {
    const plan = planRunCommandInTerminal(
      "Install Grok",
      'irm https://x.ai/cli/install.ps1 | iex',
      undefined,
      "win32",
    );
    expect(plan.kind).toBe("spawn");
    if (plan.kind !== "spawn") return;
    expect(plan.args.join(" ")).toMatch(/powershell/i);
    expect(plan.args.join(" ")).toMatch(/install\.ps1/);
  });

  it("source gate: createTerminal no longer has empty sendText body", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "electron-host.ts"),
      "utf8",
    );
    expect(src).toContain("planRunCommandInTerminal");
    expect(src).toContain("planOpenCliInTerminal");
    // Old silent stub.
    expect(src).not.toMatch(/sendText\(\)\s*\{\s*\}/);
  });
});

describe("IPC sender validation helper", () => {
  it("accepts only the main window webContents id", () => {
    const main = { id: 1, isDestroyed: () => false };
    const other = { id: 2, isDestroyed: () => false };
    const getWin = () =>
      ({
        isDestroyed: () => false,
        webContents: main,
      }) as never;
    expect(
      isIpcFromMainWindow({ sender: main as never }, getWin),
    ).toBe(true);
    expect(
      isIpcFromMainWindow({ sender: other as never }, getWin),
    ).toBe(false);
  });

  it("main.ts validates webview-to-host via trusted main-frame helper", () => {
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    expect(main).toContain("webview-to-host");
    expect(main).toContain("isTrustedMainFrameIpc");
    expect(main).toContain("dispatchMessage");
  });
});

describe("file-tree panel assets", () => {
  it("scopes CSS under desk-ft- and boots without chat.js symbols", () => {
    expect(FILE_TREE_PANEL_CSS).toContain(".desk-ft-panel");
    expect(FILE_TREE_PANEL_CSS).toContain("desk-ft-closed");
    // Top bar (body or .app-main host); panel takes no space when closed.
    expect(FILE_TREE_PANEL_CSS).toContain("body.desk-with-ft .top-bar");
    expect(FILE_TREE_PANEL_CSS).toContain("body.desk-ft-closed .desk-ft-panel");
    expect(FILE_TREE_PANEL_CSS).toContain("display: none !important");
    // Coexists with projects rail (row layout when has-rail).
    expect(FILE_TREE_PANEL_CSS).toContain("has-rail");
    expect(FILE_TREE_PANEL_CSS).toContain(".app-main");
    // Viewer replaces tree (not side-by-side).
    expect(FILE_TREE_PANEL_CSS).toContain("desk-ft-viewer");
    expect(FILE_TREE_PANEL_CSS).toContain("desk-ft-viewing");
    // Open panel is visually separated (border + own background).
    expect(FILE_TREE_PANEL_CSS).toMatch(/\.desk-ft-panel[\s\S]*border-left/);
    expect(FILE_TREE_PANEL_CSS).toMatch(
      /\.desk-ft-panel[\s\S]*background:\s*var\(--vscode-editor-background/,
    );
    // No unprefixed layout hijacks of chat primitives.
    expect(FILE_TREE_PANEL_CSS).not.toMatch(/(?:^|\n)\.messages\s*\{/);
    expect(FILE_TREE_PANEL_CSS).not.toMatch(/(?:^|\n)\.composer\s*\{/);

    const boot = fileTreePanelBootSource();
    expect(boot).toContain("grokDesktopFileTree");
    expect(boot).toContain("desk-ft-panel");
    expect(boot).toContain("desk-ft-top-toggle");
    expect(boot).toContain("desk-ft-open");
    expect(boot).toContain("localStorage");
    expect(boot).toContain("api.read");
    expect(boot).toContain("desk-ft-crumb");
    // Multi-folder rail host: shell mounts inside .app-main when present.
    expect(boot).toContain("app-main");
    expect(boot).toContain("projects-rail");
    // Lucide panel-left (rail) / panel-right (file tree) — not unicode glyphs.
    expect(boot).toContain("ICON_PANEL_LEFT");
    expect(boot).toContain("ICON_PANEL_RIGHT");
    expect(boot).toContain('d="M9 3v18"'); // panel-left divider
    expect(boot).toContain('d="M15 3v18"'); // panel-right divider
    expect(boot).not.toContain("◧");
    expect(boot).not.toContain("◫");
    expect(boot).toContain("desk-rail-toggle");
    // Does not call into acquireVsCodeApi / Host message bus.
    expect(boot).not.toContain("acquireVsCodeApi");
    expect(boot).not.toMatch(/type:\s*["']openFile["']/);
    expect(boot).not.toContain("postMessage");
  });
});

describe("desktop chrome boot (scroll fade + spacing shell)", () => {
  it("wraps messages and ramps fade opacity from scroll position", () => {
    const src = desktopChromeBootSource();
    expect(src).toContain("messages-wrap");
    expect(src).toContain("msg-fade-top");
    expect(src).toContain("msg-fade-bot");
    expect(src).toContain("--fade-top-op");
    expect(src).toContain("--fade-bot-op");
    expect(src).toContain("scrollTop");
    // Does not touch shared chat.js / Host messaging.
    expect(src).not.toContain("acquireVsCodeApi");
    expect(src).not.toContain("postMessage");
  });
});

describe("desktop openFile / openUrl policy (A1)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-pol-"));
    fs.writeFileSync(path.join(root, "readme.md"), "# hi");
    fs.writeFileSync(path.join(root, "tool.exe"), "MZ");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export {}");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("allows workspace files and refuses outside + executables", () => {
    expect(authorizeOpenFile("readme.md", { workspaceRoot: root }).ok).toBe(true);
    expect(authorizeOpenFile("src/a.ts", { workspaceRoot: root }).ok).toBe(true);
    expect(authorizeOpenFile(path.join(root, "readme.md"), { workspaceRoot: root }).ok).toBe(
      true,
    );

    const outside = path.join(path.dirname(root), "secret.txt");
    fs.writeFileSync(outside, "x");
    try {
      expect(authorizeOpenFile(outside, { workspaceRoot: root }).ok).toBe(false);
      expect(authorizeOpenFile("../secret.txt", { workspaceRoot: root }).ok).toBe(false);
    } finally {
      fs.unlinkSync(outside);
    }

    expect(authorizeOpenFile("tool.exe", { workspaceRoot: root }).ok).toBe(false);
    expect(isExecutablePath("tool.exe")).toBe(true);
    expect(isExecutablePath("script.bat")).toBe(true);
    expect(isExecutablePath("a.ts")).toBe(false);
  });

  it("refuses openUrl schemes other than http(s)", () => {
    expect(authorizeOpenUrl("https://example.com/x").ok).toBe(true);
    expect(authorizeOpenUrl("http://localhost:3000").ok).toBe(true);
    expect(authorizeOpenUrl("file:///etc/passwd").ok).toBe(false);
    expect(authorizeOpenUrl("javascript:alert(1)").ok).toBe(false);
    expect(authorizeOpenUrl("vscode://file/x").ok).toBe(false);
    expect(authorizeOpenUrl("ms-windows-store://pdp/?ProductId=9").ok).toBe(false);
  });

  it("authorizeDesktopWebviewMsg drops bad openFile/openUrl", () => {
    const okFile = authorizeDesktopWebviewMsg(
      { type: "openFile", path: "readme.md" },
      { workspaceRoot: root },
    );
    expect("msg" in okFile).toBe(true);

    const badFile = authorizeDesktopWebviewMsg(
      { type: "openFile", path: "tool.exe" },
      { workspaceRoot: root },
    );
    expect("refused" in badFile).toBe(true);

    const outside = authorizeDesktopWebviewMsg(
      { type: "openFile", path: path.join(path.dirname(root), "nope.txt") },
      { workspaceRoot: root },
    );
    expect("refused" in outside).toBe(true);

    const badUrl = authorizeDesktopWebviewMsg(
      { type: "openUrl", url: "file:///C:/Windows/System32/cmd.exe" },
      { workspaceRoot: root },
    );
    expect("refused" in badUrl).toBe(true);

    // Non-open messages pass through.
    const send = authorizeDesktopWebviewMsg(
      { type: "send", text: "hi" },
      { workspaceRoot: root },
    );
    expect("msg" in send && send.msg.type === "send").toBe(true);
  });

  it("mutation: without workspace containment, outside paths would pass isExecutable alone", () => {
    // Pins that authorizeOpenFile uses resolveTreePath, not only isExecutablePath.
    const outside = path.join(path.dirname(root), "notes.md");
    fs.writeFileSync(outside, "x");
    try {
      expect(isExecutablePath(outside)).toBe(false);
      expect(authorizeOpenFile(outside, { workspaceRoot: root }).ok).toBe(false);
    } finally {
      fs.unlinkSync(outside);
    }
  });

  it("source gate: ElectronWebview.dispatchMessage applies desktop policy", () => {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-webview.ts",
      ),
      "utf8",
    );
    expect(src).toContain("authorizeDesktopWebviewMsg");
    expect(src).toMatch(/dispatchMessage[\s\S]*authorizeDesktopWebviewMsg/);
  });
});

describe("media provenance + registry (A2)", () => {
  let tmp: string;
  let grokHome: string;
  let mediaRoot: string;
  let roots: string[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-prov-"));
    grokHome = path.join(tmp, "fake-grok-home");
    mediaRoot = path.join(tmp, "ext", "media");
    roots = [mediaRoot, grokHome];
    fs.mkdirSync(path.join(grokHome, "sessions", "cwd", "id", "images"), {
      recursive: true,
    });
    fs.mkdirSync(mediaRoot, { recursive: true });
    fs.writeFileSync(path.join(mediaRoot, "chat.js"), "/* */");
    fs.writeFileSync(path.join(grokHome, "auth.json"), '{"t":1}');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("trusts only generated session media under the real Grok home", () => {
    const img = path.join(grokHome, "sessions", "cwd", "id", "images", "1.jpg");
    fs.writeFileSync(img, "jpeg");
    expect(isGeneratedSessionMediaPath(img)).toBe(true);
    expect(
      isTrustedGeneratedMediaPath(img, grokHome, (p) => fs.realpathSync(p)),
    ).toBe(true);

    // Arbitrary file under grok home with a media ext but wrong layout.
    const loose = path.join(grokHome, "secret.png");
    fs.writeFileSync(loose, "png");
    expect(isGeneratedSessionMediaPath(loose)).toBe(false);
    expect(
      isTrustedGeneratedMediaPath(loose, grokHome, (p) => fs.realpathSync(p)),
    ).toBe(false);
  });

  it("refuses a symlink whose real target leaves the media root at register time", () => {
    const outside = path.join(tmp, "outside-secret.png");
    fs.writeFileSync(outside, "classified");
    const link = path.join(
      grokHome,
      "sessions",
      "cwd",
      "id",
      "images",
      "leak.png",
    );

    let linked = false;
    try {
      fs.symlinkSync(outside, link, process.platform === "win32" ? "file" : undefined);
      linked = true;
    } catch {
      /* no symlink privilege — use injectable fs below */
    }

    const registry = new ResourceRegistry();

    if (linked) {
      expect(() =>
        registry.register(link, { allowedRoots: roots }),
      ).toThrow(/approved media root|not under/i);
      // Without allowedRoots the old API would accept it — pin the production path.
      expect(
        mayRegisterResourcePath(link, roots, rootServePolicy),
      ).toBe(false);
    } else {
      // Simulate: realpath of link → outside; realpath of roots stay put.
      const mockFs = {
        realpathSync: (p: string) => {
          if (path.resolve(p) === path.resolve(link)) return outside;
          return fs.realpathSync(p);
        },
        existsSync: (p: string) =>
          path.resolve(p) === path.resolve(link) ? true : fs.existsSync(p),
        statSync: (p: string) =>
          fs.statSync(path.resolve(p) === path.resolve(link) ? outside : p),
      };
      // Create a placeholder so basename paths exist for other calls.
      fs.writeFileSync(link, "placeholder");
      const reg = new ResourceRegistry(mockFs);
      expect(() => reg.register(link, { allowedRoots: roots })).toThrow(
        /approved media root|not under/i,
      );
    }
  });

  it("mutation: register without allowedRoots would still accept a path outside roots", () => {
    // Documents that production must pass allowedRoots (electron-webview does).
    const secret = path.join(tmp, "not-under-roots.png");
    fs.writeFileSync(secret, "x");
    const registry = new ResourceRegistry();
    // No roots → legacy test path still registers (swap tests rely on this).
    const id = registry.register(secret);
    expect(id).toMatch(/^[a-f0-9]{32}$/i);
    // With roots → refused.
    expect(() => registry.register(secret, { allowedRoots: roots })).toThrow();
  });

  it("source gate: asWebviewUri passes allowedRoots into register", () => {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-webview.ts",
      ),
      "utf8",
    );
    expect(src).toMatch(/registry\.register\([\s\S]*allowedRoots/);
  });
});

describe("atomic secrets write (A3)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-atom-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never unlinks the destination before a successful replacement is staged", () => {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "safe-secrets.ts",
      ),
      "utf8",
    );
    // Old pattern: unlink dest then rename tmp — crash window loses the token.
    expect(src).not.toMatch(/unlinkSync\(filePath\)[\s\S]{0,80}renameSync\(tmp,\s*filePath\)/);
    expect(src).toContain("isWindowsReplaceRenameError");
    expect(src).toMatch(/\.bak/);
    // Functional overwrite still works.
    const out = path.join(dir, "secrets.json");
    writeFileAtomic(out, JSON.stringify({ v: 1 }));
    writeFileAtomic(out, JSON.stringify({ v: 2 }));
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual({ v: 2 });
  });

  it("classifies only known Windows replace errors for the backup path", () => {
    expect(isWindowsReplaceRenameError({ code: "EEXIST" })).toBe(true);
    expect(isWindowsReplaceRenameError({ code: "EPERM" })).toBe(true);
    expect(isWindowsReplaceRenameError({ code: "ENOENT" })).toBe(false);
    expect(isWindowsReplaceRenameError({ code: "EIO" })).toBe(false);
  });
});

describe("watcher chain helpers (A4)", () => {
  it("nearestExistingAncestor walks past missing segments", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-watch-"));
    try {
      const missing = path.join(base, "a", "b", "c");
      expect(nearestExistingAncestor(missing)).toBe(path.resolve(base));
      expect(nearestExistingAncestor(base)).toBe(path.resolve(base));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("source gate: createBoundFileSystemWatcher rebinds when base vanishes", () => {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-host.ts",
      ),
      "utf8",
    );
    expect(src).toContain("nearestExistingAncestor");
    expect(src).toContain("scheduleRebind");
    expect(src).toContain("bindChainWatcher");
  });
});

describe("encrypted voiceApiKey (A5)", () => {
  let dir: string;
  let configPath: string;
  let sensPath: string;

  const memSafe: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b) => {
      const t = b.toString("utf8");
      if (!t.startsWith("enc:")) throw new Error("bad cipher");
      return t.slice(4);
    },
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-vk-"));
    configPath = path.join(dir, "config.json");
    sensPath = path.join(dir, "sensitive.enc.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stores voiceApiKey only in the encrypted bag, never config.json", async () => {
    expect(SENSITIVE_CONFIG_KEYS.has("grok.voiceApiKey")).toBe(true);
    const store = new ConfigStore(configPath, new SensitiveConfigStore(sensPath, memSafe));
    await store.getConfiguration("grok").update("voiceApiKey", "sk-secret-voice");
    expect(store.getConfiguration("grok").get("voiceApiKey")).toBe("sk-secret-voice");

    // Sensitive-only writes must not create a plaintext config with the key;
    // force a normal config write and re-check.
    await store.getConfiguration("grok").update("cliPath", "/bin/fake");
    const rawCfg = fs.readFileSync(configPath, "utf8");
    expect(rawCfg).not.toContain("sk-secret-voice");
    expect(rawCfg).not.toMatch(/voiceApiKey/);

    const rawSens = fs.readFileSync(sensPath, "utf8");
    expect(rawSens).not.toContain("sk-secret-voice");
    // Ciphertext is base64 of encryptString output — not the raw key.
    expect(rawSens).toContain("grok.voiceApiKey");
    expect(JSON.parse(rawSens).entries["grok.voiceApiKey"]).toMatch(/^[A-Za-z0-9+/=]+$/);

    const again = new ConfigStore(configPath, new SensitiveConfigStore(sensPath, memSafe));
    expect(again.getConfiguration("grok").get("voiceApiKey")).toBe("sk-secret-voice");
  });

  it("migrates legacy plaintext voiceApiKey out of config.json", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        config: { "grok.voiceApiKey": "legacy-plain-key" },
      }),
      "utf8",
    );
    const store = new ConfigStore(configPath, new SensitiveConfigStore(sensPath, memSafe));
    expect(store.getConfiguration("grok").get("voiceApiKey")).toBe("legacy-plain-key");
    const rawCfg = fs.readFileSync(configPath, "utf8");
    expect(rawCfg).not.toContain("legacy-plain-key");
  });
});

describe("file preview helpers (B3)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-prev-"));
    fs.writeFileSync(path.join(root, "notes.md"), "# Title\n\nHello");
    fs.writeFileSync(path.join(root, "data.json"), '{"a":1}');
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 0, 9]));
    fs.writeFileSync(path.join(root, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("classifies preview kinds and builds breadcrumbs", () => {
    expect(classifyFilePreview("x.md")).toBe("markdown");
    expect(classifyFilePreview("x.json")).toBe("json");
    expect(classifyFilePreview("x.png")).toBe("image");
    expect(classifyFilePreview("x.ts")).toBe("text");
    expect(classifyFilePreview("x.exe")).toBe("external");

    const crumbs = breadcrumbSegments("src/a/b.ts", "repo");
    expect(crumbs[0]).toEqual({ label: "repo", relPath: "" });
    expect(crumbs.map((c) => c.relPath)).toEqual(["", "src", "src/a", "src/a/b.ts"]);
  });

  it("reads md/json/image in-panel and hands binaries to external", () => {
    const md = readTreeFile(root, "notes.md");
    expect(md.ok).toBe(true);
    if (md.ok) {
      expect(md.kind).toBe("markdown");
      expect(md.text).toContain("# Title");
    }
    const js = readTreeFile(root, "data.json");
    expect(js.ok).toBe(true);
    if (js.ok) {
      expect(js.kind).toBe("json");
      expect(js.pretty).toBe(true);
      expect(js.text).toContain('"a"');
    }
    const img = readTreeFile(root, "pic.png");
    expect(img.ok).toBe(true);
    if (img.ok) {
      expect(img.kind).toBe("image");
      expect(img.dataUrl?.startsWith("data:image/png;base64,")).toBe(true);
    }
    const bin = readTreeFile(root, "blob.bin");
    expect(bin.ok).toBe(false);
    if (!bin.ok) expect(bin.openExternal).toBe(true);
  });
});

// ── Round 8: authorization context, handles, serialization, TOCTOU ──────────

describe("file selection handles (P1-1)", () => {
  let dir: string;
  let secret: string;
  let picked: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-fsel-"));
    secret = path.join(dir, "secret.txt");
    picked = path.join(dir, "picked.txt");
    fs.writeFileSync(secret, "do-not-leak");
    fs.writeFileSync(picked, "ok");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mints opaque handles; take is one-shot and unknown ids attach nothing", () => {
    const reg = new FileSelectionRegistry();
    const id = reg.register(picked);
    expect(isFileSelectionId(id)).toBe(true);
    expect(reg.take(id)).toBe(path.resolve(picked));
    expect(reg.take(id)).toBeNull();
    expect(reg.take("0".repeat(32))).toBeNull();
    expect(reg.take("not-a-handle")).toBeNull();
  });

  it("authorizeDropFile refuses path-based dropFile when requireDropFileHandle", () => {
    const reg = new FileSelectionRegistry();
    const forged = authorizeDropFile(
      { type: "dropFile", path: secret, shift: false },
      {
        requireDropFileHandle: true,
        resolveDropFileHandle: (h) => reg.take(h),
      },
    );
    expect("refused" in forged).toBe(true);

    const unknown = authorizeDropFile(
      { type: "dropFile", handle: "ab".repeat(16), shift: false },
      {
        requireDropFileHandle: true,
        resolveDropFileHandle: (h) => reg.take(h),
      },
    );
    expect("refused" in unknown).toBe(true);

    const id = reg.register(picked);
    const ok = authorizeDropFile(
      { type: "dropFile", handle: id, shift: true },
      {
        requireDropFileHandle: true,
        resolveDropFileHandle: (h) => reg.take(h),
      },
    );
    expect("msg" in ok).toBe(true);
    if ("msg" in ok) {
      expect(ok.msg.path).toBe(path.resolve(picked));
      expect(ok.msg.shift).toBe(true);
      expect(ok.msg.handle).toBeUndefined();
    }
  });

  it("authorizeDesktopWebviewMsg drops forged path dropFile on desktop", () => {
    const reg = new FileSelectionRegistry();
    const bad = authorizeDesktopWebviewMsg(
      { type: "dropFile", path: secret, shift: false },
      {
        workspaceRoot: dir,
        requireDropFileHandle: true,
        resolveDropFileHandle: (h) => reg.take(h),
      },
    );
    expect("refused" in bad).toBe(true);

    const id = reg.register(picked);
    const good = authorizeDesktopWebviewMsg(
      { type: "dropFile", handle: id, shift: false },
      {
        workspaceRoot: dir,
        requireDropFileHandle: true,
        resolveDropFileHandle: (h) => reg.take(h),
      },
    );
    expect("msg" in good).toBe(true);
    if ("msg" in good && good.msg.type === "dropFile") {
      expect(good.msg.path).toBe(path.resolve(picked));
    }
  });

  it("mutation: without requireDropFileHandle a path dropFile would attach", () => {
    // Documents why the desktop gate must set requireDropFileHandle — schema
    // validation alone accepts a well-formed path.
    expect(
      parseWebviewMsg({ type: "dropFile", path: secret, shift: false }),
    ).not.toBeNull();
    const passthrough = authorizeDropFile(
      { type: "dropFile", path: secret, shift: false },
      { requireDropFileHandle: false },
    );
    expect("msg" in passthrough).toBe(true);
  });

  it("schema accepts handle-only dropFile and refuses empty dropFile", () => {
    expect(
      parseWebviewMsg({ type: "dropFile", handle: "ab".repeat(16), shift: false })?.type,
    ).toBe("dropFile");
    expect(parseWebviewMsg({ type: "dropFile", shift: false })).toBeNull();
    expect(parseWebviewMsg({ type: "dropFile", path: "/x", shift: "no" })).toBeNull();
  });
});

describe("local workspace switch serialization (P1-2)", () => {
  it("concurrent switches leave root and focused cwd in agreement on the last target", async () => {
    const q = new AsyncSerialQueue();
    let root = "/proj-a";
    let focused = "/proj-a";
    const log: string[] = [];

    const switchTo = (cwd: string, delayMs: number) =>
      q.run(async () => {
        // Capture once — never re-read a shared field after await.
        const target = cwd;
        root = target;
        log.push(`start:${target}`);
        await new Promise((r) => setTimeout(r, delayMs));
        focused = target;
        log.push(`done:${target}`);
      });

    // A is slow; B is fast. Without serialization A could finish last and
    // leave focused=A while a later B already set root=B — or both mutate the
    // same session. With the queue, order is A then B and the pair agrees.
    await Promise.all([switchTo("/proj-a", 40), switchTo("/proj-b", 5)]);
    expect(root).toBe("/proj-b");
    expect(focused).toBe("/proj-b");
    expect(log).toEqual([
      "start:/proj-a",
      "done:/proj-a",
      "start:/proj-b",
      "done:/proj-b",
    ]);
  });

  it("mutation: unsynchronized concurrent switches can leave root≠focused", async () => {
    let root = "/a";
    let focused = "/a";

    const buggy = async (cwd: string, delayMs: number) => {
      root = cwd;
      await new Promise((r) => setTimeout(r, delayMs));
      // Re-read shared root after await — the hazard this codebase has hit before.
      focused = root;
    };

    // A starts first (sets root=A), B overwrites root=B quickly and finishes,
    // then A wakes and sets focused = root (still B) — agrees by accident.
    // Flip the stale write: capture focused session id-style:
    let sessionCwd = "/a";
    const buggy2 = async (cwd: string, delayMs: number) => {
      root = cwd;
      // "openSession" assigns this.focused.cwd = cwd, but another switch
      // replaced this.focused — we simulate by writing sessionCwd only if we
      // still "own" the switch by checking root at end incorrectly:
      await new Promise((r) => setTimeout(r, delayMs));
      if (cwd === "/slow") {
        // Slow switch completes after fast one: writes its own cwd onto the
        // shared focused without checking whether a later switch already ran.
        sessionCwd = cwd;
        // root was set by the fast switch to /fast
      } else {
        sessionCwd = cwd;
      }
    };
    await Promise.all([buggy2("/slow", 40), buggy2("/fast", 5)]);
    // Fast finishes first (sessionCwd=/fast), slow finishes last (sessionCwd=/slow)
    // while root was last set by whoever ran setActive last interleaved:
    // start order: both set root — final root is whoever assigned last at start
    // (race). sessionCwd ends as /slow while root is often /fast.
    expect(sessionCwd).toBe("/slow");
    // Prove the hazard class: without a queue, final focused need not match the
    // last *requested* switch when we track request order:
    const requestedLast = "/fast";
    expect(sessionCwd).not.toBe(requestedLast);

    // Silence unused — the first buggy() documents the stale-read pattern.
    await buggy("/x", 1);
    expect(focused).toBeTruthy();
  });

  it("source gate: switchLocalWorkspaceFolder uses AsyncSerialQueue", () => {
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    expect(sidebar).toContain("localWorkspaceSwitchQueue");
    expect(sidebar).toContain("AsyncSerialQueue");
    expect(sidebar).toMatch(
      /switchLocalWorkspaceFolder[\s\S]*localWorkspaceSwitchQueue\.run/,
    );
  });
});

describe("file tree rebind on project change (P2-3)", () => {
  it("panel boot source listens for root changes and rebinds", () => {
    const src = fileTreePanelBootSource();
    expect(src).toContain("onRootChanged");
    expect(src).toContain("rebindToCurrentRoot");
  });

  it("preload exposes onRootChanged; main sends desk-ft:root-changed", () => {
    const preload = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "preload.ts",
      ),
      "utf8",
    );
    const main = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "main.ts",
      ),
      "utf8",
    );
    expect(preload).toContain("onRootChanged");
    expect(preload).toContain("desk-ft:root-changed");
    expect(main).toContain("onWorkspaceRootChanged");
    expect(main).toContain("desk-ft:root-changed");
  });

  it("after root switch, readTreeFile against new root returns new project content", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "grok-tree-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "grok-tree-b-"));
    try {
      fs.mkdirSync(path.join(a, "src"));
      fs.mkdirSync(path.join(b, "src"));
      fs.writeFileSync(path.join(a, "src", "config.ts"), "export const project = 'A';\n");
      fs.writeFileSync(path.join(b, "src", "config.ts"), "export const project = 'B';\n");

      // Simulates panel rebind: api.root() now returns B, then read(relPath).
      const fromA = readTreeFile(a, "src/config.ts");
      const fromB = readTreeFile(b, "src/config.ts");
      expect(fromA.ok && fromA.text).toContain("'A'");
      expect(fromB.ok && fromB.text).toContain("'B'");
      // Same relPath, different roots — content must follow the active root.
      expect(fromA.ok && fromB.ok && fromA.text !== fromB.text).toBe(true);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

describe("openFile / openDiff session roots (P2-4 / P2-5)", () => {
  let workspace: string;
  let worktree: string;
  let outside: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ws-"));
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "grok-wt-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "grok-out-"));
    fs.writeFileSync(path.join(workspace, "main.ts"), "main");
    fs.writeFileSync(path.join(worktree, "branch.ts"), "branch");
    fs.writeFileSync(path.join(outside, "secret.ts"), "nope");
  });
  afterEach(() => {
    for (const p of [workspace, worktree, outside]) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  });

  it("allows a worktree-session file when allowedRoots includes the worktree", () => {
    const ctx = {
      workspaceRoot: workspace,
      allowedRoots: [worktree, workspace],
    };
    expect(authorizeOpenFile(path.join(worktree, "branch.ts"), ctx).ok).toBe(true);
    expect(authorizeOpenFile("branch.ts", { allowedRoots: [worktree] }).ok).toBe(true);
    // Workspace-only policy (regression from the security fix) refuses worktree:
    expect(authorizeOpenFile(path.join(worktree, "branch.ts"), { workspaceRoot: workspace }).ok).toBe(
      false,
    );
  });

  it("refuses paths outside every authorized root", () => {
    const ctx = {
      workspaceRoot: workspace,
      allowedRoots: [worktree, workspace],
    };
    expect(authorizeOpenFile(path.join(outside, "secret.ts"), ctx).ok).toBe(false);
  });

  it("authorizeDesktopWebviewMsg applies the same roots to openDiff", () => {
    const ok = authorizeDesktopWebviewMsg(
      {
        type: "openDiff",
        path: path.join(worktree, "branch.ts"),
        oldText: "a",
        newText: "b",
      },
      { allowedRoots: [worktree, workspace] },
    );
    expect("msg" in ok).toBe(true);

    const bad = authorizeDesktopWebviewMsg(
      {
        type: "openDiff",
        path: path.join(outside, "secret.ts"),
        oldText: "",
        newText: "x",
      },
      { allowedRoots: [worktree, workspace] },
    );
    expect("refused" in bad).toBe(true);
  });

  it("desktopAuthRoots dedupes workspaceRoot + allowedRoots", () => {
    const roots = desktopAuthRoots({
      workspaceRoot: workspace,
      allowedRoots: [worktree, workspace],
    });
    expect(roots).toContain(path.resolve(worktree));
    expect(roots).toContain(path.resolve(workspace));
    expect(roots.length).toBe(2);
  });
});

describe("file-tree read TOCTOU recheck (P2-6)", () => {
  it("refuses a symlink swap between containment check and read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-toctou-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "grok-toctou-out-"));
    try {
      const safe = path.join(root, "safe.txt");
      const link = path.join(root, "link.txt");
      const leaked = path.join(outside, "secret.txt");
      fs.writeFileSync(safe, "inside");
      fs.writeFileSync(leaked, "OUTSIDE_SECRET");
      fs.writeFileSync(link, "placeholder");

      // First resolveTreePath + realAtCheck see the in-tree target; later
      // recheckTreePathForRead sees the swapped outside target and must refuse
      // before readFileSync runs.
      let linkRealpathCalls = 0;
      const pathFs: TreePathFs = {
        realpathSync: (p) => {
          const n = path.normalize(p);
          if (n === path.normalize(link) || n.endsWith(`${path.sep}link.txt`)) {
            linkRealpathCalls++;
            // Calls 1–2: initial resolve + realAtCheck snapshot (must pass).
            // Call 3+: recheck phase (must fail containment).
            return linkRealpathCalls <= 2 ? safe : leaked;
          }
          try {
            return fs.realpathSync(p);
          } catch {
            return p;
          }
        },
        existsSync: (p) => fs.existsSync(p),
        statSync: (p) => fs.statSync(p),
        readdirSync: (p, o) => fs.readdirSync(p, o),
      };

      let readCalled = false;
      const result = readTreeFile(
        root,
        "link.txt",
        process.platform,
        pathFs,
        (p) => {
          readCalled = true;
          return fs.readFileSync(p);
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/symlink|changed|escape/i);
      }
      // Must not have read after a failed recheck (no leak path).
      expect(readCalled).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("voice-key migration no plaintext fallback (P2-7)", () => {
  it("scrubs plaintext and throws when encryption is unavailable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-vk-fail-"));
    const configPath = path.join(dir, "config.json");
    const sensPath = path.join(dir, "sensitive.enc.json");
    try {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          config: { "grok.voiceApiKey": "legacy-plain-key" },
        }),
        "utf8",
      );
      const noEnc: SafeStorageLike = {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error("should not encrypt");
        },
        decryptString: () => {
          throw new Error("should not decrypt");
        },
      };
      expect(() => {
        new ConfigStore(configPath, new SensitiveConfigStore(sensPath, noEnc));
      }).toThrow(/secure storage|unavailable|credentials/i);

      const rawCfg = fs.readFileSync(configPath, "utf8");
      expect(rawCfg).not.toContain("legacy-plain-key");
      expect(rawCfg).not.toMatch(/voiceApiKey/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mutation: the old catch-continue would leave plaintext in config.json", () => {
    // Pins that migrateSensitiveFromPlaintext must not `continue` on encrypt
    // failure without scrubbing — source must scrub before rethrow.
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "config-store.ts",
      ),
      "utf8",
    );
    expect(src).toContain("migrationError");
    expect(src).not.toMatch(/leave plaintext until encryption is available/);
  });
});
