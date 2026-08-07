# macOS code signing + notarisation — implementation handoff

**Status: credentials exist, nothing is wired yet.** This file is the complete
spec for turning Grok Build Desktop from an ad-hoc-signed build that Gatekeeper
blocks into a signed, notarised one that opens on first double-click.

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
| Repo wiring | **none of it done** — that is this task |

The private key for the certificate lives in the **login keychain of the Mac
that generated the CSR**. It is not in the repo and not on the Windows box.
Everything in §3 depends on that key being present locally.

### There is no App ID and no provisioning profile

Deliberate, not an omission. App IDs and profiles are for Mac App Store
distribution and for capabilities that require a profile. This app ships as a
Developer-ID-signed `.dmg` from its own download page, which needs neither. The
`appId` in `electron-builder.yml` is written into the bundle's `Info.plist` and
is registered with nobody.

---

## 2. Do the secrets first

Land the secrets **before** the config change. The alternative — conditional
notarisation so an unsigned build still passes — costs more complexity than it
saves, and the credentials are already in hand.

Five repository secrets on `phuryn/grok-build-vscode`:

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

### Producing the `.p12` (Mac-only, cannot be done anywhere else)

```bash
# 1. Install the certificate — pairs it with the private key already in the keychain.
open developerID_application.cer

# 2. Confirm the pairing. If this prints nothing, the private key is missing and
#    the certificate is useless — the CSR was generated on a different machine.
security find-identity -v -p codesigning
#   1) ABC…  "Developer ID Application: Pawel Huryn (L6TFKRX6QQ)"
```

Then Keychain Access → **My Certificates** → expand the identity's triangle and
confirm a private key sits beneath it → right-click the certificate → **Export**
→ **Personal Information Exchange (.p12)** → set a password.

```bash
base64 -i DeveloperID.p12 | gh secret set CSC_LINK --repo phuryn/grok-build-vscode
gh secret set CSC_KEY_PASSWORD --repo phuryn/grok-build-vscode
gh secret set APPLE_API_KEY --repo phuryn/grok-build-vscode < AuthKey_<KeyID>.p8
gh secret set APPLE_API_KEY_ID --repo phuryn/grok-build-vscode
gh secret set APPLE_API_ISSUER --repo phuryn/grok-build-vscode
```

macOS `base64` has no `-w` flag; that is the Linux one. Never write the base64
to a file inside the repo, and never paste key material into a chat session.

---

## 3. The four repo changes

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
          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
```

These are harmless on the Windows leg (empty and ignored), so one `env:` on the
matrix step is fine — no need to branch per OS.

Also update the header comment: the "Nothing is signed… no Apple Developer
certificate" paragraph becomes wrong the moment this lands, and that comment is
the first thing the next person reads.

---

## 4. Verifying — do not skip to "the workflow was green"

A green workflow means the build succeeded. It does not mean the result opens on
someone else's Mac.

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
