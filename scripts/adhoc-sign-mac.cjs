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
 * Release builds no longer come through here: CI has a Developer ID certificate
 * and electron-builder signs and notarises. What is left is the local case this
 * was written for — a dev build on a Mac with no certificate — so the hook is
 * gated rather than deleted. An ad-hoc signature is a floor, not a destination.
 *
 * Deliberately a hook rather than leaning on electron-builder: its own fallback
 * to ad-hoc depends on how identity resolution fails, which varies with version
 * and with CSC_IDENTITY_AUTO_DISCOVERY. Signing here is explicit, and it fails
 * the build loudly if codesign does.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * Will electron-builder sign this build for real, after this hook runs? Two ways
 * it can: CSC_LINK (how CI supplies the .p12), or a Developer ID identity in the
 * keychain — which is literally what its auto-discovery looks for, so the owner's
 * own Mac now hits this path too. Either way, ad-hoc signing first would be
 * overwritten at best, and `--deep` over nested helpers before a real inside-out
 * pass corrupts their signatures at worst.
 */
function realSigningConfigured() {
  if (process.env.CSC_LINK) return true;
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false") return false;
  try {
    const identities = execFileSync(
      "security",
      ["find-identity", "-v", "-p", "codesigning"],
      { encoding: "utf8" },
    );
    return identities.includes("Developer ID Application");
  } catch {
    return false;
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (realSigningConfigured()) return;

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
