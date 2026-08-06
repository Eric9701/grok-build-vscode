/**
 * JSON-backed configuration for the desktop host.
 *
 * Keys match VS Code's dotted form (`grok.cliPath`, …). `getConfiguration("grok")`
 * returns a section whose `.get("cliPath")` reads `grok.cliPath`.
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

export interface DesktopAppPrefs {
  /** Absolute path of the single workspace folder. */
  workspaceRoot?: string;
  /** Dotted config overrides (e.g. `grok.cliPath`). */
  config: Record<string, unknown>;
}

export class ConfigStore {
  private prefs: DesktopAppPrefs = { config: {} };
  private listeners = new Set<(e: HostConfigurationChangeEvent) => void>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<DesktopAppPrefs>;
      this.prefs = {
        workspaceRoot: typeof raw.workspaceRoot === "string" ? raw.workspaceRoot : undefined,
        config: raw.config && typeof raw.config === "object" ? { ...raw.config } : {},
      };
    } catch {
      this.prefs = { config: {} };
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.prefs, null, 2), "utf8");
  }

  getWorkspaceRoot(): string | undefined {
    const root = this.prefs.workspaceRoot?.trim();
    return root || undefined;
  }

  setWorkspaceRoot(root: string): void {
    this.prefs.workspaceRoot = root;
    this.save();
  }

  getValue(fullKey: string): unknown {
    if (Object.prototype.hasOwnProperty.call(this.prefs.config, fullKey)) {
      return this.prefs.config[fullKey];
    }
    return CONFIG_DEFAULTS[fullKey];
  }

  setValue(fullKey: string, value: unknown): void {
    if (value === undefined) {
      delete this.prefs.config[fullKey];
    } else {
      this.prefs.config[fullKey] = value;
    }
    this.save();
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
