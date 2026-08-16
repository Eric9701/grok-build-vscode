/**
 * Which relay a build talks to.
 *
 * The constant is fixed in code because there is no user setting: a linked
 * device token is a credential, and a client that can be pointed at an
 * arbitrary relay is a client that can be talked into handing it over. The
 * override exists only so a build run from source can reach staging without
 * editing the constant — which is how a staging URL reached the public repo
 * once already.
 *
 * The production gate is therefore the whole point of this file. Everything
 * else here is politeness; that one assertion is the security property.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import {
  PRODUCTION_RELAY_URL,
  REMOTE_RELAY_URL,
  RELAY_DEVICE_TOKEN_ENV,
  RELAY_DEVICE_TOKEN_SECRET,
  RELAY_URL_ENV,
  redactRelayUrl,
  consumeInjectedDeviceToken,
  resolveInjectedDeviceToken,
  resolveRelayUrl,
  withInjectedSecret,
} from "../src/remote-frames";

const STAGING = "wss://staging-relay.example";

describe("REMOTE_RELAY_URL", () => {
  it("is the production constant in committed source", () => {
    // install.ps1 rewrites the assignment for a local staging vsix. A leftover
    // swap must fail this suite, not wait for someone to extract a vsix.
    expect(REMOTE_RELAY_URL).toBe(PRODUCTION_RELAY_URL);
  });
});

describe("resolveRelayUrl", () => {
  it("IGNORES the environment in a production build", () => {
    // A packaged desktop app and a published .vsix are both production. If this
    // ever passes the env through, anyone who can set a variable in the user's
    // environment can redirect their device token.
    expect(
      resolveRelayUrl({ isProduction: true, env: { [RELAY_URL_ENV]: STAGING } }),
    ).toBe(REMOTE_RELAY_URL);
  });

  it("honours it in a development build", () => {
    expect(
      resolveRelayUrl({ isProduction: false, env: { [RELAY_URL_ENV]: STAGING } }),
    ).toBe(STAGING);
  });

  it("falls back to the constant when nothing is set", () => {
    expect(resolveRelayUrl({ isProduction: false, env: {} })).toBe(REMOTE_RELAY_URL);
    expect(resolveRelayUrl({ isProduction: false })).toBe(REMOTE_RELAY_URL);
  });

  it("refuses anything that is not a ws(s) URL with an authority", () => {
    // A typo should cost a staging session, not a working client — so each of
    // these falls back rather than throwing. `wss://` alone names no host, and
    // any other scheme would send a device token somewhere it cannot go.
    for (const bad of [
      "",
      "   ",
      "afkpilot.com",
      "https://afkpilot.com",
      "http://afkpilot.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "wss://",
      "ws:// space.example",
      // Query and fragment, anywhere. buildUplinkUrl and the REST callers append
      // to this value, so these would build `wss://relay.test?x=1/uplink` — a
      // dead endpoint that reads like the relay is down, not like a typo.
      "wss://relay.test?x=1",
      "wss://relay.test/#x",
      "wss://relay.test/base?token=leak",
      // Authorities a pattern match waves through but the URL parser rejects.
      // These used to reach `new WebSocket()` and throw synchronously, which is
      // the opposite of falling back.
      "wss://relay.test:bad",
      "wss://relay.test:99999",
      "wss://[not-an-ipv6",
      // Credentials would be logged wherever the relay URL is logged.
      "wss://user:pass@relay.test",
    ]) {
      expect(resolveRelayUrl({ isProduction: false, env: { [RELAY_URL_ENV]: bad } })).toBe(
        REMOTE_RELAY_URL,
      );
    }
  });

  it("accepts ws:// for a local relay, and trims surrounding space", () => {
    expect(
      resolveRelayUrl({ isProduction: false, env: { [RELAY_URL_ENV]: "  ws://127.0.0.1:8787  " } }),
    ).toBe("ws://127.0.0.1:8787");
  });

  it("strips trailing slashes, which the URL builders assume are absent", () => {
    // buildUplinkUrl and httpBaseFromRelayUrl both strip them too, but a value
    // that arrives clean cannot produce a double slash in a path anywhere else.
    expect(
      resolveRelayUrl({ isProduction: false, env: { [RELAY_URL_ENV]: `${STAGING}//` } }),
    ).toBe(STAGING);
  });

  it("refuses an empty authority instead of promoting the path to a hostname", () => {
    // ws is a special scheme, so the URL parser turns `wss:///relay` into host
    // `relay` — it will happily invent an authority out of the first path
    // segment. Deferring to that would make this function's own rule ("an
    // authority is required") false, so the empty authority is caught before
    // parsing.
    for (const bad of ["wss:///path-only", "ws:///relay", "wss:////x"]) {
      expect(resolveRelayUrl({ isProduction: false, env: { [RELAY_URL_ENV]: bad } })).toBe(
        REMOTE_RELAY_URL,
      );
    }
  });

  it("keeps a base path, which a relay behind a prefix needs", () => {
    expect(
      resolveRelayUrl({ isProduction: false, env: { [RELAY_URL_ENV]: "wss://example.test/relay" } }),
    ).toBe("wss://example.test/relay");
  });
});

describe("redactRelayUrl", () => {
  // Accepting a base path is what makes redaction necessary: the path may carry
  // something its owner would not want in an output channel or a pasted log,
  // and "which relay is this?" is the only question the log line is asked.
  it("keeps scheme and host, drops everything that could carry a secret", () => {
    expect(redactRelayUrl("wss://relay.test/secret-token")).toBe("wss://relay.test");
    expect(redactRelayUrl("wss://user:pass@relay.test")).toBe("wss://relay.test");
    expect(redactRelayUrl("wss://relay.test/base?token=leak#frag")).toBe("wss://relay.test");
  });

  it("keeps the port, which distinguishes two local relays", () => {
    expect(redactRelayUrl("ws://127.0.0.1:8787/x")).toBe("ws://127.0.0.1:8787");
  });

  it("says so rather than echoing something it could not parse", () => {
    for (const bad of ["", "   ", "not a url", "wss://"]) {
      expect(redactRelayUrl(bad)).toBe("(unparseable relay url)");
    }
  });
});

const LOCAL = "ws://127.0.0.1:8791";
const TOKEN = "lifecycle-device-token";
const both: Record<string, string> = {
  [RELAY_URL_ENV]: LOCAL,
  [RELAY_DEVICE_TOKEN_ENV]: TOKEN,
};

describe("resolveInjectedDeviceToken", () => {
  it("refuses a production build even when both env vars are set", () => {
    // Packaged desktop (`app.isPackaged`) and a published extension
    // (`ExtensionMode.Production`) are both production. The pairing is the
    // whole point: a published build already ignores GROK_RELAY_URL, and
    // this gate must not grow a second door that accepts a token anyway.
    expect(resolveInjectedDeviceToken({ isProduction: true, env: both })).toBeUndefined();
  });

  it("refuses a development build whose relay URL was not overridden", () => {
    expect(
      resolveInjectedDeviceToken({
        isProduction: false,
        env: { [RELAY_DEVICE_TOKEN_ENV]: TOKEN },
      }),
    ).toBeUndefined();
    expect(resolveInjectedDeviceToken({ isProduction: false, env: {} })).toBeUndefined();
    expect(resolveInjectedDeviceToken({ isProduction: false })).toBeUndefined();
  });

  it("refuses when GROK_RELAY_URL is set but does not actually move the relay", () => {
    // Malformed values fall back to the build constant — that is not an override.
    expect(
      resolveInjectedDeviceToken({
        isProduction: false,
        env: { [RELAY_URL_ENV]: "https://afkpilot.com", [RELAY_DEVICE_TOKEN_ENV]: TOKEN },
      }),
    ).toBeUndefined();
    // Naming production explicitly is still production.
    expect(
      resolveInjectedDeviceToken({
        isProduction: false,
        env: { [RELAY_URL_ENV]: PRODUCTION_RELAY_URL, [RELAY_DEVICE_TOKEN_ENV]: TOKEN },
      }),
    ).toBeUndefined();
  });

  it("honours a development build whose relay URL actually moved", () => {
    expect(resolveInjectedDeviceToken({ isProduction: false, env: both })).toBe(TOKEN);
    expect(
      resolveInjectedDeviceToken({
        isProduction: false,
        env: { [RELAY_URL_ENV]: `  ${LOCAL}  `, [RELAY_DEVICE_TOKEN_ENV]: `  ${TOKEN}  ` },
      }),
    ).toBe(TOKEN);
  });

  it("refuses a blank or non-string token even with a valid override", () => {
    expect(
      resolveInjectedDeviceToken({
        isProduction: false,
        env: { [RELAY_URL_ENV]: LOCAL, [RELAY_DEVICE_TOKEN_ENV]: "   " },
      }),
    ).toBeUndefined();
    expect(
      resolveInjectedDeviceToken({
        isProduction: false,
        env: { [RELAY_URL_ENV]: LOCAL, [RELAY_DEVICE_TOKEN_ENV]: undefined },
      }),
    ).toBeUndefined();
  });
});

describe("consumeInjectedDeviceToken", () => {
  it("deletes the env entry so later process.env copies cannot inherit it", () => {
    const env: Record<string, string | undefined> = {
      [RELAY_URL_ENV]: LOCAL,
      [RELAY_DEVICE_TOKEN_ENV]: TOKEN,
      PATH: "/bin",
    };
    const token = consumeInjectedDeviceToken({ isProduction: false, env });
    expect(token).toBe(TOKEN);
    expect(RELAY_DEVICE_TOKEN_ENV in env).toBe(false);
    const inherited = { ...env };
    expect(inherited[RELAY_DEVICE_TOKEN_ENV]).toBeUndefined();
    expect(inherited.PATH).toBe("/bin");
  });

  it("still deletes the entry when the gate refuses the token", () => {
    const env: Record<string, string | undefined> = {
      [RELAY_DEVICE_TOKEN_ENV]: TOKEN,
    };
    expect(consumeInjectedDeviceToken({ isProduction: true, env })).toBeUndefined();
    expect(RELAY_DEVICE_TOKEN_ENV in env).toBe(false);
  });

  it("does not change when the token is honoured versus refused", () => {
    const honoured = consumeInjectedDeviceToken({
      isProduction: false,
      env: { ...both },
    });
    const refused = resolveInjectedDeviceToken({ isProduction: false, env: both });
    expect(honoured).toBe(refused);
  });
});

describe("withInjectedSecret", () => {
  it("is a no-op when the resolver returned undefined — no overlay, no uplink", () => {
    const get = vi.fn(async () => "stored");
    const token = resolveInjectedDeviceToken({ isProduction: true, env: both });
    expect(token).toBeUndefined();
    expect(withInjectedSecret(get, RELAY_DEVICE_TOKEN_SECRET, token)).toBe(get);
    expect(withInjectedSecret(get, RELAY_DEVICE_TOKEN_SECRET, "")).toBe(get);
  });

  it("answers the device-token key from memory and leaves every other key alone", async () => {
    const get = vi.fn(async (key: string) => (key === "other" ? "disk" : undefined));
    const overlay = withInjectedSecret(get, RELAY_DEVICE_TOKEN_SECRET, TOKEN);
    expect(await overlay(RELAY_DEVICE_TOKEN_SECRET)).toBe(TOKEN);
    expect(get).not.toHaveBeenCalled();
    expect(await overlay("other")).toBe("disk");
    expect(get).toHaveBeenCalledWith("other");
  });
});

describe("injected-token consumers", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = (rel: string) => fs.readFileSync(path.join(here, "..", "src", rel), "utf8");

  it("desktop main is the only product consumer and gates on app.isPackaged", () => {
    const main = src(path.join("desktop", "main.ts"));
    expect(main).toContain("consumeInjectedDeviceToken");
    expect(main).toMatch(/isProduction:\s*app\.isPackaged/);
    expect(main).toContain("withInjectedSecret");
    expect(main).toContain("RELAY_DEVICE_TOKEN_SECRET");
    const consumeAt = main.indexOf("consumeInjectedDeviceToken({");
    const sidebarAt = main.indexOf("new GrokSidebar(");
    expect(consumeAt).toBeGreaterThan(0);
    expect(sidebarAt).toBeGreaterThan(consumeAt);
    // VS Code never reads the env token — ExtensionMode.Production has no
    // overlay, and Development/Test still start the uplink from SecretStorage.
    const sidebar = src("sidebar.ts");
    expect(sidebar).not.toContain("resolveInjectedDeviceToken");
    expect(sidebar).not.toContain("consumeInjectedDeviceToken");
    expect(sidebar).not.toContain("RELAY_DEVICE_TOKEN_ENV");
    expect(sidebar).not.toContain("GROK_RELAY_DEVICE_TOKEN");
    expect(src("vscode-host.ts")).not.toContain("resolveInjectedDeviceToken");
    expect(src("vscode-host.ts")).not.toContain("consumeInjectedDeviceToken");
  });

  it("keeps the SecretStorage key in one place", () => {
    expect(RELAY_DEVICE_TOKEN_SECRET).toBe("grok.remoteControl.deviceToken");
    expect(src("sidebar.ts")).toContain("RELAY_DEVICE_TOKEN_SECRET");
    expect(src("sidebar.ts")).not.toContain('"grok.remoteControl.deviceToken"');
  });
});
