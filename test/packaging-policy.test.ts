/**
 * Packaging policy — marketplace description vs GitHub README, and VSIX
 * exclusion of the desktop app. These silently regress at publish time if the
 * scripts or ignore rules drift, so they are pinned here.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

describe("marketplace vs GitHub README", () => {
  const github = read("README.md");
  const marketplace = read("README.marketplace.md");
  const pkg = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };

  it("GitHub README covers Grok Build Desktop and both hosts", () => {
    expect(github).toMatch(/Grok Build Desktop/);
    expect(github).toMatch(/VS Code extension/i);
    expect(github).toMatch(/GitHub Releases/);
    expect(github).toMatch(/Grok-Build-Desktop-<version>-mac-arm64\.dmg/);
    expect(github).toMatch(/Grok-Build-Desktop-<version>-win-x64\.exe/);
  });

  it("marketplace README is extension-only (no desktop app product)", () => {
    // Product name for the standalone Electron host — must not appear in the
    // VS Code Marketplace listing (noise for people installing an extension).
    expect(marketplace).not.toMatch(/Grok Build Desktop/i);
    expect(marketplace).not.toMatch(/desktop app/i);
    expect(marketplace).not.toMatch(/standalone Electron/i);
    expect(marketplace).not.toMatch(/npm run dist/i);
    expect(marketplace).not.toMatch(/dist-desktop/i);
    expect(marketplace).not.toMatch(/electron-builder/i);
    // Still names the extension product and community framing.
    expect(marketplace).toMatch(/Grok Build for VS Code \(Community\)/);
    expect(marketplace).toMatch(/not affiliated with or endorsed by xAI/i);
    expect(marketplace).toMatch(/AFK Pilot/);
  });

  it("package and publish always pass --readme-path README.marketplace.md", () => {
    // Fail-closed: if someone reverts to bare `vsce package`, the GitHub
    // dual-host README becomes the store description by accident.
    expect(pkg.scripts.package).toMatch(
      /--readme-path\s+README\.marketplace\.md/,
    );
    expect(pkg.scripts.publish).toMatch(
      /--readme-path\s+README\.marketplace\.md/,
    );
    // Must not package without an explicit marketplace path.
    expect(pkg.scripts.package).not.toBe("npx @vscode/vsce package");
    expect(pkg.scripts.publish).not.toBe("npx @vscode/vsce publish");
  });

  it("pins @vscode/vsce in devDependencies (no floating npx fetch on package)", () => {
    const full = JSON.parse(read("package.json")) as {
      devDependencies?: Record<string, string>;
      scripts: Record<string, string>;
    };
    // Clean CI/release builds must use the locked binary, not whatever
    // `npx @vscode/vsce` resolves on the network that day.
    // Exact pin (no caret/tilde) so lockfile + package.json agree on the tool.
    expect(full.devDependencies?.["@vscode/vsce"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(full.scripts.package).toMatch(/^vsce package\b/);
    expect(full.scripts.publish).toMatch(/^vsce publish\b/);
    // Mutation: dropping the dep while keeping `npx @vscode/vsce` reopens float.
    expect(full.scripts.package).not.toMatch(/npx\s+@vscode\/vsce/);
  });
});

describe("VSIX excludes desktop app", () => {
  const vscodeignore = read(".vscodeignore");
  const pkg = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };

  it(".vscodeignore excludes desktop sources, launcher, and dist output", () => {
    expect(vscodeignore).toMatch(/^\s*out\/desktop\/\*\*/m);
    expect(vscodeignore).toMatch(/^\s*src\/desktop\/\*\*/m);
    expect(vscodeignore).toMatch(/^\s*scripts\/run-desktop\.cjs\s*$/m);
    expect(vscodeignore).toMatch(/^\s*vitest\.desktop\.config\.ts\s*$/m);
    expect(vscodeignore).toMatch(/^\s*electron-builder\.yml\s*$/m);
    expect(vscodeignore).toMatch(/^\s*dist-desktop\/\*\*/m);
    // Both readmes excluded as files; vsce embeds marketplace content only.
    expect(vscodeignore).toMatch(/^\s*README\.marketplace\.md\s*$/m);
    expect(vscodeignore).toMatch(/^\s*README\.md\s*$/m);
    // Trap: `!out/**/*.js` re-includes out/desktop/** and later exclude rules
    // do not win under vsce — only top-level out/*.js may be un-ignored.
    expect(vscodeignore).toMatch(/^\s*!out\/\*\.js\s*$/m);
    expect(vscodeignore).not.toMatch(/^\s*!out\/\*\*\/\*\.js\s*$/m);
  });

  it("desktop dist scripts exist and do not replace npm run package", () => {
    expect(pkg.scripts["dist:win"]).toMatch(/electron-builder/);
    expect(pkg.scripts["dist:mac"]).toMatch(/electron-builder/);
    expect(pkg.scripts.dist).toMatch(/electron-builder/);
    expect(pkg.scripts.package).toMatch(/\bvsce package\b/);
  });
});

describe("desktop artifact naming (electron-builder.yml)", () => {
  const yml = read("electron-builder.yml");

  it("uses the stable Grok-Build-Desktop-${version}-${os}-${arch}.${ext} pattern", () => {
    expect(yml).toMatch(
      /artifactName:\s*Grok-Build-Desktop-\$\{version\}-\$\{os\}-\$\{arch\}\.\$\{ext\}/,
    );
    expect(yml).toMatch(/productName:\s*Grok Build Desktop/);
    expect(yml).toMatch(/extraMetadata:[\s\S]*main:\s*out\/desktop\/main\.js/);
    // Unsigned by design until certificates exist.
    expect(yml).toMatch(/identity:\s*null/);
    expect(yml).toMatch(/signAndEditExecutable:\s*false/);
  });
});
