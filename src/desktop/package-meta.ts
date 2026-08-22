/**
 * Packaged desktop identity.
 *
 * electron-builder's `extraMetadata.name` rewrites the asar `package.json` to
 * `grok-build-desktop`, so `${publisher}.${name}` could never match
 * `OFFICIAL_EXTENSION_ID` and desktop telemetry disabled silently — correct
 * behaviour for a fork, wrong for our own app. Measured 2026-08-22: zero
 * desktop rows in a 56,893-session export.
 *
 * The packaged file therefore carries `grokExtensionName`, which restores the
 * half packaging clobbers. It is deliberately the NAME only, never the whole
 * id: a fork changes `publisher` to publish as itself, and if the full id were
 * baked in, that fork would inherit ours and report into the official project
 * without anyone intending it. Deriving from whatever `publisher` the package
 * actually carries keeps the automatic opt-out a fork has always had.
 */
export const PACKAGED_EXTENSION_NAME_FIELD = "grokExtensionName";

const FALLBACK_PUBLISHER = "PawelHuryn";
const FALLBACK_NAME = "grok-vscode-phuryn";

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function extensionIdFromPackageMeta(pkg: {
  grokExtensionName?: unknown;
  publisher?: unknown;
  name?: unknown;
}): string {
  const publisher = str(pkg.publisher) ?? FALLBACK_PUBLISHER;
  // `grokExtensionName` wins over `name` because packaging overwrites `name`.
  // It does not win over `publisher`, which is the fork signal.
  const name = str(pkg.grokExtensionName) ?? str(pkg.name) ?? FALLBACK_NAME;
  return `${publisher}.${name}`;
}
