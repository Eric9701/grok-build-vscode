import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";

/**
 * The only place an Antigravity Gemini API key goes.
 *
 * Key sign-in drives the server's gateway mode at a relay on 127.0.0.1, and
 * the relay -- not the server, not its harness, not the agent's commands --
 * holds the key. Two measured facts force it (research/antigravity-acp.md,
 * "Decisions to revisit"):
 *
 * - The server's own `gemini-api-key` method lists a hardcoded catalog without
 *   Gemini 4 Argon. Gateway mode lists what the API serves the key, Argon
 *   included.
 * - In gateway mode the harness sends its own `x-goog-api-key: dummy_api_key`
 *   on every generate call, so a key passed as a gateway header is overridden
 *   and Google answers 400 API_KEY_INVALID. The relay replaces whatever
 *   credential arrives with the real key.
 *
 * Requests must carry an unguessable path prefix (the server keeps a baseUrl's
 * path for model discovery and generate calls alike; measured), are forwarded
 * only to {@link AGY_RELAY_UPSTREAM}, and stream both ways with no timeout on
 * the body: a turn is one long SSE response. The log names status, method and
 * path after the prefix -- never the key, the prefix, a query, a body or a
 * response.
 */
export const AGY_RELAY_UPSTREAM = "https://generativelanguage.googleapis.com";

export type AgyUpstreamRequest = (
  url: URL,
  options: { method: string; headers: http.OutgoingHttpHeaders },
) => http.ClientRequest;

const httpsUpstream: AgyUpstreamRequest = (url, options) => https.request(url, { method: options.method, headers: options.headers });

/** Connection-scoped headers, which a hop must not forward. */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "host",
]);
/** Whatever credential the harness sends is replaced, never forwarded. */
const CREDENTIAL_HEADERS = new Set(["authorization", "x-goog-api-key"]);

/**
 * The server's model discovery: one GET, 15 s for all of it, and on a miss it
 * settles for a built-in three-model catalog without Argon for that process
 * (measured on 1.4.0, 2026-10-16: a slow cold start did exactly that). So the
 * relay answers it from the last listing Google gave the same key, and asks
 * Google again behind it. A model Google adds shows from the following start.
 */
const LISTING_PATH = "/v1beta/models";
/** Far above a real listing (~40 models, tens of KB); anything bigger is not remembered. */
const MAX_LISTING_BYTES = 4 * 1024 * 1024;

/** The last model listing Google served one key. Model names only: no key. */
export interface AgyModelListing {
  /** A one-way fingerprint, so a replaced key never sees the old key's models. */
  keyId: string;
  /** Path and query after the prefix, e.g. `/v1beta/models?pageSize=1000`. */
  path: string;
  body: string;
}

export interface AgyListingStore {
  get(): AgyModelListing | undefined;
  set(listing: AgyModelListing): void;
}

function memoryListingStore(): AgyListingStore {
  let listing: AgyModelListing | undefined;
  return { get: () => listing, set: (next) => { listing = next; } };
}

function keyId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** A body worth replaying: JSON with at least one model. */
function isListing(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { models?: unknown };
    return Array.isArray(parsed?.models) && parsed.models.length > 0;
  } catch {
    return false;
  }
}

export interface AgyKeyRelayOptions {
  log?: (line: string) => void;
  /** Tests inject a local upstream; the target URL is still Google's. */
  upstream?: AgyUpstreamRequest;
  /** Tests fix the prefix; otherwise 24 random bytes. */
  secret?: string;
  /** Where the last model listing survives a restart; memory-only by default. */
  listings?: AgyListingStore;
}

export interface AgyRelayLease {
  /** The `_meta.gateway.baseUrl` a server authenticates with. */
  readonly baseUrl: string;
  /** Idempotent. The relay closes when the last lease is released. */
  release(): void;
}

export class AgyKeyRelay {
  private server?: http.Server;
  private listening?: Promise<string>;
  private key?: string;
  private leases = 0;
  private readonly secret: string;
  private readonly upstream: AgyUpstreamRequest;
  private readonly log: (line: string) => void;
  private readonly listings: AgyListingStore;
  private refreshing = false;

  constructor(options: AgyKeyRelayOptions = {}) {
    this.secret = options.secret ?? randomBytes(24).toString("base64url");
    this.upstream = options.upstream ?? httpsUpstream;
    this.log = options.log ?? (() => {});
    this.listings = options.listings ?? memoryListingStore();
  }

  /**
   * A lease on a listening relay that presents `key`. The newest key wins for
   * every live server, so replacing a saved key needs no restart.
   */
  async acquire(key: string): Promise<AgyRelayLease> {
    this.key = key;
    this.leases += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.leases -= 1;
      if (this.leases <= 0) void this.close();
    };
    try {
      return { baseUrl: await this.listen(), release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Text with the relay's prefix redacted: the server logs its baseUrl. */
  redact(text: string): string {
    return text.split(this.secret).join("<relay>");
  }

  get active(): boolean { return this.leases > 0; }

  async close(): Promise<void> {
    this.leases = 0;
    this.key = undefined;
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private listen(): Promise<string> {
    if (this.listening) return this.listening;
    // No request timeout: a turn is one SSE response that can run for minutes.
    const server = http.createServer({ requestTimeout: 0 }, (req, res) => this.handle(req, res));
    this.server = server;
    this.listening = new Promise<string>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const { port } = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}/${this.secret}`);
      });
    }).catch((error) => {
      if (this.server === server) { this.server = undefined; this.listening = undefined; }
      throw error;
    });
    return this.listening;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const method = req.method ?? "GET";
    const raw = req.url ?? "/";
    const prefix = `/${this.secret}/`;
    const key = this.key;
    if (!raw.startsWith(prefix) || !key) {
      this.log(`[agy-relay] 403 ${method}`);
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    const rest = raw.slice(prefix.length - 1);
    const queryAt = rest.indexOf("?");
    const pathname = queryAt < 0 ? rest : rest.slice(0, queryAt);
    const query = new URLSearchParams(queryAt < 0 ? "" : rest.slice(queryAt + 1));
    query.delete("key");
    // Built from the fixed origin, so no path or query can name another host.
    const target = new URL(AGY_RELAY_UPSTREAM);
    target.pathname = pathname;
    target.search = query.toString();
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (value === undefined || HOP_BY_HOP.has(lower) || CREDENTIAL_HEADERS.has(lower)) continue;
      headers[lower] = value;
    }
    headers["x-goog-api-key"] = key;
    const shown = `${method} ${target.pathname}`;
    const listing = method === "GET" && target.pathname === LISTING_PATH
      ? { keyId: keyId(key), path: target.pathname + target.search }
      : undefined;
    const remembered = listing && this.listings.get();
    if (listing && remembered?.keyId === listing.keyId && remembered.path === listing.path) {
      this.log(`[agy-relay] 200 ${shown} (remembered)`);
      res.writeHead(200, { "content-type": "application/json; charset=UTF-8" });
      res.end(remembered.body);
      req.resume();
      this.refreshListing(target, headers, listing, shown);
      return;
    }
    let upstream: http.ClientRequest;
    try {
      upstream = this.upstream(target, { method, headers });
    } catch (error) {
      this.fail(res, shown, error);
      return;
    }
    upstream.on("response", (answer) => {
      const status = answer.statusCode ?? 502;
      this.log(`[agy-relay] ${status} ${shown}`);
      const out: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
      }
      if (listing && status === 200) this.remember(answer, listing);
      if (res.destroyed) { answer.resume(); return; }
      res.writeHead(status, out);
      answer.pipe(res);
    });
    upstream.on("error", (error) => this.fail(res, shown, error));
    // The harness hung up mid-stream (a cancelled turn): stop the upstream too.
    // Not for the listing: a discovery that gave up still leaves a listing
    // worth keeping for the next start.
    res.on("close", () => { if (!res.writableFinished && !listing) upstream.destroy(); });
    req.pipe(upstream);
  }

  /** Keeps a 200 listing as it streams past, if it is one worth replaying. */
  private remember(answer: http.IncomingMessage, listing: { keyId: string; path: string }): void {
    const chunks: Buffer[] = [];
    let size = 0;
    answer.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_LISTING_BYTES) chunks.push(chunk);
    });
    answer.on("end", () => {
      if (size > MAX_LISTING_BYTES) return;
      const body = Buffer.concat(chunks).toString("utf8");
      if (isListing(body)) this.listings.set({ ...listing, body });
    });
  }

  /** Asks Google for the listing behind a remembered answer. One at a time. */
  private refreshListing(
    target: URL,
    headers: http.OutgoingHttpHeaders,
    listing: { keyId: string; path: string },
    shown: string,
  ): void {
    if (this.refreshing) return;
    this.refreshing = true;
    const done = () => { this.refreshing = false; };
    let request: http.ClientRequest;
    try {
      request = this.upstream(target, { method: "GET", headers });
    } catch (error) {
      done();
      this.log(`[agy-relay] refresh ${shown} failed (${(error as NodeJS.ErrnoException)?.code ?? "error"})`);
      return;
    }
    request.on("response", (answer) => {
      const status = answer.statusCode ?? 0;
      this.log(`[agy-relay] ${status} ${shown} (refresh)`);
      if (status === 200) this.remember(answer, listing);
      else answer.resume();
      answer.on("end", done);
      answer.on("error", done);
    });
    request.on("error", (error) => {
      done();
      this.log(`[agy-relay] refresh ${shown} failed (${(error as NodeJS.ErrnoException)?.code ?? "error"})`);
    });
    request.end();
  }

  private fail(res: http.ServerResponse, shown: string, error: unknown): void {
    const code = (error as NodeJS.ErrnoException)?.code ?? "error";
    this.log(`[agy-relay] 502 ${shown} (${code})`);
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: 502, message: `Could not reach Google (${code}).`, status: "UNAVAILABLE" } }));
  }
}
