/**
 * Desktop light/dark preference — pure file helpers (legacy / optional host use).
 *
 * The main renderer now loads over a real `app-resource://` origin and stores
 * the theme in `localStorage` (`grok-desktop-theme`), same as rail shape and
 * the file-tree panel. These helpers remain for unit tests and any host-side
 * tooling that still wants a userData snapshot; they are not on the live path.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type DesktopTheme = "dark" | "light";

export const DESKTOP_THEME_FILENAME = "desktop-theme.json";

export function desktopThemeFilePath(userDataDir: string): string {
  return path.join(userDataDir, DESKTOP_THEME_FILENAME);
}

/** Parse a saved preference; anything else → undefined (caller applies OS default). */
export function parseDesktopTheme(raw: unknown): DesktopTheme | undefined {
  if (raw === "dark" || raw === "light") return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const t = (raw as { theme?: unknown }).theme;
    if (t === "dark" || t === "light") return t;
  }
  return undefined;
}

export function readDesktopThemeFile(userDataDir: string): DesktopTheme | undefined {
  try {
    const text = fs.readFileSync(desktopThemeFilePath(userDataDir), "utf8");
    return parseDesktopTheme(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function writeDesktopThemeFile(userDataDir: string, theme: DesktopTheme): void {
  const file = desktopThemeFilePath(userDataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ theme }, null, 0), "utf8");
}

/**
 * Resolve the theme to apply: saved preference wins; otherwise OS preference.
 * `osDark` mirrors `nativeTheme.shouldUseDarkColors` / prefers-color-scheme.
 */
export function resolveDesktopTheme(
  saved: DesktopTheme | undefined,
  osDark: boolean,
): DesktopTheme {
  if (saved) return saved;
  return osDark ? "dark" : "light";
}
