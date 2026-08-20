import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { collectMcpNameLayers } from "../src/mcp-connectors";
import {
  MCP_GLOBAL_SCOPE_WARNING,
  MCP_MANAGED_TAG,
  MCP_REMOTE_SERVER_KEYS,
  applyMcpOriginTags,
  mcpCatalogVisibleForCwd,
  mcpOriginTag,
  mcpSettingsVisible,
  mcpServerDetail,
  mergeMcpNotification,
  parseMcpListResponse,
  projectMcpServerForRemote,
  projectMcpServersMessageForRemote,
  taggedMcpServersForCwd,
} from "../src/mcp";

describe("MCP ACP catalog", () => {
  it("parses the wrapped response, sorts display names, and keeps tool metadata", () => {
    const tools = [{ name: "search", description: "Find designs", inputSchema: { type: "object" } }];
    expect(parseMcpListResponse({
      servers: [
        { name: "managed_gateway:canva", displayName: "Canva", source: "managed", type: "managedGateway", session: { enabled: true, status: "ready", tools } },
        { name: "linear", enabled: false, status: "initializing", tools: [{ name: "issues" }] },
      ],
    })).toEqual([
      { name: "managed_gateway:canva", displayName: "Canva", enabled: true, source: "managed", type: "managedGateway", managed: true, status: "ready", tools, toolCount: 1 },
      { name: "linear", enabled: false, status: "initializing", tools: [{ name: "issues" }], toolCount: 1 },
    ]);
  });

  it("accepts a bare array and prefers session state over top-level state", () => {
    expect(parseMcpListResponse(JSON.stringify([
      { name: "zeta", enabled: false, status: "down", session: { enabled: true, status: "ready" } },
      { enabled: true },
    ]))).toEqual([{ name: "zeta", enabled: true, status: "ready" }]);
  });

  it("unwraps the extra result envelope emitted by Grok over ACP", () => {
    expect(parseMcpListResponse({ result: { servers: [{ name: "canva", source: "local" }] } })).toEqual([
      { name: "canva", enabled: true, source: "local" },
    ]);
  });

  it("keeps scopeName from the CLI inventory", () => {
    expect(parseMcpListResponse({
      servers: [{
        name: "managed_gateway:linear",
        displayName: "Linear",
        source: "managed",
        scope: "user",
        scopeName: "Grok CLI",
      }],
    })).toEqual([{
      name: "managed_gateway:linear",
      displayName: "Linear",
      enabled: true,
      source: "managed",
      managed: true,
      scope: "user",
      scopeName: "Grok CLI",
    }]);
  });

  it("rejects a response without a server list", () => {
    expect(() => parseMcpListResponse({})).toThrow("Unexpected response from _x.ai/mcp/list");
  });

  it("merges pushed server health without polling", () => {
    const current = [{ name: "linear", enabled: true, status: "initializing" }];
    expect(mergeMcpNotification(current, "_x.ai/mcp/server_status", {
      name: "linear", status: "unavailable", reason: "handshake_failed", detail: "OAuth required",
    })).toEqual([{ name: "linear", enabled: true, status: "unavailable", error: "OAuth required" }]);
  });

  it("labels a compact server detail", () => {
    expect(mcpServerDetail({
      name: "docs", enabled: true, status: "ready", toolCount: 2, command: "npx", args: ["docs-mcp"],
    })).toBe("ready · 2 tools · npx docs-mcp");
  });

  it("keeps the launch recipe and drops credentials and unknown fields", () => {
    expect(parseMcpListResponse({
      servers: [{
        name: "linear",
        command: "npx",
        args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
        env: { LINEAR_API_KEY: "secret" },
        headers: { Authorization: "Bearer secret" },
        token: "secret",
        apiKey: "secret",
        tools: [{ name: "issues", token: "secret", headers: { Authorization: "x" } }],
      }],
    })).toEqual([{
      name: "linear",
      enabled: true,
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      tools: [{ name: "issues" }],
      toolCount: 1,
    }]);
  });

  it("scopes the read-only warning to the inventory, not the host-owned catalog", () => {
    expect(MCP_GLOBAL_SCOPE_WARNING).toMatch(/this list is read-only/i);
    expect(MCP_GLOBAL_SCOPE_WARNING).toMatch(/machine-global/i);
  });
});

const LEAK_BEARER = "Authorization: Bearer sk_live_repro_token";
const LEAK_TOKEN = "sk_live_repro_token";
const LEAK_PATH = "C:/Users/Alice/AppData/Roaming/npm/npx.cmd";
const LEAK_URL = `https://mcp.linear.app/mcp?api_key=${LEAK_TOKEN}`;

/** Reviewer reproduction: bearer header, tokenized URL, and an absolute user path. */
function leakyMcpWireServer() {
  return {
    name: "linear",
    displayName: "Linear",
    enabled: true,
    source: "local",
    type: "stdio",
    scope: "global",
    status: "unavailable",
    command: LEAK_PATH,
    args: ["-y", "mcp-remote", LEAK_URL, "--header", LEAK_BEARER],
    url: LEAK_URL,
    env: { LINEAR_API_KEY: LEAK_TOKEN },
    headers: { Authorization: LEAK_BEARER },
    error: `spawn EACCES ${LEAK_PATH} --header ${LEAK_BEARER}`,
    tools: [{
      name: "list_issues",
      description: "List issues",
      inputSchema: {
        type: "object",
        properties: {
          token: { default: LEAK_TOKEN },
          path: { default: "C:/Users/Alice/secrets" },
        },
      },
    }],
  };
}

function assertNoMcpLaunchLeak(value: unknown): void {
  const wire = JSON.stringify(value);
  expect(wire).not.toContain(LEAK_BEARER);
  expect(wire).not.toContain(LEAK_TOKEN);
  expect(wire).not.toContain("C:/Users/Alice");
  expect(wire).not.toContain("Authorization");
  expect(wire).not.toContain(LEAK_PATH);
  expect(wire).not.toContain(LEAK_URL);
}

describe("MCP remote inventory projection", () => {
  it("the desk catalog still keeps the launch recipe from the reproduction payload", () => {
    const [desk] = parseMcpListResponse({ servers: [leakyMcpWireServer()] });
    expect(desk.command).toBe(LEAK_PATH);
    expect(desk.args).toEqual(["-y", "mcp-remote", LEAK_URL, "--header", LEAK_BEARER]);
    expect(desk.url).toBe(LEAK_URL);
    expect(desk.error).toContain(LEAK_BEARER);
    expect(desk.error).toContain(LEAK_PATH);
    expect(desk.tools?.[0]?.inputSchema).toEqual(leakyMcpWireServer().tools[0].inputSchema);
    expect(JSON.stringify(desk)).toContain(LEAK_BEARER);
    expect(JSON.stringify(desk)).toContain("C:/Users/Alice");
  });

  it("the remote allowlist is page fields only — not a denylist of today's secrets", () => {
    expect([...MCP_REMOTE_SERVER_KEYS]).toEqual([
      "name", "displayName", "enabled", "source", "type", "managed", "scope", "scopeName", "tag", "status", "toolCount",
    ]);
    expect(MCP_REMOTE_SERVER_KEYS).not.toEqual(expect.arrayContaining([
      "command", "args", "url", "error", "tools", "env", "headers",
    ]));
  });

  it("strips the reproduction leak and any extra key a future parser might add", () => {
    const [desk] = parseMcpListResponse({ servers: [leakyMcpWireServer()] });
    const before = JSON.stringify(desk);
    const remote = projectMcpServerForRemote({
      ...desk,
      env: { LINEAR_API_KEY: LEAK_TOKEN },
      headers: { Authorization: LEAK_BEARER },
    } as typeof desk & { env: unknown; headers: unknown });
    expect(JSON.stringify(desk)).toBe(before);
    expect(remote).toEqual({
      name: "linear",
      displayName: "Linear",
      enabled: true,
      source: "local",
      type: "stdio",
      scope: "global",
      status: "unavailable",
      toolCount: 1,
    });
    expect(Object.keys(remote).every((key) => (MCP_REMOTE_SERVER_KEYS as readonly string[]).includes(key))).toBe(true);
    assertNoMcpLaunchLeak(remote);
    expect(remote).not.toHaveProperty("command");
    expect(remote).not.toHaveProperty("args");
    expect(remote).not.toHaveProperty("url");
    expect(remote).not.toHaveProperty("error");
    expect(remote).not.toHaveProperty("tools");
    expect(remote).not.toHaveProperty("env");
    expect(remote).not.toHaveProperty("headers");
  });

  it("rebuilds the mcpServers envelope without ferrying the desk object", () => {
    const [desk] = parseMcpListResponse({ servers: [leakyMcpWireServer()] });
    const msg = {
      type: "mcpServers" as const,
      servers: [desk],
      warning: MCP_GLOBAL_SCOPE_WARNING,
      loading: false,
    };
    const out = projectMcpServersMessageForRemote(msg);
    expect(out).not.toBe(msg);
    expect(out.servers).not.toBe(msg.servers);
    expect(msg.servers[0]).toBe(desk);
    expect(desk.command).toBe(LEAK_PATH);
    expect(out.warning).toBe(MCP_GLOBAL_SCOPE_WARNING);
    expect(out.loading).toBe(false);
    assertNoMcpLaunchLeak(out);
  });

  it("the desk message builder still emits the unprojected catalog", () => {
    const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    const start = src.indexOf("private mcpServersMessage(");
    const end = src.indexOf("private connectedConnectorStore(", start);
    const body = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain("tagMcpServers");
    expect(body).not.toContain("projectMcp");
  });

  it("classifies Grok inventory against Grok config files even if Codex or Claude is focused", () => {
    const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    const start = src.indexOf("private mcpNameLayersFor(");
    const end = src.indexOf("private tagMcpServers(", start);
    const body = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('provider: "grok"');
    expect(body).not.toContain("session.provider");
    // Host-inject reserved identity stays provider-specific; only the Grok
    // inventory tagger is pinned to grok.
    const reserved = src.slice(
      src.indexOf("private reservedMcpIdentityFor("),
      src.indexOf("private hostMcpServersFor("),
    );
    expect(reserved).toContain("provider: session.provider");
  });

  it("stamps the catalog cwd at read time and classifies against that, not the focused session", () => {
    const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    const refresh = src.slice(
      src.indexOf("private async refreshMcpServers("),
      src.indexOf("private historyCwdFor("),
    );
    expect(refresh).toContain("this.mcpServersCwd = this.sessionCwd(session)");
    const tag = src.slice(
      src.indexOf("private tagMcpServers("),
      src.indexOf("private reservedMcpIdentityFor("),
    );
    expect(tag).toContain("taggedMcpServersForCwd");
    expect(tag).toContain("catalogCwd: this.mcpServersCwd");
    expect(tag).not.toContain("mcpNameLayersFor(session)");
    const notify = src.slice(
      src.indexOf('client.on("mcpNotification"'),
      src.indexOf('client.on("xaiNotification"'),
    );
    expect(notify).toContain("this.mcpServersCwd");
    expect(notify).toContain("pathsEqual(this.sessionCwd(session), this.mcpServersCwd)");
  });
});

describe("MCP origin tags", () => {
  it("uses scopeName for managed connectors and falls back to grok.com", () => {
    expect(mcpOriginTag({ source: "managed", scopeName: "Grok CLI" })).toBe("Grok CLI");
    expect(mcpOriginTag({ source: "managed", scopeName: "Acme" })).toBe("Acme");
    expect(mcpOriginTag({ managed: true })).toBe(MCP_MANAGED_TAG);
  });

  it("attributes local servers as user-on-machine", () => {
    expect(mcpOriginTag({
      source: "local",
      machineName: "Mac (macOS)",
    })).toBe("User on: Mac (macOS)");
    expect(mcpOriginTag({
      source: "local",
      machineName: "Dell (Windows 11)",
    })).toBe("User on: Dell (Windows 11)");
  });

  it("keeps grok.com and user-level rows and drops project-file servers", () => {
    expect(mcpSettingsVisible({ source: "managed" })).toBe(true);
    expect(mcpSettingsVisible({ managed: true })).toBe(true);
    expect(mcpSettingsVisible({ source: "local", localLayer: "user" })).toBe(true);
    expect(mcpSettingsVisible({ source: "local" })).toBe(true);
    expect(mcpSettingsVisible({ source: "local", localLayer: "project" })).toBe(false);
    expect(mcpSettingsVisible({ source: "managed", localLayer: "project" })).toBe(true);

    const layers = new Map<string, "project" | "user">([
      ["docs", "project"],
      ["notes", "user"],
    ]);
    const tagged = applyMcpOriginTags([
      { name: "managed_gateway:canva", displayName: "Canva", enabled: true, source: "managed", managed: true, scopeName: "Grok CLI" },
      { name: "docs", enabled: true, source: "local", command: "npx" },
      { name: "notes", enabled: true, source: "local" },
      { name: "linear", enabled: true, source: "local", command: "npx" },
    ], { nameLayer: layers, machineName: "Mac (macOS)" });
    expect(tagged.map((s) => s.name)).toEqual([
      "managed_gateway:canva",
      "notes",
      "linear",
    ]);
    expect(tagged.map((s) => s.tag)).toEqual([
      "Grok CLI",
      "User on: Mac (macOS)",
      "User on: Mac (macOS)",
    ]);
    expect(tagged.find((s) => s.name === "docs")).toBeUndefined();
    expect(tagged.find((s) => s.name === "notes")?.command).toBeUndefined();
    expect(tagged.find((s) => s.name === "linear")?.command).toBe("npx");
  });

  it("the remote projection copies tag and scopeName, strips recipes, and never sees a project-file row", () => {
    const layers = new Map<string, "project" | "user">([
      ["docs", "project"],
      ["notes", "user"],
    ]);
    const tagged = applyMcpOriginTags([
      { name: "managed_gateway:linear", displayName: "Linear", enabled: true, source: "managed", managed: true, scopeName: "Grok CLI" },
      { name: "docs", enabled: true, source: "local", command: "npx", args: ["-y", "secret"] },
      { name: "notes", enabled: true, source: "local", tag: "stale", command: "npx" },
    ], { nameLayer: layers, machineName: "Dell (Windows 11)" });
    const remote = projectMcpServersMessageForRemote({
      type: "mcpServers",
      servers: tagged,
      warning: MCP_GLOBAL_SCOPE_WARNING,
    });
    expect(remote.servers.map((s) => s.name)).toEqual(["managed_gateway:linear", "notes"]);
    expect(remote.servers[0]).toEqual({
      name: "managed_gateway:linear",
      displayName: "Linear",
      enabled: true,
      source: "managed",
      managed: true,
      scopeName: "Grok CLI",
      tag: "Grok CLI",
    });
    expect(remote.servers[1]).toEqual({
      name: "notes",
      enabled: true,
      source: "local",
      tag: "User on: Dell (Windows 11)",
    });
    expect(JSON.stringify(remote)).not.toContain("docs");
    expect(JSON.stringify(remote)).not.toContain("npx");
    expect(JSON.stringify(remote)).not.toContain("secret");

    const one = projectMcpServerForRemote({
      name: "notes",
      enabled: true,
      source: "local",
      scopeName: "ignored-for-local",
      tag: "User on: Mac (macOS)",
      command: "npx",
      args: ["-y", "secret"],
    });
    expect(one).toEqual({
      name: "notes",
      enabled: true,
      source: "local",
      scopeName: "ignored-for-local",
      tag: "User on: Mac (macOS)",
    });
    expect(one).not.toHaveProperty("command");
  });
});

describe("MCP catalog classified against the workspace it was read from", () => {
  const catalogA = [
    { name: "shared", enabled: true, source: "local" },
    { name: "a-only", enabled: true, source: "local" },
  ];
  const layersA = collectMcpNameLayers([
    { layer: "user", names: ["shared"] },
    { layer: "project", names: ["a-only"] },
  ]);
  const layersB = collectMcpNameLayers([
    { layer: "project", names: ["shared"] },
  ]);
  const sameCwd = (a: string, b: string) => a === b;

  it("the reviewer's mis-classification hid global shared and promoted a-only", () => {
    const buggy = applyMcpOriginTags(catalogA, { nameLayer: layersB, machineName: "Desk" });
    expect(buggy.map((s) => s.name)).toEqual(["a-only"]);
    expect(buggy[0]?.tag).toBe("User on: Desk");
    expect(buggy.find((s) => s.name === "shared")).toBeUndefined();
  });

  it("keeps global shared and omits a-only when A's catalog is classified against A", () => {
    const nameLayerFor = vi.fn((cwd: string) => cwd === "/proj-a" ? layersA : layersB);
    const tagged = taggedMcpServersForCwd({
      servers: catalogA,
      catalogCwd: "/proj-a",
      viewCwd: "/proj-a",
      sameCwd,
      nameLayerFor,
      machineName: "Desk",
    });
    expect(tagged.map((s) => s.name)).toEqual(["shared"]);
    expect(tagged[0]?.tag).toBe("User on: Desk");
    expect(tagged.find((s) => s.name === "a-only")).toBeUndefined();
    expect(nameLayerFor).toHaveBeenCalledWith("/proj-a");
    expect(nameLayerFor).not.toHaveBeenCalledWith("/proj-b");
  });

  it("does not hide global shared or present a-only as user-level when rendered for project B", () => {
    const nameLayerFor = vi.fn((cwd: string) => cwd === "/proj-a" ? layersA : layersB);
    const forB = taggedMcpServersForCwd({
      servers: catalogA,
      catalogCwd: "/proj-a",
      viewCwd: "/proj-b",
      sameCwd,
      nameLayerFor,
      machineName: "Desk",
    });
    expect(forB).toEqual([]);
    expect(forB.find((s) => s.name === "a-only")).toBeUndefined();
    expect(nameLayerFor).not.toHaveBeenCalled();
    expect(mcpCatalogVisibleForCwd("/proj-a", "/proj-b", sameCwd)).toBe(false);
  });

  it("sidebar tagging uses the catalog cwd, so a B session cannot reclassify A's inventory", () => {
    const proto = GrokSidebar.prototype as unknown as {
      mcpServersMessage(session: Session): { type: "mcpServers"; servers: Array<{ name: string; tag?: string }> };
      mcpServersMessageForCwd(viewCwd: string): { type: "mcpServers"; servers: Array<{ name: string; tag?: string }> };
      tagMcpServers: (servers: typeof catalogA, viewCwd: string) => Array<{ name: string; tag?: string }>;
    };
    const instance = Object.create(proto) as {
      mcpServers: typeof catalogA;
      mcpServersCwd: string | undefined;
      sessionCwd: (session: Session) => string;
      mcpNameLayersFor: ReturnType<typeof vi.fn>;
    };
    instance.mcpServers = catalogA;
    instance.mcpServersCwd = "/proj-a";
    instance.sessionCwd = (session) => session.cwd || "";
    instance.mcpNameLayersFor = vi.fn((cwd: string) => cwd === "/proj-a" ? layersA : layersB);

    const sessionA = new Session();
    sessionA.cwd = "/proj-a";
    const sessionB = new Session();
    sessionB.cwd = "/proj-b";

    const forA = proto.mcpServersMessage.call(instance, sessionA);
    expect(forA.servers.map((s) => s.name)).toEqual(["shared"]);
    expect(forA.servers[0]?.tag).toMatch(/^User on: /);
    expect(instance.mcpNameLayersFor).toHaveBeenCalledWith("/proj-a");

    instance.mcpNameLayersFor.mockClear();
    const forB = proto.mcpServersMessage.call(instance, sessionB);
    expect(forB.servers).toEqual([]);
    expect(instance.mcpNameLayersFor).not.toHaveBeenCalled();

    const remoteB = proto.mcpServersMessageForCwd.call(instance, "/proj-b");
    expect(remoteB.servers).toEqual([]);
  });

  it("a remote snapshot for a second tab on another project does not receive A's rows", () => {
    const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    const start = src.indexOf("private buildRemoteSnapshot(");
    const end = src.indexOf("\n  private ", start + "private buildRemoteSnapshot(".length);
    const body = src.slice(start, end < 0 ? src.length : end);
    expect(body).toContain("this.mcpServersMessageForCwd(mcpViewCwd)");
    expect(body).toContain("listCwd ?? cwd");
    expect(body).not.toContain("this.mcpServersMessage(session || this.focused)");
    expect(body).toContain("session && sessionCwdOk");
  });
});
