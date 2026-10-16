import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp";
import { GrokSidebar } from "../src/sidebar";
import { MuseBackend } from "../src/muse-backend";

afterEach(() => vi.restoreAllMocks());
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function host() {
  const s: any = Object.create(GrokSidebar.prototype);
  s.providerConnectionState = { muse: true };
  s.adapterHistoryClients = new Map(); s.museHistoryGeneration = 0;
  s.createProviderBackend = () => new MuseBackend();
  s.projectHomeDir = () => "/home/person";
  s.host = { appendLine: vi.fn() };
  const values: Record<string, any> = {};
  s.state = { get: (key: string, fallback: any) => values[key] ?? fallback,
    update: async (key: string, value: any) => { values[key] = value; } };
  return s;
}

describe("Muse shared history lifecycle", () => {
  it("shares one start across concurrent workspace callers and uses home as spawn cwd", async () => {
    const started = deferred(); const s = host();
    const start = vi.spyOn(AcpClient.prototype, "start").mockImplementation(function () {
      expect((this as any).opts.cwd).toBe("/home/person"); return started.promise;
    });
    const one = s.adapterHistoryClient("muse", "/bin/muse");
    const two = s.adapterHistoryClient("muse", "/bin/muse");
    started.resolve();
    expect(await one).toBe(await two);
    expect(start).toHaveBeenCalledOnce();
    (await one).emit("exit", 1);
    expect(s.adapterHistoryClients.size).toBe(0);
  });

  it("awaits old-process disposal before using a changed CLI path", async () => {
    const s = host(); const stopped = deferred();
    const start = vi.spyOn(AcpClient.prototype, "start").mockResolvedValue();
    const dispose = vi.spyOn(AcpClient.prototype, "dispose").mockReturnValue(stopped.promise);
    const old = await s.adapterHistoryClient("muse", "/old/muse");
    const next = s.adapterHistoryClient("muse", "/new/muse");
    await new Promise(resolve => setImmediate(resolve));
    expect(start).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
    stopped.resolve(); expect(await next).not.toBe(old);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("awaits cleanup of a failed start and permits a fresh attempt", async () => {
    const s = host(); const stopped = deferred();
    const start = vi.spyOn(AcpClient.prototype, "start").mockRejectedValueOnce(new Error("failed initialize")).mockResolvedValue();
    vi.spyOn(AcpClient.prototype, "dispose").mockReturnValue(stopped.promise);
    const opening = s.adapterHistoryClient("muse", "/bin/muse");
    const rejected = expect(opening).rejects.toThrow("failed initialize");
    await new Promise(resolve => setImmediate(resolve));
    expect(s.adapterHistoryClients.size).toBe(0);
    stopped.resolve(); await rejected;
    expect(await s.adapterHistoryClient("muse", "/bin/muse")).toBeInstanceOf(AcpClient);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("disconnect during initialize prevents a late process from being retained", async () => {
    const s = host(); const started = deferred(); const stopped = deferred();
    vi.spyOn(AcpClient.prototype, "start").mockReturnValue(started.promise);
    const dispose = vi.spyOn(AcpClient.prototype, "dispose").mockReturnValue(stopped.promise);
    const opening = s.adapterHistoryClient("muse", "/bin/muse");
    const rejected = expect(opening).rejects.toThrow("closed during startup");
    const closing = s.disposeAdapterHistoryClient("muse");
    let closed = false; void closing.then(() => { closed = true; });
    started.resolve(); await new Promise(resolve => setImmediate(resolve));
    expect(dispose).toHaveBeenCalledOnce(); expect(closed).toBe(false);
    stopped.resolve(); await rejected; await closing;
    expect(s.adapterHistoryClients.size).toBe(0);
  });
});


it("invalidates Muse clients on a configured-path change while preserving conversation identity", async () => {
  const s = host(); const stopped = deferred();
  const muse = { provider: "muse", activeSessionId: "keep", hasHistory: true, priming: true, status: "running" };
  const grok = { provider: "grok" };
  s.focused = muse; s.pool = new Set([muse, grok]);
  s.remoteClients = { detachedActiveValues: () => [] };
  s.museSessionCache = new Map([["project", []]]); s.adapterHistoryStamps = new Map([["muse", { at: 1 }]]);
  s.detachClient = vi.fn(() => ({ dispose: () => stopped.promise }));
  s.emit = vi.fn(); s.postProviderState = vi.fn();
  const changing = s.invalidateMuseCli();
  await new Promise(resolve => setImmediate(resolve));
  expect(s.detachClient).toHaveBeenCalledOnce(); expect(s.detachClient).toHaveBeenCalledWith(muse);
  expect(s.postProviderState).not.toHaveBeenCalled();
  stopped.resolve(); await changing;
  expect(muse.activeSessionId).toBe("keep"); expect(muse.hasHistory).toBe(true);
  expect(s.museSessionCache.size).toBe(0); expect(s.adapterHistoryStamps.has("muse")).toBe(false); expect(s.postProviderState).toHaveBeenCalledOnce();
});
