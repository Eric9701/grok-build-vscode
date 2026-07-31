# Voice control — setup & advanced configuration

The microphone button in the composer dictates speech, transcribed by [xAI's Speech-to-Text API](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text). Click it, wait for the blue listening waves, and speak — words appear live as you talk. Say **"grok send"** to submit hands-free and keep listening for the next message. Click the mic again to stop and keep any in-progress text.

For most people it **just works** once you're signed in — the two things below are only if you need them.

## 1. Authentication — usually automatic

If you're signed in with **`grok login`**, the extension reuses that stored token (`~/.grok/auth.json`) for Speech-to-Text automatically. No separate key, nothing to paste.

**Optional dedicated key.** If you'd rather use a distinct [console.x.ai](https://console.x.ai) developer key — to bill it separately, keep it account-scoped, or if your login token doesn't cover STT — set any one of these (they take precedence over the login token, in this order):

| Where | Setting / var |
|---|---|
| VS Code setting | `grok.voiceApiKey` |
| Workspace `.env` | `GROK_VOICE_API_KEY` (preferred) |
| Workspace `.env` | `XAI_API_KEY` (shared with other tools) |

A known-**expired** login token is skipped (so the mic doesn't look ready and then fail mid-recording); if that happens, run `grok logout` then `grok login`, or set a dedicated key above.

## 2. ffmpeg — required for the VS Code microphone

Recording the microphone uses [`ffmpeg`](https://ffmpeg.org). Most dev machines already have it; if voice reports it missing, install it:

AFK Pilot records in the remote browser with the Web Audio API and sends
ephemeral raw PCM to the extension host, so its microphone does not require
ffmpeg on the browser device. It still uses the host-side credential and the
same xAI STT stream.

- **Windows:** `winget install ffmpeg` (or `choco install ffmpeg`), or download from [ffmpeg.org](https://ffmpeg.org/download.html) and add it to `PATH`.
- **macOS:** `brew install ffmpeg`.
- **Linux:** `sudo apt install ffmpeg` (or your distro's equivalent).

If it's installed somewhere off `PATH`, point `grok.ffmpegPath` at the binary.

## 3. Cost

Speech-to-Text is a **metered** xAI service billed by audio duration — **$0.10/hr** batch, **$0.20/hr** streaming. In practice ~500 words ≈ ½–1¢; a heavy 10,000-word day ≈ 10¢. Whether it draws on your subscription or is billed pay-as-you-go depends on the credential/account used. How the cost was measured end-to-end: [research/voice-input.md](../research/voice-input.md).

## 4. Other settings

| Setting | Default | What it does |
|---|---|---|
| `grok.voiceStreaming` | `true` | Live streaming transcription (words appear as you speak). Disable for one-shot batch mode (click-start → click-stop → transcribe). Streaming costs $0.20/hr vs $0.10/hr batch. |
| `grok.voiceSendPhrase` | `grok send` | Spoken phrase that auto-submits when it ends a transcription. Empty disables hands-free sending. |
| `grok.voiceKeyterms` | `[]` | Words or phrases that help streaming recognition spell code and project vocabulary. The send phrase and `Grok` come first; user terms fill the remaining xAI limit of 100 terms, 50 characters each. |
| `grok.voiceLanguage` | `""` | Optional language code for streaming text formatting (for example `en`, `fr`, `de`, or `ja`). Empty leaves Inverse Text Normalization off and preserves spoken-form text. |
| `grok.voiceInputDevice` | `""` | Microphone device. Empty = system default (Windows auto-detects the first DirectShow device). Set a device name (Windows/dshow) or index (macOS/avfoundation) to override. |

## Privacy

Voice is opt-in per use — nothing is captured until you click the mic. Local VS
Code capture stays in the extension host; AFK Pilot capture travels ephemerally
through the relay as raw PCM to that host. Audio is never persisted or
content-logged. The host sends the audio, its **STT credential** (the dedicated
key you set, or your `grok login` token if you rely on the automatic fallback),
and—during streaming—the configured language and recognition keyterms to
xAI's Speech-to-Text endpoint (`api.x.ai/v1/stt`) to produce the transcript.
Keyterms include the send phrase, `Grok`, and any `grok.voiceKeyterms` entries,
which may be project-specific. The credential is never sent to the browser or
relay. This is separate from anonymous
telemetry — see [docs/privacy.md](privacy.md).
