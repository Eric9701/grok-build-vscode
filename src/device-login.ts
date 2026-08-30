/**
 * Device-code sign-in — the pure half.
 *
 * `runGrokLogin` has always opened an interactive terminal on the desk. That is
 * the right thing on a desk (the CLI opens the browser for you) and it is why
 * the capability was `host-local`: a phone can neither see that terminal nor
 * type into it, and opening one on someone's machine from elsewhere is not
 * something a remote should be able to do.
 *
 * The CLIs have since grown headless flows that print a URL and a short code
 * and then poll. That is the whole flow a phone needs — display two strings,
 * wait. So the remote path runs the CLI with pipes and renders what it printed
 * into the transcript, and the desk path is untouched.
 *
 * WHAT WAS MEASURED, 2026-08-26, because two of the three surprised us:
 *
 *   grok 1.0.5    `grok login --device-auth`   works on pipes. Prints the URL
 *                 and the code to STDERR (not stdout), keeps polling, exits 0
 *                 when the browser approves.
 *   claude 2.1.246 `claude setup-token`        prints NOTHING to a pipe. It is
 *                 an Ink TUI and wants a real terminal; 18 s of piped stdio
 *                 produced zero bytes on both streams while it happily created
 *                 its config dir. Driving it needs a pty, and a pty means a
 *                 native dependency this repo has deliberately avoided (see
 *                 keep-awake.ts, which picked three OS binaries over one
 *                 native module for exactly this reason).
 *   codex 0.149.0 `codex login --device-auth`  the flag does not exist in this
 *                 build. OpenAI documents it, and it is additionally gated on
 *                 an account setting ("Allow device code login") that a
 *                 workspace admin can withhold.
 *
 * So this module does NOT hardcode "grok works, the others don't". It asks the
 * CLI and believes the answer: {@link deviceLoginPlan} says which command to
 * try, the runner tries it, and {@link classifyDeviceLoginFailure} turns
 * whatever came back into something a person can act on. A codex that grows
 * the flag starts working with no change here, and a claude that stops needing
 * a TTY does too — capability detection, never version numbers.
 */
import type { AcpProvider } from "./acp-backend";

/** How long to let a headless login sit before giving up on it. Device codes
 *  from every vendor we have looked at expire inside 15 minutes, so waiting
 *  longer only holds a dead child process open. */
export const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

/** How long to wait for the URL before concluding the CLI is not going to
 *  print one. Generous: it covers a cold binary and a slow first HTTPS round
 *  trip, and the cost of being wrong is telling someone "no" who could have
 *  had a yes. `claude setup-token` produced nothing in 18 s, so 25 separates
 *  the two cases with room to spare. */
export const DEVICE_LOGIN_PROMPT_TIMEOUT_MS = 25_000;

export interface DeviceLoginPlan {
  /** Argv after the CLI path. */
  args: string[];
}

/**
 * The headless login command to try for a provider, or undefined when we know
 * of none to try.
 *
 * Claude is the undefined one and it is a measurement, not a policy: its
 * headless command exists and is documented, it simply cannot be driven
 * through a pipe. Recorded as a reason string rather than silence so the panel
 * can say which of "there is no such flow" and "the flow needs a terminal" is
 * true — those lead a person to different next actions.
 */
export function deviceLoginPlan(provider: AcpProvider): DeviceLoginPlan | undefined {
  if (provider === "grok") return { args: ["login", "--device-auth"] };
  if (provider === "codex") return { args: ["login", "--device-auth"] };
  return undefined;
}

/** Why a provider has no remote sign-in, in a sentence a person can act on. */
export function deviceLoginUnavailable(
  provider: AcpProvider,
  opts: { isCloud?: boolean } = {},
): string | undefined {
  if (provider !== "claude") return undefined;
  // In a CLOUD environment there is no computer to walk to, so the desk
  // fallback is not advice — it is a dead end dressed as advice. The image
  // carries a pty for exactly this, which is why the answer differs.
  if (opts.isCloud) return undefined;
  return "Claude's sign-in needs a real terminal, so it has to be done at your computer. "
    + "Open Grok Build there and connect Claude, and this device picks it up straight away.";
}

/**
 * The sentence for a provider that cannot be signed in from here at all.
 *
 * Split out of the sidebar so it is testable, and because its cloud branch is
 * the whole point: "connect it at your computer" is good advice at a desk and a
 * DEAD END in a cloud environment, where there is no computer to walk to. The
 * sidebar's inline fallback used to hand back exactly the advice that
 * {@link deviceLoginUnavailable} withholds on cloud for that reason.
 */
export function noRemoteSignInMessage(
  displayName: string,
  opts: { isCloud?: boolean } = {},
): string {
  if (opts.isCloud) {
    return `${displayName} isn't available on cloud machines yet — we're working on adding it. `
      + "Grok and Codex both sign in right here.";
  }
  return `${displayName} has no sign-in that works without a terminal. Connect it at your computer.`;
}

/**
 * What to tell somebody BEFORE they start a sign-in that is likely to fail.
 *
 * Codex device-code login is **off by default on every account**. OpenAI
 * disables it deliberately — a device code is more social-engineerable than a
 * browser redirect — so the first attempt fails for almost everyone, and the
 * error arrives after a wait, in the middle of a flow they had already
 * committed to.
 *
 * A person can fix it in about fifteen seconds, and only if they are told
 * where. So this is shown BEFORE the button does anything, not after it fails.
 *
 * Cloud only, and that is the whole point of the flag: at a desk the browser
 * flow works and this setting never comes up. Showing it there would be a
 * warning about a problem the reader does not have.
 */
export interface DeviceLoginPreflight {
  /** One sentence on why this is here. */
  reason: string;
  /** The exact path through the vendor's settings. */
  steps: readonly string[];
  /** Where to go and do it. */
  url?: string;
}

export function deviceLoginPreflight(
  provider: AcpProvider,
  opts: { isCloud?: boolean } = {},
): DeviceLoginPreflight | undefined {
  if (!opts.isCloud) return undefined;
  if (provider !== "codex") return undefined;
  return {
    reason:
      "Codex needs one setting turned on before the code below will be accepted. "
      + "It is off by default for everyone — OpenAI disables device-code sign-in "
      + "unless you ask for it.",
    steps: [
      "Open ChatGPT and go to Settings → Security",
      // The setting sits at the very BOTTOM of a long page, and people reported
      // not finding it. `**` is rendered as bold by the panel.
      "Turn on \"Device code authorization for Codex\" **at the very bottom**",
      "Come back here and use the code to finish",
    ],
    url: "https://chatgpt.com/#settings/Security",
  };
}

// Explicit escapes, not literal control bytes: an ESC written straight into
// a source file survives an editor but not reliably a patch, and this repo
// has already repaired one regex byte-level for exactly that reason.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;

/** Strip terminal control sequences. The CLIs colour their output even when
 *  stdout is a pipe, so a naive URL match drags an escape code along with it. */
export function stripAnsi(text: string): string {
  return text.replace(OSC, "").replace(ANSI, "");
}

export interface DeviceLoginPrompt {
  url: string;
  code?: string;
}

// Trailing punctuation is not part of a URL when the CLI wrapped it in prose.
const URL_RE = /https?:\/\/[^\s<>"')\]]+/;
// Vendors print codes as two short groups. Matched on the STRIPPED text, and
// deliberately not `\w+` — that swallows ordinary words like "Waiting".
const BARE_CODE_RE = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/;

/**
 * Pull the URL and code out of whatever the CLI has printed so far.
 *
 * Order matters. The code is read from the URL's own query string first
 * (`?user_code=SDCN-9XZS`, which is what grok emits) because that pairing is
 * unambiguous; the bare-token scan is the fallback for a CLI that prints them
 * on separate lines and nothing else code-shaped. Reversing those two lets a
 * stray uppercase hyphenate elsewhere in the banner win.
 *
 * Returns undefined until a URL exists — a code with nowhere to type it is not
 * a prompt worth showing.
 */
export function parseDeviceLoginPrompt(raw: string): DeviceLoginPrompt | undefined {
  const text = stripAnsi(raw);
  const url = text.match(URL_RE)?.[0];
  if (!url) return undefined;
  const trimmed = url.replace(/[.,;:]+$/, "");
  const fromUrl = trimmed.match(/[?&](?:user_)?code=([^&#\s]+)/i)?.[1];
  const code = fromUrl ? decodeURIComponent(fromUrl) : text.match(BARE_CODE_RE)?.[1];
  return code ? { url: trimmed, code } : { url: trimmed };
}

export type DeviceLoginFailure =
  /** The CLI rejected the flag — an older build that predates the flow. */
  | "unsupported"
  /** The account or workspace has device-code login switched off. */
  | "not-permitted"
  /** Ran, printed no URL. Almost always a TTY-only flow. */
  | "no-prompt"
  /** Ran, printed a URL, and then failed or was never approved. */
  | "failed";

/**
 * What went wrong, from the CLI's own output and exit code.
 *
 * `sawPrompt` is the discriminator that matters: a run that never printed a URL
 * failed at a different place than one that printed a URL and then gave up, and
 * conflating them produced the least useful message available ("sign-in
 * failed") for the case with the most obvious fix.
 */
export function classifyDeviceLoginFailure(
  output: string,
  sawPrompt: boolean,
): DeviceLoginFailure {
  const text = stripAnsi(output).toLowerCase();
  // clap and friends: "unexpected argument '--device-auth' found".
  if (/unexpected argument|unknown (?:option|flag|argument)|unrecognized option/.test(text)) {
    return "unsupported";
  }
  if (/device[- ]code (?:login|auth)[^.]*(?:disabled|not enabled|not allowed)|contact your (?:workspace )?admin|enable device code/.test(text)) {
    return "not-permitted";
  }
  return sawPrompt ? "failed" : "no-prompt";
}

/** The failure, said to the person who pressed the button. */
export function deviceLoginFailureText(
  provider: AcpProvider,
  failure: DeviceLoginFailure,
  displayName: string,
): string {
  switch (failure) {
    case "unsupported":
      return `This version of the ${displayName} CLI has no headless sign-in. `
        + "Update it, or connect this agent at your computer.";
    case "not-permitted":
      return `${displayName} device-code sign-in is switched off for this account. `
        + (provider === "codex"
          ? "Turn on \"Allow device code login\" in ChatGPT → Settings → Security, then try again."
          : "Enable it in your account settings, then try again.");
    case "no-prompt":
      return `The ${displayName} CLI did not offer a sign-in code, which usually means its `
        + "sign-in needs a real terminal. Connect this agent at your computer instead.";
    case "failed":
      return `${displayName} sign-in did not complete. The code may have expired — try again.`;
  }
}

/**
 * Environment for a headless login.
 *
 * Every one of these says the same thing in a different dialect: there is
 * nobody here to answer a prompt. Without them a CLI that decides it is
 * interactive blocks forever on a read that will never return, and the symptom
 * is not an error — it is a spinner on someone's phone until the timeout.
 */
export function deviceLoginEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    CI: "1",
    TERM: "dumb",
    NO_COLOR: "1",
    // Nothing may open a browser on the host: the whole point is that the
    // person is somewhere else, and a window opening on an unattended desk is
    // at best litter.
    BROWSER: "none",
    GIT_TERMINAL_PROMPT: "0",
  };
}
