/**
 * HostSecrets backed by OS keychain encryption (Electron safeStorage).
 *
 * Ciphertext is stored on disk; the key material never is. When encryption is
 * unavailable there is **no** plaintext fallback — store/get throw visibly.
 *
 * Writes are atomic (temp file in the same directory, then rename) so a crash
 * mid-write cannot leave a truncated secrets file that would drop the device
 * token (forced relink rather than a silent empty store).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { HostSecrets } from "../host";

/** Subset of Electron's safeStorage used here (injectable for tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class EncryptionUnavailableError extends Error {
  readonly code = "ENCRYPTION_UNAVAILABLE" as const;
  constructor(
    message = "OS secure storage is unavailable. Device credentials cannot be stored safely on this machine.",
  ) {
    super(message);
    this.name = "EncryptionUnavailableError";
  }
}

interface SecretsFile {
  /** key → base64 ciphertext */
  v: 1;
  entries: Record<string, string>;
}

function readFile(filePath: string): SecretsFile {
  try {
    if (!fs.existsSync(filePath)) return { v: 1, entries: {} };
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<SecretsFile>;
    if (raw && raw.v === 1 && raw.entries && typeof raw.entries === "object") {
      return { v: 1, entries: { ...raw.entries } };
    }
    return { v: 1, entries: {} };
  } catch {
    return { v: 1, entries: {} };
  }
}

/**
 * True when `err` is the Windows "cannot rename onto existing file" case
 * (EEXIST / EPERM). Other errors must not take the replace fallback — a crash
 * or AV lock must not leave the destination deleted.
 */
export function isWindowsReplaceRenameError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | undefined;
  if (!e || typeof e !== "object") return false;
  const code = e.code;
  // Windows: EPERM when dest exists; EEXIST on some Node builds; EXDEV rare.
  return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}

/**
 * Atomic write: write to a unique temp file in the same directory, then rename
 * over the destination.
 *
 * On Windows, rename fails when the target exists. The fallback is
 * rename-dest-to-backup → rename-tmp-to-dest → unlink-backup — never
 * unlink-dest-then-rename, which can leave neither file present if the
 * second rename fails or the process dies. Non-replace errors rethrow with
 * the original destination intact and the temp cleaned up.
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${process.pid}.${Date.now()}`;
  const tmp = path.join(dir, `.${path.basename(filePath)}.${stamp}.tmp`);
  const bak = path.join(dir, `.${path.basename(filePath)}.${stamp}.bak`);
  try {
    fs.writeFileSync(tmp, data, "utf8");
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (renameErr) {
      // Only the known Windows "dest exists" case may take the backup path.
      if (process.platform !== "win32" || !isWindowsReplaceRenameError(renameErr)) {
        throw renameErr;
      }
      if (!fs.existsSync(filePath)) {
        // Dest vanished between attempts — plain rename of tmp should work.
        fs.renameSync(tmp, filePath);
        return;
      }
      // Move live file aside first so a crash still leaves bak or tmp, never neither.
      try {
        fs.renameSync(filePath, bak);
      } catch (bakErr) {
        throw bakErr;
      }
      try {
        fs.renameSync(tmp, filePath);
      } catch (finalErr) {
        // Restore previous secrets file so we never lose the token.
        try {
          if (fs.existsSync(bak) && !fs.existsSync(filePath)) {
            fs.renameSync(bak, filePath);
          }
        } catch {
          /* best-effort restore */
        }
        throw finalErr;
      }
      try {
        fs.unlinkSync(bak);
      } catch {
        /* bak leftover is harmless ciphertext */
      }
    }
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw e;
  }
}

function writeFile(filePath: string, data: SecretsFile): void {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

function requireEncryption(safeStorage: SafeStorageLike): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new EncryptionUnavailableError();
  }
}

/**
 * Create a HostSecrets that encrypts every value with `safeStorage` before
 * writing to `filePath`. Fails hard when encryption is unavailable.
 */
export function createSafeStorageSecrets(
  filePath: string,
  safeStorage: SafeStorageLike,
): HostSecrets {
  return {
    async get(key: string) {
      const data = readFile(filePath);
      const b64 = data.entries[key];
      if (typeof b64 !== "string") return undefined;
      // Stored ciphertext needs the OS key to decrypt — refuse if unavailable.
      requireEncryption(safeStorage);
      try {
        return safeStorage.decryptString(Buffer.from(b64, "base64"));
      } catch (e) {
        throw new Error(
          `Failed to decrypt secret "${key}": ${(e as Error)?.message ?? e}`,
        );
      }
    },
    async store(key: string, value: string) {
      requireEncryption(safeStorage);
      const data = readFile(filePath);
      const encrypted = safeStorage.encryptString(value);
      data.entries[key] = encrypted.toString("base64");
      writeFile(filePath, data);
    },
    async delete(key: string) {
      // Dropping ciphertext does not need the OS key — allow unlink/recovery
      // even when encryption later becomes unavailable. store/get still fail hard.
      const data = readFile(filePath);
      if (!Object.prototype.hasOwnProperty.call(data.entries, key)) return;
      delete data.entries[key];
      writeFile(filePath, data);
    },
  };
}
