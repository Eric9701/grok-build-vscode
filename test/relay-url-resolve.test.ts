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
import { describe, it, expect } from "vitest";
import {
  REMOTE_RELAY_URL,
  RELAY_URL_ENV,
  redactRelayUrl,
  resolveRelayUrl,
} from "../src/remote-frames";

const STAGING = "wss://staging-relay.example";

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
