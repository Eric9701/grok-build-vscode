/**
 * Ad-hoc sign the packaged macOS app (electron-builder `afterPack` hook).
 *
 * Why this exists: an unsigned build is not merely "unverified" on macOS, it is
 * REFUSED. Repackaging Electron — swapping in app.asar, renaming the bundle —
 * invalidates the signature Electron shipped with, and on Apple silicon a
 * bundle with no valid signature at all cannot be loaded. macOS reports that as
 *
 *   "Grok Build Desktop is damaged and can't be opened. You should move it to
 *    the Trash."
 *
 * which reads as a corrupt download and has no right-click → Open escape. That
 * is what 3.2.2 shipped: electron-builder logged
 * `skipped macOS code signing  reason=identity explicitly is set to null`,
 * and every Mac visitor hit a dead end.
 *
 * An ad-hoc signature (`--sign -`) is a real, self-referential signature with
 * no certificate behind it. It does NOT make the app trusted and it does not
 * remove the Gatekeeper prompt — it makes the bundle loadable, so the prompt
 * becomes the ordinary "Apple could not verify…" one that Open Anyway clears.
 * That is the difference between an app users can run and one they cannot.
 *
 * This stays until there is a Developer ID certificate. At that point signing
 * moves to `mac.identity` + notarisation and this hook goes away — an ad-hoc
 * signature is a floor, not a destination.
 *
 * Deliberately a hook rather than dropping `identity: null`: electron-builder's
 * own fallback to ad-hoc depends on how identity resolution fails, which varies
 * with version and with CSC_IDENTITY_AUTO_DISCOVERY. Signing here is explicit,
 * and it fails the build loudly if codesign does.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  // --deep is discouraged for real Developer ID signing (sign inside-out
  // instead), but for an ad-hoc pass over Electron's helpers and frameworks it
  // is the one call that reaches all of them, and there is no certificate whose
  // scope could be misapplied.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });

  // Prove it took. A silent no-op here would ship the exact bug this prevents,
  // and the failure is invisible until a user on a different machine sees
  // "damaged" — the slowest possible feedback loop.
  execFileSync("codesign", ["--verify", "--strict", "--verbose=2", appPath], {
    stdio: "inherit",
  });

  console.log(`  • ad-hoc signed  ${appName}`);
};
