/**
 * Seti UI file-type icons for the desktop file-tree panel.
 *
 * Icons are vendored from jesseweed/seti-ui (MIT) under media/file-icons/.
 * See docs/attribution.md and media/file-icons/LICENSE-SETI.md.
 *
 * Pure mapping + loaders — no vscode imports.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Basename (no .svg) of a Seti icon we ship. */
export type SetiIconId = string;

/**
 * Resolve a Seti icon id for a tree entry.
 * Directories → `folder`; files by extension / special basename.
 */
export function fileIconId(kind: string, name: string): SetiIconId {
  if (kind === "dir") return "folder";
  const base = (name || "").split(/[/\\]/).pop() || "";
  const lower = base.toLowerCase();

  // Exact basenames (config / lockfiles / common specials).
  const byName: Record<string, SetiIconId> = {
    "package.json": "npm",
    "package-lock.json": "npm",
    "yarn.lock": "yarn",
    "pnpm-lock.yaml": "yarn",
    "cargo.toml": "rust",
    "cargo.lock": "lock",
    "go.mod": "go",
    "go.sum": "go",
    "gemfile": "ruby",
    "gemfile.lock": "lock",
    "dockerfile": "docker",
    "docker-compose.yml": "docker",
    "docker-compose.yaml": "docker",
    "compose.yml": "docker",
    "compose.yaml": "docker",
    makefile: "config",
    "cmakelists.txt": "config",
    "tsconfig.json": "typescript",
    "jsconfig.json": "javascript",
    ".gitignore": "git_ignore",
    ".gitattributes": "git",
    ".gitmodules": "git",
    ".editorconfig": "editorconfig",
    ".eslintrc": "config",
    ".eslintrc.js": "javascript",
    ".eslintrc.cjs": "javascript",
    ".eslintrc.json": "json",
    ".prettierrc": "config",
    ".prettierrc.js": "javascript",
    ".prettierrc.json": "json",
    ".env": "config",
    ".env.local": "config",
    ".env.development": "config",
    ".env.production": "config",
    license: "license",
    "license.md": "license",
    "license.txt": "license",
    "readme.md": "markdown",
    "readme": "markdown",
    "changelog.md": "markdown",
  };
  if (byName[lower]) return byName[lower];

  // Multi-dot / compound extensions first.
  if (lower.endsWith(".d.ts")) return "typescript";
  if (lower.endsWith(".test.ts") || lower.endsWith(".spec.ts")) return "typescript";
  if (lower.endsWith(".test.tsx") || lower.endsWith(".spec.tsx")) return "react";
  if (lower.endsWith(".test.js") || lower.endsWith(".spec.js")) return "javascript";
  if (lower.endsWith(".test.jsx") || lower.endsWith(".spec.jsx")) return "react";
  if (lower.endsWith(".module.css")) return "css";
  if (lower.endsWith(".module.scss") || lower.endsWith(".module.sass")) return "sass";

  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";

  const byExt: Record<string, SetiIconId> = {
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "react",
    ".ts": "typescript",
    ".tsx": "react",
    ".json": "json",
    ".jsonc": "json",
    ".css": "css",
    ".scss": "sass",
    ".sass": "sass",
    ".less": "less",
    ".styl": "stylus",
    ".html": "html",
    ".htm": "html",
    ".xhtml": "html",
    ".vue": "vue",
    ".svelte": "svelte",
    ".md": "markdown",
    ".mdx": "markdown",
    ".markdown": "markdown",
    ".yml": "yml",
    ".yaml": "yml",
    ".xml": "xml",
    ".svg": "svg",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".gif": "image",
    ".webp": "image",
    ".ico": "image",
    ".bmp": "image",
    ".avif": "image",
    ".py": "python",
    ".pyi": "python",
    ".pyw": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".jar": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".hh": "cpp",
    ".cs": "c-sharp",
    ".fs": "f-sharp",
    ".fsx": "f-sharp",
    ".rb": "ruby",
    ".erb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".lua": "lua",
    ".ps1": "powershell",
    ".psm1": "powershell",
    ".psd1": "powershell",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".fish": "shell",
    ".bat": "shell",
    ".cmd": "shell",
    ".pdf": "pdf",
    ".zip": "zip",
    ".gz": "zip",
    ".tgz": "zip",
    ".7z": "zip",
    ".rar": "zip",
    ".tar": "zip",
    ".mp4": "video",
    ".webm": "video",
    ".mov": "video",
    ".avi": "video",
    ".mkv": "video",
    ".mp3": "audio",
    ".wav": "audio",
    ".ogg": "audio",
    ".flac": "audio",
    ".ttf": "font",
    ".otf": "font",
    ".woff": "font",
    ".woff2": "font",
    ".eot": "font",
    ".graphql": "graphql",
    ".gql": "graphql",
    ".prisma": "prisma",
    ".sql": "db",
    ".db": "db",
    ".sqlite": "db",
    ".sqlite3": "db",
    ".toml": "config",
    ".ini": "config",
    ".cfg": "config",
    ".conf": "config",
    ".env": "config",
    ".lock": "lock",
    ".ipynb": "notebook",
    ".hex": "hex",
    ".ex": "elixir",
    ".exs": "elixir",
    ".clj": "clojure",
    ".cljs": "clojure",
    ".cljc": "clojure",
    ".dart": "dart",
    ".elm": "elm",
    ".hs": "haskell",
    ".lhs": "haskell",
    ".ml": "ocaml",
    ".mli": "ocaml",
    ".asm": "asm",
    ".s": "asm",
    ".nim": "nim",
    ".zig": "zig",
    ".cr": "crystal",
    ".vala": "vala",
    ".d": "d",
    ".tf": "terraform",
    ".tfvars": "terraform",
    ".hcl": "terraform",
    ".bicep": "bicep",
    ".res": "rescript",
    ".resi": "rescript",
    ".re": "reasonml",
    ".rei": "reasonml",
    ".ejs": "ejs",
    ".pug": "pug",
    ".jade": "pug",
    ".hbs": "mustache",
    ".mustache": "mustache",
    ".docx": "word",
    ".doc": "word",
    ".rtf": "word",
    ".babelrc": "babel",
    ".webpack.js": "webpack",
    ".gitignore": "git_ignore",
  };
  if (ext && byExt[ext]) return byExt[ext];

  // Dotfiles without a mapped name.
  if (lower.startsWith(".") && !ext) return "config";

  return "default";
}

/** Default path to vendored Seti SVGs next to the package media tree. */
export function defaultFileIconsDir(fromFilename: string = __filename): string {
  // src/desktop/file-icons.ts → ../../media/file-icons
  // out/desktop/file-icons.js → ../../media/file-icons
  const here = path.dirname(fromFilename);
  return path.resolve(here, "..", "..", "media", "file-icons");
}

/**
 * Load Seti SVG files as a map of icon-id → raw SVG markup.
 * Missing files are skipped (caller falls back to `default`).
 */
export function loadSetiIconSvgs(iconsDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  let names: string[];
  try {
    names = fs.readdirSync(iconsDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".svg")) continue;
    const id = name.slice(0, -4);
    try {
      const raw = fs.readFileSync(path.join(iconsDir, name), "utf8").trim();
      if (raw.startsWith("<svg")) out[id] = raw;
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/** Encode SVG for a data: URL (CSP allows data: on img-src). */
export function svgToDataUrl(svg: string): string {
  // Prefer encodeURIComponent over base64 for smaller boot strings on simple paths.
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/**
 * Build the icon map injected into the file-tree boot script:
 * `{ id: dataUrl, ... }` with at least `default` and `folder` when present on disk.
 */
export function buildFileIconDataUrlMap(iconsDir?: string): Record<string, string> {
  const dir = iconsDir ?? defaultFileIconsDir();
  const svgs = loadSetiIconSvgs(dir);
  const map: Record<string, string> = {};
  for (const [id, svg] of Object.entries(svgs)) {
    map[id] = svgToDataUrl(svg);
  }
  return map;
}

/**
 * Seti ships two kinds of glyph: coloured ones carrying an explicit
 * `fill="#rrggbb"` (js yellow, css blue…), and plain ones carrying none.
 * SVG defaults a missing fill to BLACK, and a data-URL `<img>` cannot inherit
 * `currentColor` — so the plain third of the set rendered near-invisible on a
 * dark theme (`.dockerignore`, but also rust, swift, kotlin, vue, pdf, lock,
 * db, settings…). These are the ids the renderer must paint itself, as a mask
 * tinted with the row's own text colour: legible in BOTH themes, and still
 * legible when the theme changes at runtime.
 *
 * Detected, not listed — a hand-kept list would silently miss the next icon
 * added to the vendored set.
 */
export function isMonochromeIconSvg(svg: string): boolean {
  return !/\bfill\s*=\s*["'](?!none["'])[^"']+["']/i.test(svg);
}

/** Ids from {@link buildFileIconDataUrlMap} that need `currentColor` tinting. */
export function monochromeIconIds(iconsDir?: string): string[] {
  const svgs = loadSetiIconSvgs(iconsDir ?? defaultFileIconsDir());
  return Object.entries(svgs)
    .filter(([, svg]) => isMonochromeIconSvg(svg))
    .map(([id]) => id)
    .sort();
}

/**
 * Pure: pick a data-URL for a tree entry from a preloaded map.
 * Falls back to `default`, then empty string.
 */
export function resolveFileIconSrc(
  kind: string,
  name: string,
  icons: Record<string, string>,
): { id: string; src: string } {
  const id = fileIconId(kind, name);
  const src = icons[id] || icons.default || "";
  return { id, src };
}
