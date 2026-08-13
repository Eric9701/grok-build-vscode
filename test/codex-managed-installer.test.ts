import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_MANAGED_TAG,
  codexManagedBinaryPath,
  codexManagedRelease,
  codexManagedTarget,
  downloadCodexAsset,
  extractTarFile,
  installManagedCodex,
  parseTarHeader,
  tarRegularFileMode,
  type CodexDownload,
} from "../src/codex-managed-installer";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "grok-codex-managed-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

function tarHeader(name: string, size: number, type = "0", mode = 0o755): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function tar(entries: Array<{ name: string; body?: Buffer; type?: string; mode?: number }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    chunks.push(tarHeader(entry.name, body.length, entry.type, entry.mode));
    chunks.push(body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

const releases = [
  ["win32", "x64", "x86_64-pc-windows-msvc", "c156c8feb8cb20197bf74d2c6daffed1fec0a8c21a03bc2ca90d7ff81927b0c5"],
  ["win32", "arm64", "aarch64-pc-windows-msvc", "4533928d72ac4d7c19f16e8c4acdfd02dc255d2aeeb2f6d7dfd45493ec4c0806"],
  ["darwin", "x64", "x86_64-apple-darwin", "d91e59133daf923bc45d76e3da4af8ae9ef62a0231da18488da0cd573b6e9d63"],
  ["darwin", "arm64", "aarch64-apple-darwin", "17b2984eb22b607e3d0c25728252fc90f510e476bad39a6d9f45cdb1aa685432"],
  ["linux", "x64", "x86_64-unknown-linux-musl", "bd758d53d56e41dc65e045f4589df79a038ed197a011adcb52a258e6ad64cfda"],
  ["linux", "arm64", "aarch64-unknown-linux-musl", "89cbf79bd5ae6f9c58da47e8079f311c84219350c9c43c070d42f3e9b2a81401"],
] as const;

describe("managed Codex release selection", () => {
  it.each(releases)("pins %s/%s to the official target, URL, and digest", (platform, arch, target, sha256) => {
    expect(codexManagedTarget(platform, arch)).toBe(target);
    expect(codexManagedRelease(platform, arch)).toEqual({
      target,
      sha256,
      asset: `codex-package-${target}.tar.gz`,
      url: `https://github.com/openai/codex/releases/download/${CODEX_MANAGED_TAG}/codex-package-${target}.tar.gz`,
    });
  });

  it("refuses unsupported targets instead of guessing", () => {
    expect(codexManagedRelease("freebsd", "x64")).toBeUndefined();
    expect(codexManagedRelease("linux", "ia32")).toBeUndefined();
  });
});

describe("managed Codex tar reader", () => {
  it("parses verified 512-byte headers and extracts regular and empty files", async () => {
    const root = await temporaryRoot();
    const archive = path.join(root, "package.tar");
    const bytes = tar([
      { name: "./", type: "5" },
      { name: "package/bin/codex", body: Buffer.from("binary") },
      { name: "package/empty", body: Buffer.alloc(0) },
    ]);
    await fs.promises.writeFile(archive, bytes);
    expect(parseTarHeader(bytes.subarray(512, 1024))).toMatchObject({ name: "package/bin/codex", size: 6, type: "0" });
    const destination = path.join(root, "out");
    const files = await extractTarFile(archive, destination);
    expect(files.map((file) => path.relative(destination, file))).toEqual([
      path.join("package", "bin", "codex"),
      path.join("package", "empty"),
    ]);
    expect(await fs.promises.readFile(files[0], "utf8")).toBe("binary");
  });

  it("rejects corrupt headers and traversal before writing outside the destination", async () => {
    const root = await temporaryRoot();
    const corrupt = tarHeader("codex", 0);
    corrupt[12] ^= 1;
    expect(() => parseTarHeader(corrupt)).toThrow("checksum");
    const archive = path.join(root, "unsafe.tar");
    await fs.promises.writeFile(archive, tar([{ name: "../escape/codex", body: Buffer.from("bad") }]));
    await expect(extractTarFile(archive, path.join(root, "out"))).rejects.toThrow("Unsafe tar entry path");
    expect(fs.existsSync(path.join(root, "escape"))).toBe(false);
  });

  it("preserves executable mode bits for regular helper files on POSIX and ignores them on Windows", async () => {
    const root = await temporaryRoot();
    const archive = path.join(root, "helpers.tar");
    await fs.promises.writeFile(archive, tar([
      { name: "package/bin/codex-code-mode-host", body: Buffer.from("helper"), mode: 0o755 },
    ]));

    const posixFiles = await extractTarFile(archive, path.join(root, "posix"), "linux");
    const windowsFiles = await extractTarFile(archive, path.join(root, "windows"), "win32");
    expect(tarRegularFileMode(0o10755, "linux")).toBe(0o755);
    expect(tarRegularFileMode(0o755, "win32")).toBeUndefined();
    if (process.platform !== "win32") {
      expect((await fs.promises.stat(posixFiles[0])).mode & 0o777).toBe(0o755);
      expect((await fs.promises.stat(windowsFiles[0])).mode & 0o111).toBe(0);
    }
  });
});

describe("managed Codex atomic install", () => {
  function fakePackageDownload(bytes: Buffer): CodexDownload {
    return async (_url, destination, signal, progress) => {
      if (signal.aborted) throw signal.reason;
      await fs.promises.writeFile(destination, bytes, { flag: "wx" });
      progress({ receivedBytes: bytes.length, totalBytes: bytes.length });
      return createHash("sha256").update(bytes).digest("hex");
    };
  }

  it("verifies before unpacking and atomically publishes the canonical executable", async () => {
    const root = await temporaryRoot();
    const packageBytes = gzipSync(tar([
      { name: "codex-package/codex-package.json", body: Buffer.from('{"version":"0.147.0"}') },
      { name: "codex-package/bin/codex", body: Buffer.from("managed-codex") },
      { name: "codex-package/codex-resources/bwrap", body: Buffer.from("helper") },
    ]));
    const sha256 = createHash("sha256").update(packageBytes).digest("hex");
    const phases: string[] = [];
    const installed = await installManagedCodex({
      storageRoot: root,
      platform: "linux",
      arch: "x64",
      signal: new AbortController().signal,
      release: { target: "test", asset: "test.tar.gz", url: "https://example.invalid/test", sha256 },
      download: fakePackageDownload(packageBytes),
      onProgress: (phase) => phases.push(phase),
    });
    expect(installed).toBe(codexManagedBinaryPath(root, "linux"));
    expect(await fs.promises.readFile(installed, "utf8")).toBe("managed-codex");
    expect(await fs.promises.readFile(path.join(path.dirname(path.dirname(installed)), "codex-resources", "bwrap"), "utf8"))
      .toBe("helper");
    if (process.platform !== "win32") expect((await fs.promises.stat(installed)).mode & 0o111).toBeTruthy();
    expect(phases).toContain("verifying");
    expect(phases).toContain("installing");
    expect((await fs.promises.readdir(path.join(root, "codex-managed"))).sort()).toEqual([CODEX_MANAGED_TAG]);
  });

  it.each([
    ["offline download", async () => {
      throw new Error("offline");
    }],
    ["checksum mismatch", async (destination: string) => {
      await fs.promises.writeFile(destination, "untrusted", { flag: "wx" });
      return "0".repeat(64);
    }],
    ["partial download/cancel", async (destination: string) => {
      await fs.promises.writeFile(destination, "partial", { flag: "wx" });
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    }],
    ["disk write failure", async () => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }],
  ] as Array<[string, CodexDownload]>)
  ("cleans every staging artifact after %s", async (_label, download) => {
    const root = await temporaryRoot();
    await expect(installManagedCodex({
      storageRoot: root,
      platform: "linux",
      arch: "x64",
      signal: new AbortController().signal,
      release: { target: "test", asset: "test.tar.gz", url: "https://example.invalid/test", sha256: "f".repeat(64) },
      download,
    })).rejects.toThrow();
    const managed = path.join(root, "codex-managed");
    expect(fs.existsSync(managed) ? await fs.promises.readdir(managed) : []).toEqual([]);
  });

  it("honors cancellation and removes a partially streamed archive", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const download: CodexDownload = async (_url, destination, signal) => {
      await fs.promises.writeFile(destination, "partial", { flag: "wx" });
      controller.abort(new Error("cancelled by user"));
      throw signal.reason;
    };
    await expect(installManagedCodex({
      storageRoot: root,
      platform: "linux",
      arch: "x64",
      signal: controller.signal,
      release: { target: "test", asset: "test.tar.gz", url: "https://example.invalid/test", sha256: "f".repeat(64) },
      download,
    })).rejects.toThrow("cancelled by user");
    expect(await fs.promises.readdir(path.join(root, "codex-managed"))).toEqual([]);
  });

  it("streams response chunks to disk while hashing and reporting byte progress", async () => {
    const root = await temporaryRoot();
    const destination = path.join(root, "download");
    const chunks = [Buffer.from("first-"), Buffer.from("second")];
    const progress: number[] = [];
    const hash = await downloadCodexAsset(
      "https://example.invalid/package",
      destination,
      new AbortController().signal,
      (value) => progress.push(value.receivedBytes),
      async () => new Response(new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }), { status: 200, headers: { "content-length": "12" } }) as Awaited<ReturnType<typeof fetch>>,
    );
    const bytes = Buffer.concat(chunks);
    expect(await fs.promises.readFile(destination)).toEqual(bytes);
    expect(hash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(progress).toEqual([6, 12]);
  });

  it("reports HTTP failures without creating a download file", async () => {
    const root = await temporaryRoot();
    const destination = path.join(root, "download");
    await expect(downloadCodexAsset(
      "https://example.invalid/missing",
      destination,
      new AbortController().signal,
      () => {},
      async () => new Response(null, { status: 404 }) as Awaited<ReturnType<typeof fetch>>,
    )).rejects.toThrow("HTTP 404");
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("rejects an asynchronous output-stream failure while a network chunk is pending", async () => {
    const root = await temporaryRoot();
    const destination = path.join(root, "missing-parent", "download");
    await expect(downloadCodexAsset(
      "https://example.invalid/package",
      destination,
      new AbortController().signal,
      () => {},
      async () => new Response(new ReadableStream({
        start() {
          // Keep reader.read() pending while createWriteStream reports ENOENT.
        },
      }), { status: 200 }) as Awaited<ReturnType<typeof fetch>>,
    )).rejects.toMatchObject({ code: "ENOENT" });
  });
});
