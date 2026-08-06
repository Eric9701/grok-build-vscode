/**
 * JSON-backed configuration for the desktop host.
 *
 * Keys match VS Code's dotted form (`grok.cliPath`, …). `getConfiguration("grok")`
 * returns a section whose `.get("cliPath")` reads `grok.cliPath`.
 *
 * Credentials (`grok.voiceApiKey`) never live in plaintext config.json — they
 * route through {@link SensitiveConfigStore} (Electron safeStorage ciphertext).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ConfigInspect,
  ConfigTarget,
  HostConfiguration,
  HostConfigurationChangeEvent,
  HostDisposable,
} from "../host";
import type { SafeStorageLike } from "./safe-secrets";
import { writeFileAtomic } from "./safe-secrets";

/** Defaults for keys the sidebar actually reads (mirrors package.json contributes). */
export const CONFIG_DEFAULTS: Readonly<Record<string, unknown>> = {
  "grok.cliPath": "",
  "grok.defaultModel": "",
  "grok.defaultMode": "",
  "grok.includeActiveFileByDefault": true,
  "grok.mentionIndexLimit": 5000,
  "grok.defaultEffort": "",
  "grok.useCtrlEnterToSend": false,
  "grok.terminalShell": "auto",
  "grok.showThinking": false,
  "grok.expandCommandOutputs": false,
  "grok.steerByDefault": false,
  "grok.soundNotifications": false,
  "grok.processingSound": false,
  "grok.readRepliesAloud": false,
  "grok.summarizeRepliesAloud": true,
  "grok.remote.keepAwake": true,
  "grok.telemetry.enabled": true,
  "grok.chatFontScale": 100,
  "grok.voiceApiKey": "",
  "grok.ffmpegPath": "",
  "grok.voiceInputDevice": "",
  "grok.voiceSendPhrase": "grok send",
  "grok.voiceKeyterms": [],
  "grok.voiceLanguage": "",
  "grok.voiceStreaming": true,
};

/** Config keys that must never be written to plaintext config.json. */
export const SENSITIVE_CONFIG_KEYS = new Set(["grok.voiceApiKey"]);

/**
 * Sync encrypted bag for sensitive config keys (same file layout as
 * secrets.enc.json entries, optional separate file). HostConfiguration.get is
 * synchronous, so we cannot await HostSecrets here.
 */
export class SensitiveConfigStore {
  private cache: Record<string, string> = {};

  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageLike,
  ) {
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.cache = {};
        return;
      }
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as {
        v?: number;
        entries?: Record<string, string>;
      };
      if (!raw || raw.v !== 1 || !raw.entries || typeof raw.entries !== "object") {
        this.cache = {};
        return;
      }
      const next: Record<string, string> = {};
      if (!this.safeStorage.isEncryptionAvailable()) {
        this.cache = {};
        return;
      }
      for (const [k, b64] of Object.entries(raw.entries)) {
        if (typeof b64 !== "string") continue;
        try {
          next[k] = this.safeStorage.decryptString(Buffer.from(b64, "base64"));
        } catch {
          /* skip undecryptable */
        }
      }
      this.cache = next;
    } catch {
      this.cache = {};
    }
  }

  private persist(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("OS secure storage is unavailable; cannot store credentials");
    }
    const entries: Record<string, string> = {};
    for (const [k, plain] of Object.entries(this.cache)) {
      entries[k] = this.safeStorage.encryptString(plain).toString("base64");
    }
    writeFileAtomic(this.filePath, JSON.stringify({ v: 1, entries }, null, 2));
  }

  get(key: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(this.cache, key)
      ? this.cache[key]
      : undefined;
  }

  set(key: string, value: string): void {
    if (value === "") {
      this.delete(key);
      return;
    }
    this.cache[key] = value;
    this.persist();
  }

  delete(key: string): void {
    if (!Object.prototype.hasOwnProperty.call(this.cache, key)) return;
    delete this.cache[key];
    this.persist();
  }
}

export interface DesktopAppPrefs {
  /**
   * Absolute path of the **active** workspace folder. Kept for backward
   * compatibility with older config.json files that only had this field.
   */
  workspaceRoot?: string;
  /**
   * All open project folders (desktop multi-folder). When absent, derived from
   * {@link workspaceRoot} alone so a single-folder prefs file still works.
   */
  workspaceRoots?: string[];
  /** Dotted config overrides (e.g. `grok.cliPath`). */
  config: Record<string, unknown>;
}

function rootKey(p: string): string {
  const abs = path.resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function pathsEqualRoot(a: string, b: string): boolean {
  return rootKey(a) === rootKey(b);
}

/** Normalize a folder list: absolute, unique, existing dirs only. */
export function normalizeWorkspaceRoots(
  roots: readonly string[],
  exists: (p: string) => boolean = (p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  resolvePath: (p: string) => string = (p) => path.resolve(p),
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of roots) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const abs = resolvePath(raw.trim());
    const key = process.platform === "win32" ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    if (!exists(abs)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

export class ConfigStore {
  private prefs: DesktopAppPrefs = { config: {} };
  private listeners = new Set<(e: HostConfigurationChangeEvent) => void>();
  private sensitive: SensitiveConfigStore | undefined;

  constructor(
    private readonly filePath: string,
    sensitive?: SensitiveConfigStore,
  ) {
    this.sensitive = sensitive;
    this.load();
  }

  /** Attach encrypted storage after construction (main wires safeStorage). */
  setSensitiveStore(store: SensitiveConfigStore): void {
    this.sensitive = store;
    this.migrateSensitiveFromPlaintext();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        // Still run migration (no-op) when a sensitive store was injected.
        this.migrateSensitiveFromPlaintext();
        return;
      }
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<DesktopAppPrefs>;
      const rootsRaw = Array.isArray(raw.workspaceRoots)
        ? raw.workspaceRoots.filter((r): r is string => typeof r === "string")
        : [];
      const legacy =
        typeof raw.workspaceRoot === "string" && raw.workspaceRoot.trim()
          ? raw.workspaceRoot.trim()
          : undefined;
      // Prefer the multi-folder list; fall back to the single-root field from
      // older builds so a first launch after upgrade keeps the open project.
      const roots = normalizeWorkspaceRoots(
        rootsRaw.length ? rootsRaw : legacy ? [legacy] : [],
      );
      const legacyAbs = legacy ? path.resolve(legacy) : undefined;
      // Keep a recorded active root even when the directory is temporarily
      // missing (tests, offline network share) so prefs don't self-wipe.
      const active =
        legacyAbs && roots.some((r) => pathsEqualRoot(r, legacyAbs))
          ? legacyAbs
          : roots[0] ?? legacyAbs;
      const listed =
        roots.length > 0
          ? roots
          : active
            ? [active]
            : rootsRaw.map((r) => path.resolve(r)).filter(Boolean);
      this.prefs = {
        workspaceRoot: active,
        workspaceRoots: listed.length ? listed : undefined,
        config: raw.config && typeof raw.config === "object" ? { ...raw.config } : {},
      };
    } catch {
      this.prefs = { config: {} };
    }
    // Migration must not share the parse catch — a failed encrypt should scrub
    // the credential and rethrow, not wipe the whole prefs object.
    this.migrateSensitiveFromPlaintext();
  }

  /**
   * One-shot: if a sensitive key still sits in plaintext config (older builds),
   * move it into the encrypted bag and scrub config.json.
   *
   * When encryption fails there is **no** plaintext fallback (same guarantee as
   * safe-secrets): the key is scrubbed from config.json so it is not left at
   * rest indefinitely, and the error is rethrown so startup can fail visibly
   * (user re-enters the key once OS storage works).
   */
  private migrateSensitiveFromPlaintext(): void {
    if (!this.sensitive) return;
    let dirty = false;
    let migrationError: unknown;
    for (const key of SENSITIVE_CONFIG_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(this.prefs.config, key)) continue;
      const plain = this.prefs.config[key];
      if (typeof plain === "string" && plain.length > 0) {
        try {
          // Prefer existing encrypted value; only migrate when bag is empty.
          if (this.sensitive.get(key) === undefined) {
            this.sensitive.set(key, plain);
          }
        } catch (e) {
          // Scrub plaintext either way — never leave credentials in config.json.
          delete this.prefs.config[key];
          dirty = true;
          migrationError = e;
          continue;
        }
      }
      delete this.prefs.config[key];
      dirty = true;
    }
    if (dirty) this.save();
    if (migrationError) throw migrationError;
  }

  private save(): void {
    // Never persist sensitive keys even if a caller stuffed them into config.
    for (const key of SENSITIVE_CONFIG_KEYS) {
      delete this.prefs.config[key];
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.prefs, null, 2), "utf8");
  }

  getWorkspaceRoot(): string | undefined {
    const roots = this.getWorkspaceRoots();
    if (!roots.length) return undefined;
    const active = this.prefs.workspaceRoot?.trim();
    if (active && roots.some((r) => pathsEqualRoot(r, active))) {
      return path.resolve(active);
    }
    return roots[0];
  }

  /** Every open project folder (absolute, deduped). Existing dirs preferred;
   *  the active root is always kept even if temporarily missing on disk. */
  getWorkspaceRoots(): string[] {
    const listed = Array.isArray(this.prefs.workspaceRoots) ? this.prefs.workspaceRoots : [];
    const legacy = this.prefs.workspaceRoot?.trim();
    const combined = listed.length ? listed : legacy ? [legacy] : [];
    const existing = normalizeWorkspaceRoots(combined);
    if (legacy) {
      const abs = path.resolve(legacy);
      if (!existing.some((r) => pathsEqualRoot(r, abs))) {
        return [abs, ...existing];
      }
      // Active first so callers that only use roots[0] still get the selection.
      return [abs, ...existing.filter((r) => !pathsEqualRoot(r, abs))];
    }
    return existing;
  }

  /**
   * Set the active folder, ensuring it is in the open list. Creates a
   * single-folder list when none exists yet (first open / `--workspace=`).
   * The path is recorded even if not yet on disk (caller may create it).
   */
  setWorkspaceRoot(root: string): void {
    const abs = path.resolve(root);
    const roots = this.getWorkspaceRoots().filter((r) => !pathsEqualRoot(r, abs));
    this.prefs.workspaceRoots = [abs, ...roots];
    this.prefs.workspaceRoot = abs;
    this.save();
    this.fireChange("grok.desktop.workspaceFolders");
  }

  /** Make an already-open folder the active one. No-op if unknown. */
  setActiveWorkspaceRoot(root: string): boolean {
    const abs = path.resolve(root);
    const roots = this.getWorkspaceRoots();
    if (!roots.some((r) => pathsEqualRoot(r, abs))) return false;
    if (this.prefs.workspaceRoot && pathsEqualRoot(this.prefs.workspaceRoot, abs)) {
      return true;
    }
    this.prefs.workspaceRoot = abs;
    this.save();
    this.fireChange("grok.desktop.workspaceFolders");
    return true;
  }

  /** Add a project folder and optionally make it active. */
  addWorkspaceRoot(root: string, makeActive = true): boolean {
    const abs = path.resolve(root);
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return false;
    } catch {
      return false;
    }
    const roots = this.getWorkspaceRoots();
    if (!roots.some((r) => pathsEqualRoot(r, abs))) {
      roots.push(abs);
    }
    this.prefs.workspaceRoots = normalizeWorkspaceRoots(roots);
    if (makeActive || !this.prefs.workspaceRoot) {
      this.prefs.workspaceRoot = abs;
    }
    this.save();
    this.fireChange("grok.desktop.workspaceFolders");
    return true;
  }

  /**
   * Remove a project folder. Refuses to remove the last remaining folder.
   * When the active folder is removed, the next open folder becomes active.
   */
  removeWorkspaceRoot(root: string): boolean {
    const abs = path.resolve(root);
    const roots = this.getWorkspaceRoots();
    if (roots.length <= 1) return false;
    const next = roots.filter((r) => !pathsEqualRoot(r, abs));
    if (next.length === roots.length) return false;
    this.prefs.workspaceRoots = next;
    if (!this.prefs.workspaceRoot || pathsEqualRoot(this.prefs.workspaceRoot, abs)) {
      this.prefs.workspaceRoot = next[0];
    }
    this.save();
    this.fireChange("grok.desktop.workspaceFolders");
    return true;
  }

  getValue(fullKey: string): unknown {
    if (SENSITIVE_CONFIG_KEYS.has(fullKey) && this.sensitive) {
      const s = this.sensitive.get(fullKey);
      if (s !== undefined) return s;
      return CONFIG_DEFAULTS[fullKey];
    }
    if (Object.prototype.hasOwnProperty.call(this.prefs.config, fullKey)) {
      return this.prefs.config[fullKey];
    }
    return CONFIG_DEFAULTS[fullKey];
  }

  setValue(fullKey: string, value: unknown): void {
    if (SENSITIVE_CONFIG_KEYS.has(fullKey)) {
      if (this.sensitive) {
        if (value === undefined || value === "") {
          this.sensitive.delete(fullKey);
        } else {
          this.sensitive.set(fullKey, String(value));
        }
        // Scrub any legacy plaintext copy.
        if (Object.prototype.hasOwnProperty.call(this.prefs.config, fullKey)) {
          delete this.prefs.config[fullKey];
          this.save();
        }
      } else if (value === undefined) {
        delete this.prefs.config[fullKey];
        this.save();
      } else {
        // Tests without a sensitive store: still avoid writing the key when
        // empty; non-empty is refused so we never invent a plaintext path.
        if (String(value).length > 0) {
          throw new Error(
            `Sensitive config key "${fullKey}" requires encrypted storage`,
          );
        }
        delete this.prefs.config[fullKey];
        this.save();
      }
      this.fireChange(fullKey);
      return;
    }
    if (value === undefined) {
      delete this.prefs.config[fullKey];
    } else {
      this.prefs.config[fullKey] = value;
    }
    this.save();
    this.fireChange(fullKey);
  }

  private fireChange(fullKey: string): void {
    const event: HostConfigurationChangeEvent = {
      affectsConfiguration(section: string) {
        return fullKey === section || fullKey.startsWith(section + ".");
      },
    };
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* best-effort */
      }
    }
  }

  /** Merge overrides without firing per-key events (startup / test harness). */
  applyOverrides(overrides: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(overrides)) {
      if (SENSITIVE_CONFIG_KEYS.has(k)) {
        if (this.sensitive && typeof v === "string") {
          this.sensitive.set(k, v);
        }
        // Never write sensitive keys into plaintext prefs.
        continue;
      }
      this.prefs.config[k] = v;
    }
    this.save();
  }

  onDidChange(listener: (e: HostConfigurationChangeEvent) => void): HostDisposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * @param section dotted-prefix section (`"grok"` → keys `grok.*`)
   * @param resourcePath unused on desktop (single workspace root; no
   *   multi-folder / language overrides). Accepted so call sites match VS Code.
   */
  getConfiguration(section?: string, resourcePath?: string): HostConfiguration {
    void resourcePath; // single-root desktop store — no resource-scoped values
    const prefix = section ? section + "." : "";
    const store = this;
    return {
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        const fullKey = prefix + key;
        const v = store.getValue(fullKey);
        // Arrow functions do not bind `arguments` to these params — use
        // defaultValue directly (undefined when the caller omitted it).
        if (v === undefined) return defaultValue;
        return v as T;
      },
      update: async (key: string, value: unknown, _target?: ConfigTarget) => {
        store.setValue(prefix + key, value);
      },
      inspect: <T>(key: string): ConfigInspect<T> | undefined => {
        const fullKey = prefix + key;
        const def = CONFIG_DEFAULTS[fullKey] as T | undefined;
        if (SENSITIVE_CONFIG_KEYS.has(fullKey) && store.sensitive) {
          const s = store.sensitive.get(fullKey);
          return {
            key: fullKey,
            defaultValue: def,
            globalValue: s !== undefined ? (s as T) : undefined,
          };
        }
        const has = Object.prototype.hasOwnProperty.call(store.prefs.config, fullKey);
        return {
          key: fullKey,
          defaultValue: def,
          globalValue: has ? (store.prefs.config[fullKey] as T) : undefined,
        };
      },
    };
  }
}
