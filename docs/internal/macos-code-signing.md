# macOS code signing + notarisation — implementation handoff

**Status: fully wired; unverified until a signed build ships.** Secrets and repo
changes are all in place, so the next *Desktop installers* dispatch is the first
run that produces a signed, notarised `.dmg`. Nothing here has been proven
against a real artefact yet — that is §4, and it is not optional.

This file is the complete spec for turning Grok Build Desktop from an
ad-hoc-signed build that Gatekeeper blocks into a signed, notarised one that
opens on first double-click.

Written to be executed from a macOS session. All paths are **repo-relative** —
run everything from the repo root, wherever it happens to be checked out.

---

## 1. Where things stand

| | |
|---|---|
| Apple Developer Program | enrolled, **Individual** (`O=Pawel Huryn, C=PL`) |
| Developer ID Application cert | issued 2026-08-08, valid to **2031-08-09**, G2 sub-CA |
| Team ID | **`L6TFKRX6QQ`** |
| App Store Connect API key | created — `.p8` + Key ID + Issuer ID held by the owner |
| Certificate installed locally | done — valid identity in the login keychain |
| All five repository secrets (§2) | done |
| Repo changes (§3) | done |
| Verified against a published `.dmg` (§4) | **not yet** |

The private key for the certificate lives in the **login keychain of the Mac
that generated the CSR**. It is not in the repo and not on the Windows box.
Everything in §3 depends on that key being present locally.

### The intermediate CA is a separate install, and its absence looks fatal

A fresh Developer ID certificate arrives without the CA that issued it. Import
the `.cer` on a Mac that has never held one and `security find-identity -v` says
**`0 valid identities found`** — which reads exactly like "the private key is on
another machine", the one failure this whole thing cannot recover from. It is
not. Drop the `-v` and the identity is listed; it is merely *invalid*, because
the chain does not reach a trusted root:

```bash
security find-identity -p codesigning        # lists it — key and cert are paired
security find-identity -v -p codesigning     # 0 valid — chain is broken, not the key
curl -fsSLO https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
security import DeveloperIDG2CA.cer -k ~/Library/Keychains/login.keychain-db
```

Diagnose with the un-`-v` form **before** concluding the key is missing.

### There is no App ID and no provisioning profile

Deliberate, not an omission. App IDs and profiles are for Mac App Store
distribution and for capabilities that require a profile. This app ships as a
Developer-ID-signed `.dmg` from its own download page, which needs neither. The
`appId` in `electron-builder.yml` is written into the bundle's `Info.plist` and
is registered with nobody.

---

## 2. Do the secrets first

Land the secrets **before** the config change reaches a dispatch. The
alternative — conditional notarisation so an unsigned build still passes — costs
more complexity than it saves, and the credentials are already in hand.

The failure if you skip ahead is not a skipped signature, it is a **red build**:
with the API-key secrets present and `CSC_LINK` absent, the runner has no
identity, so the app ends up ad-hoc signed and notarisation then rejects it.

Five repository secrets on `phuryn/grok-build-vscode`, all set:

| Secret | Value |
|---|---|
| `CSC_LINK` | base64 of the exported `.p12` |
| `CSC_KEY_PASSWORD` | the password set during export |
| `APPLE_API_KEY` | full contents of `AuthKey_<KeyID>.p8` |
| `APPLE_API_KEY_ID` | the 10-char Key ID |
| `APPLE_API_ISSUER` | the Issuer ID (UUID) |

Key ID and Issuer ID are handed over out of band — they are not in this file on
purpose. Team ID is here because it is not a secret: it is embedded in every
signed binary and readable from any download with `codesign -dv`.

`APPLE_API_KEY` holds the key's **text**, but electron-builder passes that env
var straight to `notarytool --key`, which wants a **path**. The workflow bridges
the two (§3d) — do not "fix" the secret to hold a path instead; a repository
secret cannot be a file.

### Producing the `.p12` (Mac-only, cannot be done anywhere else)

Kept as the recipe for the next time it is needed — a new machine, or the 2031
renewal. Expect friction if an agent session runs it: exporting a private key
out of a keychain looks identical to exfiltration, so it needs the owner to
approve it explicitly rather than being waved through.

```bash
# Confirm the identity is valid first. If it says 0 valid, see §1 — it is almost
# certainly the missing intermediate CA, not a missing private key.
security find-identity -v -p codesigning
#   1) 8F44…  "Developer ID Application: Pawel Huryn (L6TFKRX6QQ)"

# Export outside the repo. Choose a password; you will need it twice.
security export -k ~/Library/Keychains/login.keychain-db \
  -t identities -f pkcs12 -o ~/DeveloperID.p12
```

Keychain Access does the same thing if you prefer the GUI: **My Certificates** →
expand the identity's triangle, confirm a private key sits beneath it →
right-click → **Export** → **Personal Information Exchange (.p12)**.

```bash
base64 -i ~/DeveloperID.p12 | gh secret set CSC_LINK --repo phuryn/grok-build-vscode
gh secret set CSC_KEY_PASSWORD --repo phuryn/grok-build-vscode   # prompts; paste the export password
rm ~/DeveloperID.p12
```

macOS `base64` has no `-w` flag; that is the Linux one. Never write the base64
to a file inside the repo, and never paste key material into a chat session.

electron-builder imports the `.p12` into a throwaway keychain on the runner and
adds Apple's intermediates itself, so the export does not need to carry the
chain — §1's intermediate problem is local-only.

#### Check the export before uploading it, and check it the right way

`openssl pkcs12` will refuse the file: `security export` still writes legacy
RC2-40-CBC encryption, which OpenSSL 3 rejects outright as an *unsupported
algorithm*. That is not a corrupt export and it says nothing about CI, which
never touches openssl. Verify the way the runner does instead — import into a
throwaway keychain and confirm a **valid** identity comes back:

```bash
security create-keychain -p testpass /tmp/verify.keychain
security unlock-keychain -p testpass /tmp/verify.keychain
security import ~/DeveloperID.p12 -k /tmp/verify.keychain -P "$PW" -T /usr/bin/codesign
security find-identity -p codesigning /tmp/verify.keychain   # expect 1 valid
security delete-keychain /tmp/verify.keychain
```

A fingerprint matching the login keychain's identity means the export carries
the private key, which is the only thing that can silently be missing.

---

## 3. The four repo changes — **landed**

All four are in the tree; this section is now the reasoning behind them rather
than a to-do list. Two of them shipped differently from the spec below, and both
deviations are called out where they occur (3b, 3c, 3d).

### 3a. New file — `resources/entitlements.mac.plist`

Hardened runtime is mandatory for notarisation, and it disables things Electron
needs. Without these the app is rejected or crashes on launch.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- V8 compiles at runtime; without these the renderer dies immediately. -->
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>

  <!-- Voice input. media/chat.js calls getUserMedia and the desktop host
       captures audio; under hardened runtime that fails without this. -->
  <key>com.apple.security.device.audio-input</key><true/>
</dict>
</plist>
```

`com.apple.security.cs.disable-library-validation` is deliberately **absent** —
it weakens the runtime and the bundled deps (`ws`, `jpeg-js`) are pure JS with
no native `.node` files. Add it only if a real launch failure names library
validation, never pre-emptively.

### 3b. `electron-builder.yml` — the `mac:` block

Remove `identity: null`. Add:

```yaml
mac:
  icon: resources/grok-icon-round-512.png
  category: public.app-category.developer-tools
  hardenedRuntime: true
  entitlements: resources/entitlements.mac.plist
  entitlementsInherit: resources/entitlements.mac.plist
  notarize:
    teamId: L6TFKRX6QQ
  extendInfo:
    NSMicrophoneUsageDescription: >-
      Grok Build Desktop uses the microphone for voice input in chat.
  target:
    # …unchanged
```

`entitlementsInherit` is not redundant. Electron's helper processes inherit
their entitlements separately, and omitting it is the classic "main process
starts, window is blank" failure.

`NSMicrophoneUsageDescription` is not optional either. Requesting the microphone
with no usage string does not prompt the user — macOS **terminates the
process**. It presents as a crash, not as a permissions problem.

Update the comment block above `mac:` — it currently explains why there is no
certificate, which stops being true.

**Shipped as `notarize: true`, not `notarize.teamId`.** electron-builder 25
deprecated the config field and warns on it (*"Please specify notarization Team
ID in the `APPLE_TEAM_ID` env var instead"*), and on the API-key path it does not
use the team ID at all. `APPLE_TEAM_ID` is set in the workflow instead, where it
documents the team without producing a warning on every build. `true` here means
only "do not skip": with no credentials in the environment — any local build —
electron-builder logs that it skipped notarisation and carries on.

### 3c. `scripts/adhoc-sign-mac.cjs` — guard it, don't delete it

The hook runs `codesign --force --deep --sign -`. With a real certificate in
play that is actively harmful: `--deep` is discouraged by Apple for genuine
signing, and the hook fires **before** electron-builder's own signing pass.

It still earns its place for local unsigned dev builds on a Mac with no
certificate — that is the case it was written for, and removing it would bring
back the "damaged and can't be opened" failure 3.2.2 shipped. So gate it:

```js
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  // Real signing is configured — electron-builder will sign inside-out with the
  // Developer ID identity after this hook. Ad-hoc signing first would be
  // overwritten at best and would corrupt nested helper signatures at worst.
  if (process.env.CSC_LINK) return;

  // …existing ad-hoc path unchanged
```

**Shipped with a wider guard than `CSC_LINK` alone.** `CSC_LINK` only covers CI.
The moment the certificate is installed locally — which §1 has now done —
electron-builder's auto-discovery finds it in the keychain and signs a local
`npm run dist:mac` for real too, with no env var involved, and the hook would
have ad-hoc `--deep` signed it first. So the guard asks the question
electron-builder actually asks: `CSC_LINK` set, or a *Developer ID Application*
identity in the keychain and `CSC_IDENTITY_AUTO_DISCOVERY` not turned off.

### 3d. `.github/workflows/desktop-release.yml`

The build step currently forces signing **off**:

```yaml
        env:
          CSC_IDENTITY_AUTO_DISCOVERY: false
```

Replace the whole `env:` block with:

```yaml
        env:
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
          APPLE_TEAM_ID: L6TFKRX6QQ
```

These are harmless on the Windows leg (empty and ignored), so one `env:` on the
matrix step is fine — no need to branch per OS.

**`APPLE_API_KEY` is deliberately not in that block.** The original spec put it
there, holding the key's contents. That does not work: electron-builder forwards
the variable verbatim to `notarytool --key`, which expects a **path to the .p8**
and fails on a PEM blob. A repository secret cannot hold a file, so a macOS-only
step writes the secret to `$RUNNER_TEMP/AuthKey.p8` and exports the path through
`$GITHUB_ENV`. The build step must then *not* declare `APPLE_API_KEY` itself —
step-level `env` outranks `$GITHUB_ENV` and would put the raw contents back.

`$RUNNER_TEMP` rather than the workspace: nothing can package it by accident,
and it dies with the runner.

Also update the header comment: the "Nothing is signed… no Apple Developer
certificate" paragraph becomes wrong the moment this lands, and that comment is
the first thing the next person reads.

---

## 4. Verifying — do not skip to "the workflow was green"

A green workflow means the build succeeded. It does not mean the result opens on
someone else's Mac.

**Run the script; it does all of this and prints PASS or FAIL with the reason:**

```bash
./scripts/verify-mac-signing.sh ~/Downloads/Grok-Build-Desktop-<ver>-mac-arm64.dmg
```

The rest of this section is what it checks and why, not a second procedure to
follow by hand.

```bash
# Signed with the real identity, hardened runtime on
codesign -dv --verbose=4 "/Applications/Grok Build Desktop.app"
#   Authority=Developer ID Application: Pawel Huryn (L6TFKRX6QQ)   ← not "-"
#   flags=0x10000(runtime)                                          ← hardened

# Structurally sound, all the way down through the helpers
codesign --verify --deep --strict --verbose=2 "/Applications/Grok Build Desktop.app"

# The one that actually predicts what a user sees
spctl -a -vvv -t install "/Applications/Grok Build Desktop.app"
#   accepted
#   source=Notarized Developer ID

# Ticket is stapled, so first launch works with no network
xcrun stapler validate "/Applications/Grok Build Desktop.app"
```

When notarisation is rejected, `xcrun notarytool log <submission-id>` names the
offending binary and reason precisely. Read it rather than guessing.

**Test the way a user gets it.** Download the `.dmg` over HTTPS onto a Mac that
never built it, then open it. The quarantine flag is set on download, so a
locally built copy passes even when the shipped artefact would not — that is
exactly how 3.2.2 escaped.

### Acceptance criteria

1. `spctl` reports `accepted` / `source=Notarized Developer ID`.
2. A freshly downloaded `.dmg` opens with **no** Gatekeeper dialog of any kind.
3. Voice input still works — record something and confirm audio reaches the
   model. This is the entitlement most likely to be silently wrong.
4. Windows installers are byte-for-byte unaffected: same icons, same NSIS flow.

---

## 5. Consequences elsewhere, once this ships

Both of these become **false** the moment a notarised build is published, and
stale unblock instructions read as "you did it wrong" rather than "we are out of
date":

- `docs/desktop.md` § *Unsigned installs — what users see* → the whole macOS
  subsection, including the "damaged and can't be opened" recovery.
- The download page and the in-app update page on **afkpilot.com** → both carry
  per-OS unblock steps and the `xattr -dr com.apple.quarantine` escape hatch.
  Those live in the web repo, not here; flag them, do not edit them from a
  session scoped to this repo.

Windows is unchanged and stays unsigned for now — SmartScreen reputation is
earned through download volume, and since Microsoft dropped EV's automatic
reputation in 2024 there is no certificate that removes that warning outright.
Notarisation is the macOS-only win, and it is the bigger one: Gatekeeper is a
hard block, SmartScreen is a click-through.

---

## 6. Release ordering

Nothing here touches the wire protocol, the extension, or the relay, so the
usual relay-ships-first invariant does not apply. But the signed build is only
visible to users once installers are attached to a release, so:

1. Land these changes on `main`.
2. Cut the release tag as normal.
3. Dispatch **Desktop installers** with `release_tag` set — that is the first
   run that will produce signed artefacts.
4. Verify §4 against the **published** `.dmg`, not a local build.
5. Only then update the unblock copy listed in §5.

Step 4 before step 5. Rewriting the instructions first and finding the build
still blocked leaves users with no working guidance at all.
