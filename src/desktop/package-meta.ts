/**
 * Packaged desktop identity. electron-builder's `extraMetadata.name` rewrites
 * the asar `package.json` to `grok-build-desktop`, so `${publisher}.${name}`
 * no longer matches `OFFICIAL_EXTENSION_ID` and telemetry would silently
 * disable. The packaged file carries `grokExtensionId` explicitly; a fork
 * that changes or drops that field falls back to the derived id and opts out.
 */
export const PACKAGED_EXTENSION_ID_FIELD = "grokExtensionId";

export function extensionIdFromPackageMeta(pkg: {
  grokExtensionId?: unknown;
  publisher?: unknown;
  name?: unknown;
}): string {
  if (typeof pkg.grokExtensionId === "string") {
    const id = pkg.grokExtensionId.trim();
    if (id) return id;
  }
  const publisher = typeof pkg.publisher === "string" && pkg.publisher.trim()
    ? pkg.publisher.trim()
    : "PawelHuryn";
  const name = typeof pkg.name === "string" && pkg.name.trim()
    ? pkg.name.trim()
    : "grok-vscode-phuryn";
  return `${publisher}.${name}`;
}
