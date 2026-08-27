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

/**
 * Marks a build made to run as a CLOUD ENVIRONMENT rather than on a desk.
 *
 * Injected by `dist:linux` only. It exists because a packaged build refuses the
 * environment entirely — no relay override, no injected device token, "no
 * token, no uplink, regardless of env" — which is exactly right for an app on
 * somebody's laptop and fatal for a machine with no keyboard, which can only
 * ever be told who it is by the relay that created it.
 *
 * A build-time flag rather than a runtime check, because the alternative was
 * relaxing that guard for every packaged build on the planet to serve machines
 * that are all ours. The mac and Windows installers are unchanged and still
 * cannot be talked into trusting their environment.
 *
 * This is why the Linux AppImage is not offered as a download: it is a build
 * that trusts its environment. Shipping it to a desk would hand that property
 * to people who never asked for it.
 */
export const PACKAGED_CLOUD_BUILD_FIELD = "grokCloudBuild";

/**
 * Whether this package was built for cloud environments.
 *
 * Deliberately strict about what counts as true. electron-builder's
 * `extraMetadata` writes whatever it is given, and a JSON `true` and the string
 * `"true"` both arrive here depending on how the flag was passed — but anything
 * else, including a stray `"false"`, must read as false.
 */
export function isCloudBuildFromPackageMeta(pkg: { grokCloudBuild?: unknown }): boolean {
  return pkg.grokCloudBuild === true || pkg.grokCloudBuild === "true";
}

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
