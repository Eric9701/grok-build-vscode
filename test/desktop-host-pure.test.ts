/**
 * Pure desktop helpers (no Electron process) — safe for npm test / CI.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "../src/desktop/config-store";
import {
  buildDiffViewerHtml,
  buildTextViewerHtml,
  escapeHtml,
  interpretOpenPathResult,
  resolveDocumentText,
} from "../src/desktop/document-view";
import {
  asAppResourceUrl,
  appResourceUrlToFsPath,
  APP_RESOURCE_CSP_SOURCE,
} from "../src/desktop/electron-webview";
import { Uri } from "../src/host";
import { findFilesUnder } from "../src/desktop/find-files";
import {
  createSafeStorageSecrets,
  EncryptionUnavailableError,
  type SafeStorageLike,
} from "../src/desktop/safe-secrets";
import {
  appResourceMayServe,
  isGeneratedSessionMediaPath,
  rootServePolicy,
} from "../src/desktop/app-resource-policy";
import {
  planOpenCliInTerminal,
  planRunCommandInTerminal,
} from "../src/desktop/external-terminal";
import {
  FILE_TREE_MAX_ENTRIES,
  listTreeDir,
  resolveTreePath,
  type TreePathFs,
} from "../src/desktop/file-tree";
import { isIpcFromMainWindow } from "../src/desktop/file-tree-ipc";
import { FILE_TREE_PANEL_CSS, fileTreePanelBootSource } from "../src/desktop/file-tree-panel";

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
    store.setWorkspaceRoot("/tmp/ws");
    expect(new ConfigStore(file).getWorkspaceRoot()).toBe("/tmp/ws");
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
  const grokHome = path.join(os.tmpdir(), "fake-grok-home");
  const mediaRoot = path.join(os.tmpdir(), "ext", "media");
  const staging = path.join(os.tmpdir(), "globalStorage", "image-staging");
  const roots = [mediaRoot, staging, grokHome];

  it("classifies Grok home as media-only and extension media as full", () => {
    expect(rootServePolicy(grokHome)).toBe("media-only");
    expect(rootServePolicy(mediaRoot)).toBe("full");
    expect(rootServePolicy(staging)).toBe("full");
  });

  it("refuses auth.json and other non-media paths under Grok home", () => {
    const auth = path.join(grokHome, "auth.json");
    expect(appResourceMayServe(auth, roots)).toBe(false);
    expect(
      appResourceMayServe(path.join(grokHome, "config.toml"), roots),
    ).toBe(false);
    expect(
      appResourceMayServe(
        path.join(grokHome, "sessions", "cwd", "id", "chat_history.jsonl"),
        roots,
      ),
    ).toBe(false);
  });

  it("allows generated session media under Grok home", () => {
    const img = path.join(
      grokHome,
      "sessions",
      encodeURIComponent("C:\\repo"),
      "abc-id",
      "images",
      "1.jpg",
    );
    const vid = path.join(
      grokHome,
      "sessions",
      "cwd",
      "id",
      "videos",
      "1.mp4",
    );
    expect(isGeneratedSessionMediaPath(img)).toBe(true);
    expect(appResourceMayServe(img, roots)).toBe(true);
    expect(appResourceMayServe(vid, roots)).toBe(true);
  });

  it("allows extension media and image staging", () => {
    expect(appResourceMayServe(path.join(mediaRoot, "chat.js"), roots)).toBe(true);
    expect(appResourceMayServe(path.join(staging, "image-uuid.png"), roots)).toBe(true);
  });

  it("mutation: lexical-only root check would serve auth.json", () => {
    // Simulate the pre-fix isPathAllowed (containment under roots only).
    const auth = path.join(grokHome, "auth.json");
    const lexicalOnly = roots.some((r) => {
      const rel = path.relative(r, auth);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    expect(lexicalOnly).toBe(true);
    expect(appResourceMayServe(auth, roots)).toBe(false);
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

  it("main.ts validates webview-to-host sender", () => {
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    expect(main).toMatch(/webview-to-host[\s\S]*event\.sender\.id/);
    expect(main).toContain("getMainWindow");
  });
});

describe("file-tree panel assets", () => {
  it("scopes CSS under desk-ft- and boots without chat.js symbols", () => {
    expect(FILE_TREE_PANEL_CSS).toContain(".desk-ft-panel");
    expect(FILE_TREE_PANEL_CSS).toContain("desk-ft-collapsed");
    // No unprefixed layout hijacks of chat primitives.
    expect(FILE_TREE_PANEL_CSS).not.toMatch(/(?:^|\n)\.messages\s*\{/);
    expect(FILE_TREE_PANEL_CSS).not.toMatch(/(?:^|\n)\.composer\s*\{/);

    const boot = fileTreePanelBootSource();
    expect(boot).toContain("grokDesktopFileTree");
    expect(boot).toContain("desk-ft-panel");
    expect(boot).toContain("desk-ft-toggle");
    expect(boot).toContain("localStorage");
    // Does not call into acquireVsCodeApi / Host message bus.
    expect(boot).not.toContain("acquireVsCodeApi");
    expect(boot).not.toContain("openFile");
  });
});
