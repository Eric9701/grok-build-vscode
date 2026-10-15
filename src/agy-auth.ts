import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { agyAcpDir } from "./agy-backend";
import type { DeviceLoginCallbacks, DeviceLoginHandle } from "./device-login-run";

/** Google sign-in: the server's `oauth-personal` method. */
export const AGY_SIGN_IN_METHOD = "oauth-personal";
/**
 * A pasted Gemini API key runs the server in its custom-gateway mode, pointed
 * at the host's key relay (`agy-key-relay.ts`): the plain `gemini-api-key`
 * method offers a hardcoded catalog without Gemini 4 Argon. Gateway mode is
 * behind a rollout flag in 1.4.0 ("not yet ratified"); the flag is not a
 * secret, so it rides the spawn environment. The key itself goes nowhere but
 * the relay.
 */
export const AGY_GATEWAY_METHOD = "gateway";
export const AGY_GATEWAY_FLAG_ENV = "AGY_ACP_ENABLE_GATEWAY_AUTH";
/** The server waits 300 s on its loopback redirect; allow for its start. */
export const AGY_SIGN_IN_TIMEOUT_MS = 330_000;
/** Gemini keys are about 40 characters; anything near this is not one. */
export const MAX_AGY_API_KEY_CHARS = 512;

/** How a person chose to sign Antigravity in on this machine. */
export type AgySignInMethod = "google" | "api-key";

export function isAgySignInMethod(value: unknown): value is AgySignInMethod {
  return value === "google" || value === "api-key";
}

/** What a server start authenticates with. Nothing secret travels here: a
 *  key's server is handed only the relay's address. */
export interface AgyStartupAuth {
  methodId: string;
  meta?: Record<string, unknown>;
}

export function agyGoogleAuth(): AgyStartupAuth {
  return { methodId: AGY_SIGN_IN_METHOD };
}

export function agyGatewayAuth(baseUrl: string): AgyStartupAuth {
  return { methodId: AGY_GATEWAY_METHOD, meta: { gateway: { baseUrl } } };
}

/** The spawn environment for a key's server: the person's own, plus the
 *  rollout flag. Gateway mode sends the harness a dummy credential, so a
 *  GEMINI_API_KEY of their own is neither used nor sent. */
export function agyGatewayEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, [AGY_GATEWAY_FLAG_ENV]: "1" };
}

/** A pasted key, trimmed, or the sentence that says why it is not one. */
export function normalizeAgyApiKey(raw: unknown): { key: string } | { error: string } {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return { error: "Paste a Gemini API key." };
  if (key.length > MAX_AGY_API_KEY_CHARS || /\s/.test(key)) return { error: "That does not look like a Gemini API key." };
  return { key };
}

export interface AgyCredentialProbe {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (file: string) => boolean;
  /** macOS keeps the token in the login keychain unless forced to a file. */
  keychainEntry?: () => Promise<boolean>;
}

/** `security` reads the item's attributes only, so it never prompts. */
export function agyKeychainEntryPresent(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity-acp"],
      { timeout: 5_000 }, (error) => resolve(!error));
  });
}

/**
 * Is a Google sign-in stored for the server? Presence only, never a network
 * call and never a server process -- and never `authenticate`, which with no
 * stored token opens the person's browser.
 *
 * The method saved in the server's settings.json does not enter into it: that
 * file is shared with every ACP client on the machine and a key sign-in
 * rewrites it, so each server start authenticates with the method the person
 * picked here instead.
 */
export async function agyGoogleSignInPresent(probe: AgyCredentialProbe = {}): Promise<boolean> {
  const exists = probe.exists ?? fs.existsSync;
  if (exists(path.join(agyAcpDir(probe.env, probe.home), "acp_token.json"))) return true;
  const platform = probe.platform ?? process.platform;
  const forcedFile = /^(1|true)$/i.test((probe.env ?? process.env).AGY_ACP_FORCE_FILE_STORAGE ?? "");
  if (platform !== "darwin" || forcedFile) return false;
  return (probe.keychainEntry ?? agyKeychainEntryPresent)();
}

const SIGN_IN_PROMPT = /Open the following link to authenticate the ACP server:\s*(https:\/\/\S+)/;

/** The sign-in link the server prints to stderr while it waits. */
export function agySignInUrl(stderr: string): string | undefined {
  return SIGN_IN_PROMPT.exec(stderr)?.[1];
}

/** What the sign-in needs from an ACP client; `AcpClient` satisfies it. */
export interface AgySignInClient {
  start(): Promise<void>;
  authenticate(methodId: string, timeoutMs: number): Promise<unknown>;
  dispose(): Promise<void>;
  on(event: "stderr", listener: (text: string) => void): unknown;
}

function errorText(error: unknown): string {
  const value = error as any;
  return String(value?.data?.message ?? value?.message ?? value ?? "");
}

/**
 * Google sign-in through the server's own `authenticate`, shaped as a device
 * login so the host's existing flow -- the waiting card with its link, Cancel,
 * the credential check, adopting the agent afterwards -- carries it unchanged.
 *
 * The server opens the browser itself; the link it prints is offered on the
 * card for when no browser opened. A stored token makes this return without a
 * browser at all. The process exists only for this sign-in.
 */
export function runAgySignIn(client: AgySignInClient, callbacks: DeviceLoginCallbacks): DeviceLoginHandle {
  let settled = false;
  let prompted = false;
  let stderr = "";
  const settle = (result: Parameters<DeviceLoginCallbacks["onDone"]>[0]) => {
    if (settled) return;
    settled = true;
    callbacks.onDone(result);
  };
  client.on("stderr", (text) => {
    if (prompted || settled) return;
    stderr = (stderr + text).slice(-16_384);
    const url = agySignInUrl(stderr);
    if (!url) return;
    prompted = true;
    callbacks.onPrompt({ url });
  });
  void (async () => {
    try {
      await client.start();
      if (settled) return;
      await client.authenticate(AGY_SIGN_IN_METHOD, AGY_SIGN_IN_TIMEOUT_MS);
      settle({ ok: true, output: "" });
    } catch (error) {
      settle({ ok: false, failure: "failed", output: errorText(error) });
    } finally {
      await client.dispose().catch(() => undefined);
    }
  })();
  return {
    cancel: () => {
      if (settled) return;
      settle({ ok: false, cancelled: true, output: "" });
      void client.dispose().catch(() => undefined);
    },
    submitCode: () => {},
  };
}
