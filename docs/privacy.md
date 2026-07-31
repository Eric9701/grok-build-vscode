# Privacy

**Privacy by design.** The extension sends **no** background data about you or your code — the only thing it reports on its own is an anonymous usage count, with no content and no identity, and you can turn even that off. Data leaves your machine only at your request: **voice input** (you send audio to xAI to transcribe it), optional **spoken-reply summarization** (you send one reply to xAI to shorten what is spoken), and **Remote Control** (you link this machine to [AFK Pilot](https://afkpilot.com) so your own devices can reach it) — all disclosed in full below, separate from telemetry.

## Telemetry — what is sent

A single, anonymous **`session_start`** event ([Aptabase](https://aptabase.com)), fired on the **first real message** of a session — never the hidden plan-mode primer, and never empty or abandoned sessions. Its only purpose is to gauge how many people use the extension, which models/modes are popular, and whether our default settings are the right ones.

The event carries:

| Field | Example | Why |
|---|---|---|
| Anonymous **install id** | a random GUID generated once on your machine | count distinct installs — **not** your account, email, or grok login |
| **mode / model / effort** | `agent` / `grok-build` / `high` | which features are used |
| **Local UI preferences** | `showThinking: false`, `expandToolDetails: false`, `steerByDefault: true`, `chatFontScale: 100`, `readRepliesAloud: false`, `soundNotifications: false` | whether the webview defaults we picked are the ones people keep |
| **AFK Pilot UI preferences** (when reported by a connected browser) | `remoteFontScale: 140`, `remoteReadRepliesAloud: true` | whether remote users adjust text size or enable spoken replies; omitted when no browser reports them |
| **Session origin / client device** | `sessionOrigin: remote`, `clientDevice: mobile` | whether the first message came from VS Code or AFK Pilot, and whether that client was a desktop browser or looked touch/mobile; local VS Code sessions are always desktop |
| **Host app** | `Visual Studio Code`, `Cursor` | the extension runs in several VS Code forks that behave differently; this shows which ones actually need supporting |
| **OS** + extension **version** | `Windows` / `1.6.1` | platform/version split |
| **Country** | derived by Aptabase from your IP | rough geography |

Country is the only thing derived from your IP, and the **IP itself is discarded — never stored**.

## What telemetry never contains

- **No message content** — nothing you type, and nothing grok replies.
- **No code** — not a single line, ever.
- **No file names or paths**, no workspace name, no repo/branch.
- **No personal identity** — no account, email, grok login, machine name, or any way to tie the install id back to you.

There is no SDK and no third-party tracker — just one small, dependency-free HTTPS POST that is fire-and-forget (it can never slow down, surface to, or break a turn).

## How telemetry is gated

Telemetry sends **only when both** of these are on:

1. VS Code's global telemetry setting — `telemetry.telemetryLevel` (anything other than `off`), and
2. the extension's own `grok.telemetry.enabled` (default `true`).

Either one set to off stops **all** sending.

> **Note on Aptabase build modes.** Events from a published/installed build report as **Release**; events from a development host (running the extension from source) report as **Debug**. In the Aptabase dashboard these are two separate streams toggled by the Bug/Rocket icon — Release data won't appear while the dashboard is in Debug view, and vice-versa.

## How to opt out

Do **either** of the following:

- Set `grok.telemetry.enabled` to `false` in VS Code settings, **or**
- Disable VS Code's global telemetry: set `telemetry.telemetryLevel` to `off`.

Either change takes effect immediately — no reload needed.

## Voice input (Speech-to-Text)

Separate from telemetry: **voice input** sends data to xAI, but only when you use it. It is **opt-in per use** — nothing is captured until you click the microphone button. In VS Code, ffmpeg captures locally in the extension host. In AFK Pilot, the browser sends ephemeral raw PCM through the linked relay connection to that same host; it is never persisted or content-logged. The host then sends the following to **xAI's Speech-to-Text endpoint** (`api.x.ai/v1/stt`) to produce the transcript:

- your **audio** (the recording, streamed live or as a clip);
- an **STT credential** — the dedicated key you configured (`grok.voiceApiKey` / `GROK_VOICE_API_KEY` / `XAI_API_KEY`) if set, otherwise the token from your `grok login` (`~/.grok/auth.json`), reused so voice works without a separate key;
- for streaming voice, the configured **language code** (`grok.voiceLanguage`), when set; and
- for streaming voice, the **recognition keyterms**: the send phrase, `Grok`, and entries from `grok.voiceKeyterms`. These can include project vocabulary, so treat the setting as data sent to xAI.

The STT credential stays in the extension host and is never sent to AFK Pilot or the browser. Remote microphone audio necessarily crosses AFK Pilot on its way back to your linked host; the host-to-xAI STT request is otherwise the same as local voice. Voice connection diagnostics log the endpoint and query-parameter names, but redact all query values. If you never use voice, none of this happens. To avoid sending your login token to xAI specifically, set a dedicated `grok.voiceApiKey`. Setup + details: [docs/voice-setup.md](voice-setup.md).

## Summarize before speaking

Separate from both telemetry and Voice input: the VS Code-only **Summarize before speaking** switch is off by default. When both it and **Read replies aloud** are enabled, the extension sends only the already-cleaned spoken text (after thinking and fenced code have been removed) to xAI's Responses API. xAI returns a short, speech-friendly version; the visible chat reply is never changed.

Each spoken message adds a billed API request and network delay. The request uses `grok-4.3` with reasoning disabled and server-side response storage disabled (`store: false`). It reuses the Voice credential order (`grok.voiceApiKey` → `GROK_VOICE_API_KEY` → `XAI_API_KEY` → the token from `grok login`); the key remains in the extension host and is never sent to the webview. With no usable key, or on timeout, network, rate-limit, or response failure, the original cleaned text is spoken instead. AFK Pilot does not use or receive this feature.

## Remote Control (AFK Pilot)

Also separate from telemetry, and **entirely opt-in**: nothing runs until you explicitly link this machine (gear → *Remote Control* → **Sign in**). Once linked, the extension keeps an outbound connection to the [AFK Pilot](https://afkpilot.com) service so *your own* paired devices (your phone, another browser) can see and drive this workspace's chat. That means the **conversation you see in the sidebar** — messages, replies, tool activity, generated images — flows through the service while a device is linked; that's the feature. The machine introduces itself by **hostname + OS** (e.g. "Dell (Windows 11)") — your workspace path is deliberately not part of it.

**Unlink this device** (`AFK Pilot: Unlink this device` in the Command Palette) removes the device token locally and revokes it on your account — after that, nothing connects. If you never link a device, none of this exists. AFK Pilot's own data handling is covered by its policies at [afkpilot.com](https://afkpilot.com).
