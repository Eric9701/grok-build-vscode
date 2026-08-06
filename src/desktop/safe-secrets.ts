/**
 * HostSecrets backed by OS keychain encryption (Electron safeStorage).
 *
 * Ciphertext is stored on disk; the key material never is. When encryption is
 * unavailable there is **no** plaintext fallback — store/get throw visibly.
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

function writeFile(filePath: string, data: SecretsFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
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
