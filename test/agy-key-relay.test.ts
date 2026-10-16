/**
 * The Antigravity key relay against an injected upstream: a local HTTP server
 * stands in for Google, and the injected request function records the URL the
 * relay asked for, which must always be Google's own origin.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AGY_RELAY_UPSTREAM, AgyKeyRelay, type AgyUpstreamRequest } from "../src/agy-key-relay";

const KEY = "AIza-relay-test-key-0123456789";
const SECRET = "s3cr3t-prefix";

interface Seen { url: string; method: string; headers: http.IncomingHttpHeaders; body: string }

let fake: http.Server | undefined;
let relay: AgyKeyRelay | undefined;
afterEach(async () => {
  await relay?.close();
  await new Promise<void>((resolve) => fake ? fake.close(() => resolve()) : resolve());
  fake = undefined;
  relay = undefined;
});

async function setup(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) {
  const seen: Seen[] = [];
  const targets: URL[] = [];
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      seen.push({ url: req.url ?? "", method: req.method ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => fake!.listen(0, "127.0.0.1", () => resolve()));
  const port = (fake.address() as AddressInfo).port;
  const upstream: AgyUpstreamRequest = (url, options) => {
    targets.push(url);
    return http.request({ host: "127.0.0.1", port, path: url.pathname + url.search, method: options.method, headers: options.headers });
  };
  const lines: string[] = [];
  relay = new AgyKeyRelay({ upstream, secret: SECRET, log: (line) => lines.push(line) });
  return { seen, targets, lines };
}

function send(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(url, { method: init.method ?? "GET", headers: init.headers }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

describe("the Antigravity key relay", () => {
  it("presents the real key in place of the harness's, and forwards only to Google", async () => {
    const { seen, targets } = await setup((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); });
    const lease = await relay!.acquire(KEY);
    expect(lease.baseUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/${SECRET}$`));
    const answer = await send(`${lease.baseUrl}/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse&key=leaked`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": "dummy_api_key", authorization: "Bearer dummy", "user-agent": "harness" },
      body: '{"contents":[]}',
    });
    expect(answer).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect(targets.map(String)).toEqual([`${AGY_RELAY_UPSTREAM}/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse`]);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse", body: '{"contents":[]}' });
    expect(seen[0].headers["x-goog-api-key"]).toBe(KEY);
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers["user-agent"]).toBe("harness");
  });

  it("refuses a request without its prefix, and asks Google nothing", async () => {
    const { seen, targets } = await setup((_req, res) => res.end());
    const lease = await relay!.acquire(KEY);
    const origin = lease.baseUrl.slice(0, lease.baseUrl.lastIndexOf("/"));
    for (const path of ["/v1beta/models", "/wrong/v1beta/models", `/${SECRET}x/v1beta/models`, `/${SECRET}`]) {
      expect((await send(`${origin}${path}`)).status).toBe(403);
    }
    expect(targets).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("keeps a path that looks like another host on Google's origin", async () => {
    const { targets } = await setup((_req, res) => res.end());
    const lease = await relay!.acquire(KEY);
    await send(`${lease.baseUrl}//evil.example/steal`);
    expect(targets).toHaveLength(1);
    expect(targets[0].origin).toBe(AGY_RELAY_UPSTREAM);
  });

  it("streams each event as it arrives, and carries concurrent turns", async () => {
    let releaseSecond!: () => void;
    const secondMayGo = new Promise<void>((resolve) => { releaseSecond = resolve; });
    await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\r\n\r\n");
      void secondMayGo.then(() => res.end("data: second\r\n\r\n"));
    });
    const lease = await relay!.acquire(KEY);
    const firstChunk = await new Promise<string>((resolve, reject) => {
      const req = http.request(`${lease.baseUrl}/v1beta/models/x:streamGenerateContent?alt=sse`, { method: "POST" }, (res) => {
        res.once("data", (d) => resolve(String(d)));
      });
      req.on("error", reject);
      req.end("{}");
    });
    // The upstream has not finished: the relay did not buffer the response.
    expect(firstChunk).toBe("data: first\r\n\r\n");
    const turns = Promise.all([1, 2, 3].map(() => send(`${lease.baseUrl}/v1beta/models/x:streamGenerateContent?alt=sse`, { method: "POST", body: "{}" })));
    releaseSecond();
    expect((await turns).map((turn) => turn.body)).toEqual(Array(3).fill("data: first\r\n\r\ndata: second\r\n\r\n"));
  });

  it("passes Google's own error status and body through", async () => {
    const refusal = '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}';
    await setup((_req, res) => { res.writeHead(400, { "content-type": "application/json" }); res.end(refusal); });
    const lease = await relay!.acquire(KEY);
    expect(await send(`${lease.baseUrl}/v1beta/models/x:streamGenerateContent`, { method: "POST", body: "{}" }))
      .toMatchObject({ status: 400, body: refusal });
  });

  it("answers 502 when Google cannot be reached", async () => {
    const lines: string[] = [];
    relay = new AgyKeyRelay({
      secret: SECRET,
      log: (line) => lines.push(line),
      upstream: (_url, options) => http.request({ host: "127.0.0.1", port: 1, path: "/", method: options.method, headers: options.headers }),
    });
    const lease = await relay.acquire(KEY);
    const answer = await send(`${lease.baseUrl}/v1beta/models`);
    expect(answer.status).toBe(502);
    expect(answer.body).not.toContain(KEY);
    expect(lines.at(-1)).toMatch(/^\[agy-relay\] 502 GET \/v1beta\/models \(ECONNREFUSED\)$/);
  });

  it("logs status, method and path only: never the key, the prefix, a query or a body", async () => {
    const { lines } = await setup((_req, res) => { res.writeHead(200); res.end("secret response text"); });
    const lease = await relay!.acquire(KEY);
    await send(`${lease.baseUrl}/v1beta/models/x:generateContent?key=${KEY}&alt=sse`, { method: "POST", body: "secret prompt text" });
    await send(`${lease.baseUrl.replace(SECRET, "guess")}/v1beta/models`);
    expect(lines).toEqual(["[agy-relay] 200 POST /v1beta/models/x:generateContent", "[agy-relay] 403 GET"]);
    const all = lines.join("\n");
    for (const secret of [KEY, SECRET, "alt=sse", "secret prompt", "secret response"]) expect(all).not.toContain(secret);
    expect(relay!.redact(`baseUrl ${lease.baseUrl}`)).not.toContain(SECRET);
  });

  describe("the model listing", () => {
    const LISTING = '{"models":[{"name":"models/gemini-4-argon","supportedGenerationMethods":["generateContent"]}]}';
    const FRESH = '{"models":[{"name":"models/gemini-5","supportedGenerationMethods":["generateContent"]}]}';
    const PATH = "/v1beta/models?pageSize=1000";

    function store() {
      const saved: { value?: import("../src/agy-key-relay").AgyModelListing } = {};
      return { saved, listings: { get: () => saved.value, set: (next: NonNullable<typeof saved.value>) => { saved.value = next; } } };
    }

    async function setupWith(listings: ReturnType<typeof store>["listings"], handler: Parameters<typeof setup>[0]) {
      const ctx = await setup(handler);
      const upstream: AgyUpstreamRequest = (url, options) => {
        ctx.targets.push(url);
        const port = (fake!.address() as AddressInfo).port;
        return http.request({ host: "127.0.0.1", port, path: url.pathname + url.search, method: options.method, headers: options.headers });
      };
      relay = new AgyKeyRelay({ upstream, secret: SECRET, log: (line) => ctx.lines.push(line), listings });
      ctx.targets.length = 0;
      return ctx;
    }

    const until = async (check: () => boolean) => {
      for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(check()).toBe(true);
    };

    it("answers a later start at once from the last listing, and refreshes it from Google behind", async () => {
      const { saved, listings } = store();
      let body = LISTING;
      let hold = false;
      const held: Array<() => void> = [];
      const { seen, lines } = await setupWith(listings, (_req, res) => {
        const answer = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); };
        if (hold) held.push(answer); else answer();
      });
      const lease = await relay!.acquire(KEY);
      expect(await send(`${lease.baseUrl}${PATH}`)).toMatchObject({ status: 200, body: LISTING });
      expect(saved.value?.body).toBe(LISTING);
      expect(JSON.stringify(saved.value)).not.toContain(KEY);

      // Google is now slow: the answer must not wait for it.
      hold = true;
      body = FRESH;
      expect(await send(`${lease.baseUrl}${PATH}`)).toMatchObject({ status: 200, body: LISTING });
      await until(() => held.length === 1);
      expect(seen.at(-1)?.headers["x-goog-api-key"]).toBe(KEY);
      held[0]();
      await until(() => saved.value?.body === FRESH);
      expect(lines).toContain("[agy-relay] 200 GET /v1beta/models (remembered)");
      expect(lines).toContain("[agy-relay] 200 GET /v1beta/models (refresh)");
    });

    it("keeps a listing that lands after the server has given up", async () => {
      const { saved, listings } = store();
      let answer!: () => void;
      await setupWith(listings, (_req, res) => { answer = () => { res.writeHead(200); res.end(LISTING); }; });
      const lease = await relay!.acquire(KEY);
      await new Promise<void>((resolve) => {
        const req = http.request(`${lease.baseUrl}${PATH}`);
        req.on("error", () => resolve());
        req.end();
        void until(() => answer !== undefined).then(() => { req.destroy(); resolve(); });
      });
      // Let the relay see the hang-up before Google answers, as at 08:58:15.
      await new Promise((r) => setTimeout(r, 150));
      answer();
      await until(() => saved.value?.body === LISTING);
    });

    it("never shows one key's listing to another, and remembers only a real listing", async () => {
      const { saved, listings } = store();
      let body = LISTING;
      const { seen } = await setupWith(listings, (_req, res) => { res.writeHead(200); res.end(body); });
      const lease = await relay!.acquire(KEY);
      await send(`${lease.baseUrl}${PATH}`);
      const before = seen.length;
      await relay!.acquire("another-key");
      body = FRESH;
      expect((await send(`${lease.baseUrl}${PATH}`)).body).toBe(FRESH);
      expect(seen.length).toBe(before + 1);

      saved.value = undefined;
      body = '{"error":"nope"}';
      await send(`${lease.baseUrl}${PATH}`);
      body = "";
      await send(`${lease.baseUrl}${PATH}`);
      expect(saved.value).toBeUndefined();
    });
  });

  it("closes with its last lease, and the newest key wins while it is open", async () => {
    const { seen } = await setup((_req, res) => res.end());
    const first = await relay!.acquire("first-key");
    const second = await relay!.acquire("second-key");
    expect(second.baseUrl).toBe(first.baseUrl);
    await send(`${first.baseUrl}/v1beta/models`);
    expect(seen.at(-1)?.headers["x-goog-api-key"]).toBe("second-key");
    first.release();
    first.release();
    expect(relay!.active).toBe(true);
    second.release();
    expect(relay!.active).toBe(false);
    await expect(send(`${first.baseUrl}/v1beta/models`)).rejects.toThrow();
    const again = await relay!.acquire("third-key");
    await send(`${again.baseUrl}/v1beta/models`);
    expect(seen.at(-1)?.headers["x-goog-api-key"]).toBe("third-key");
  });
});
