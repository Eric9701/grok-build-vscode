import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGY_MANAGED_VERSION,
  agyManagedBinaryPath,
  agyManagedFileNames,
  agyManagedRelease,
  agyManagedRoot,
  extractZipFile,
  installManagedAgy,
  locateAgyServer,
} from "../src/agy-managed-installer";
import type { CodexDownload } from "../src/codex-managed-installer";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "grok-agy-managed-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

type Entry = { name: string; body?: Buffer; method?: 0 | 8; flags?: number; zip64?: boolean };

/** A minimal zip writer: local headers, central directory, end record. */
function zip(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = entry.body ?? Buffer.alloc(0);
    const method = entry.method ?? 8;
    const data = method === 8 && body.length ? deflateRawSync(body) : body;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(entry.flags ?? 0, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(entry.zip64 ? 0xffffffff : data.length, 20);
    record.writeUInt32LE(body.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function serverZip(platform: NodeJS.Platform): Buffer {
  const names = agyManagedFileNames(platform);
  return zip([
    { name: names.server, body: Buffer.from("server ".repeat(5000)) },
    { name: names.harness, body: Buffer.from("harness ".repeat(5000)) },
  ]);
}

function fakeDownload(archive: Buffer): CodexDownload {
  return async (_url, destination, _signal, progress) => {
    await fs.promises.writeFile(destination, archive, { flag: "wx" });
    progress({ receivedBytes: archive.length, totalBytes: archive.length });
    return sha256(archive);
  };
}

// Computed from the archives on Google's download host when the pin was taken
// (the registry publishes none). A second copy on purpose, so an edited digest
// in the source fails here rather than shipping.
const releases = [
  ["win32", "x64", "windows/agy-acp-server-1.4.0-windows-x86_64.zip", "d737aad2d6388e071bc907db415c129a256915d275f436e68f10dcdf6af896da", 125646049],
  ["win32", "arm64", "windows/agy-acp-server-1.4.0-windows-arm64.zip", "37fac14835f06caf05b4b93fed59a0e16e7c716e3ec95f03d4779a61abe3c2e6", 126083066],
  ["darwin", "arm64", "macos/agy-acp-server-1.4.0-darwin-arm64.zip", "21a32eeab85b394a515510c84539bda4b2504bf2917e0a201f5c4130b13581a5", 112734313],
  ["darwin", "x64", "macos/agy-acp-server-1.4.0-darwin-x86_64.zip", "407b6b8ef167bb207d1effdbd488bacf63ba7dab2b47d4a47d8ea3710a8c0f55", 118343529],
  ["linux", "x64", "linux/agy-acp-server-1.4.0-linux-x86_64.zip", "fbb2d54dd94fb897845308d3b6b46187c627f1c60078ded81adeeaf8b90c5d7a", 336175910],
  ["linux", "arm64", "linux/agy-acp-server-1.4.0-linux-arm64.zip", "3dc43a21f5402b23a4dba7b320a6745e9dbf4b6ead912ce9fc76011ea3a08a7e", 321912925],
] as const;

describe("managed Antigravity release", () => {
  it.each(releases)("pins %s/%s to Google's archive and digest", (platform, arch, asset, digest, size) => {
    expect(agyManagedRelease(platform, arch)).toMatchObject({
      url: `https://dl.google.com/agy-extensions/releases/${asset}`, sha256: digest, size,
    });
  });

  it("has nothing for platforms Google does not ship", () => {
    expect(agyManagedRelease("freebsd", "x64")).toBeUndefined();
    expect(agyManagedRelease("linux", "ia32")).toBeUndefined();
  });

  it("names the executables per platform", () => {
    expect(agyManagedFileNames("win32")).toEqual({ server: "agy_acp_server.exe", harness: "localharness_external.exe" });
    expect(agyManagedFileNames("darwin")).toEqual({ server: "agy_acp_server.par", harness: "localharness_external" });
    expect(agyManagedFileNames("linux")).toEqual({ server: "agy_acp_server.par", harness: "localharness_external" });
  });
});

describe("managed Antigravity install", () => {
  it.each(["win32", "linux", "darwin"] as const)("unpacks both binaries side by side for %s", async (platform) => {
    const storageRoot = await tempRoot();
    const archive = serverZip(platform);
    const phases: string[] = [];
    const binary = await installManagedAgy({
      storageRoot, platform, arch: "x64", signal: new AbortController().signal, download: fakeDownload(archive),
      release: { target: "t", sha256: sha256(archive), size: archive.length, url: "https://example.invalid/a.zip" },
      onProgress: (phase) => { if (phases.at(-1) !== phase) phases.push(phase); },
    });
    const names = agyManagedFileNames(platform);
    expect(binary).toBe(agyManagedBinaryPath(storageRoot, platform));
    expect(path.dirname(binary)).toBe(path.join(agyManagedRoot(storageRoot), AGY_MANAGED_VERSION));
    expect(fs.readFileSync(binary, "utf8")).toBe("server ".repeat(5000));
    expect(fs.readFileSync(path.join(path.dirname(binary), names.harness), "utf8")).toBe("harness ".repeat(5000));
    expect(phases).toEqual(["downloading", "verifying", "installing"]);
    // Nothing but the version directory is left behind.
    expect(fs.readdirSync(agyManagedRoot(storageRoot))).toEqual([AGY_MANAGED_VERSION]);
    if (process.platform !== "win32" && platform !== "win32") {
      expect(fs.statSync(binary).mode & 0o111).not.toBe(0);
      expect(fs.statSync(path.join(path.dirname(binary), names.harness)).mode & 0o111).not.toBe(0);
    }
  });

  it("reports progress against the pinned size, not a compressed Content-Length", async () => {
    const storageRoot = await tempRoot();
    const archive = serverZip("win32");
    const download: CodexDownload = async (_url, destination, _signal, progress) => {
      await fs.promises.writeFile(destination, archive, { flag: "wx" });
      progress({ receivedBytes: archive.length, totalBytes: archive.length - 100 });
      return sha256(archive);
    };
    const totals: (number | undefined)[] = [];
    await installManagedAgy({
      storageRoot, platform: "win32", arch: "x64", signal: new AbortController().signal, download,
      release: { target: "t", sha256: sha256(archive), size: archive.length, url: "https://example.invalid/a.zip" },
      onProgress: (_phase, value) => { if (value) totals.push(value.totalBytes); },
    });
    expect(totals).toEqual([archive.length, archive.length]);
  });

  it("rejects an archive whose digest does not match, and leaves nothing behind", async () => {
    const storageRoot = await tempRoot();
    const archive = serverZip("win32");
    await expect(installManagedAgy({
      storageRoot, platform: "win32", arch: "x64", signal: new AbortController().signal, download: fakeDownload(archive),
      release: { target: "t", sha256: "0".repeat(64), size: archive.length, url: "https://example.invalid/a.zip" },
    })).rejects.toThrow(/SHA-256/);
    expect(fs.existsSync(agyManagedBinaryPath(storageRoot, "win32"))).toBe(false);
    expect(fs.readdirSync(agyManagedRoot(storageRoot))).toEqual([]);
  });

  it("rejects a verified archive without the harness beside the server", async () => {
    const storageRoot = await tempRoot();
    const archive = zip([{ name: "agy_acp_server.exe", body: Buffer.from("x") }]);
    await expect(installManagedAgy({
      storageRoot, platform: "win32", arch: "x64", signal: new AbortController().signal, download: fakeDownload(archive),
      release: { target: "t", sha256: sha256(archive), size: archive.length, url: "https://example.invalid/a.zip" },
    })).rejects.toThrow(/layout/);
    expect(fs.readdirSync(agyManagedRoot(storageRoot))).toEqual([]);
  });

  it("stops when cancelled before unpacking", async () => {
    const storageRoot = await tempRoot();
    const archive = serverZip("win32");
    const controller = new AbortController();
    const download: CodexDownload = async (...args) => {
      const hash = await fakeDownload(archive)(...args);
      controller.abort(new Error("Installation cancelled."));
      return hash;
    };
    await expect(installManagedAgy({
      storageRoot, platform: "win32", arch: "x64", signal: controller.signal, download,
      release: { target: "t", sha256: sha256(archive), size: archive.length, url: "https://example.invalid/a.zip" },
    })).rejects.toThrow(/cancelled/);
    expect(fs.existsSync(agyManagedBinaryPath(storageRoot, "win32"))).toBe(false);
  });

  it("removes a superseded version once the pinned one is in place", async () => {
    const storageRoot = await tempRoot();
    await fs.promises.mkdir(path.join(agyManagedRoot(storageRoot), "1.3.0"), { recursive: true });
    const archive = serverZip("win32");
    await installManagedAgy({
      storageRoot, platform: "win32", arch: "x64", signal: new AbortController().signal, download: fakeDownload(archive),
      release: { target: "t", sha256: sha256(archive), size: archive.length, url: "https://example.invalid/a.zip" },
    });
    expect(fs.readdirSync(agyManagedRoot(storageRoot))).toEqual([AGY_MANAGED_VERSION]);
  });
});

describe("zip extraction", () => {
  async function extract(entries: Entry[]): Promise<{ root: string; files: string[] }> {
    const root = await tempRoot();
    const file = path.join(root, "a.zip");
    await fs.promises.writeFile(file, zip(entries));
    const files = await extractZipFile(file, path.join(root, "out"));
    return { root, files };
  }

  it("streams stored and deflated entries, directories and empty files", async () => {
    const { root, files } = await extract([
      { name: "dir/" },
      { name: "dir/stored.txt", body: Buffer.from("stored"), method: 0 },
      { name: "deflated.bin", body: Buffer.alloc(200_000, 7) },
      { name: "empty.txt" },
    ]);
    expect(files.map((file) => path.relative(path.join(root, "out"), file).replace(/\\/g, "/")).sort())
      .toEqual(["deflated.bin", "dir/stored.txt", "empty.txt"]);
    expect(fs.readFileSync(path.join(root, "out", "dir", "stored.txt"), "utf8")).toBe("stored");
    expect(fs.readFileSync(path.join(root, "out", "deflated.bin")).equals(Buffer.alloc(200_000, 7))).toBe(true);
  });

  it("refuses entries that would land outside the destination", async () => {
    await expect(extract([{ name: "../evil.txt", body: Buffer.from("x") }])).rejects.toThrow(/Unsafe/);
    await expect(extract([{ name: "/abs.txt", body: Buffer.from("x") }])).rejects.toThrow(/Unsafe/);
  });

  it("refuses what the pinned archives never use", async () => {
    await expect(extract([{ name: "a", body: Buffer.from("x"), flags: 1 }])).rejects.toThrow(/Encrypted/);
    await expect(extract([{ name: "a", body: Buffer.from("x"), zip64: true }])).rejects.toThrow(/ZIP64/);
    const root = await tempRoot();
    const file = path.join(root, "not.zip");
    await fs.promises.writeFile(file, "not a zip at all, just some text that is long enough");
    await expect(extractZipFile(file, path.join(root, "out"))).rejects.toThrow(/Not a zip/);
  });
});

describe("locating the Antigravity server", () => {
  const storage = path.join("/storage");
  const pinned = agyManagedBinaryPath(storage, "win32");
  const old = path.join(agyManagedRoot(storage), "1.3.0", "agy_acp_server.exe");

  it("prefers the configured path and never second-guesses a wrong one", () => {
    expect(locateAgyServer({ configuredPath: "C:\\mine\\agy_acp_server.exe", managedStorageRoot: storage, platform: "win32", isFile: () => true }))
      .toBe("C:\\mine\\agy_acp_server.exe");
    expect(locateAgyServer({ configuredPath: "C:\\missing.exe", managedStorageRoot: storage, platform: "win32", isFile: (file) => file === pinned }))
      .toBeUndefined();
  });

  it("finds the pinned install, then one a previous pin left, then nothing", () => {
    expect(locateAgyServer({ managedStorageRoot: storage, platform: "win32", isFile: (file) => file === pinned })).toBe(pinned);
    expect(locateAgyServer({ managedStorageRoot: storage, platform: "win32", isFile: (file) => file === old, readDir: () => ["1.3.0", ".tmp"] })).toBe(old);
    expect(locateAgyServer({ managedStorageRoot: storage, platform: "win32", isFile: () => false, readDir: () => [] })).toBeUndefined();
    expect(locateAgyServer({ platform: "win32", isFile: () => true })).toBeUndefined();
  });
});
