// Two host-side boundaries that a widened policy entry opened, both found by
// the unsteered review round before 4.1.0.
//
// The shared mistake is worth naming, because it was made twice in one release:
// `INBOUND_DISPOSITION` gates a message TYPE, and both of these types carry
// something narrower inside them — an ACTION in one case, an ADDRESSEE in the
// other. Widening the type to let a browser do the safe half quietly handed it
// the unsafe half as well.
//
// These live at the HOST because the client-side refusals (already tested in
// add-project.dom.test.ts) are the wrong place to hold the line: the whole
// point of "the relay is policy-free" is that a compromised relay can send
// anything it likes, and the host must still say no.
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";

function makeSidebar(): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.focused = new Session();
  sidebar.remoteClients = new RemoteClientState<Session>("/proj");
  // Object.create skips class-field initializers, so the confirm bookkeeping
  // has to be seeded here or every call reads undefined.
  sidebar.pendingConfirms = new Map();
  sidebar.confirmSeq = 0;
  sidebar.host = { createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() })) };
  sidebar.postProjectSetup = vi.fn();
  sidebar.emit = vi.fn();
  sidebar.captureRemoteRequester = vi.fn(() => "tab-1");
  sidebar.startGithubDeviceLogin = vi.fn();
  return sidebar;
}

describe("installing the GitHub CLI is a desk action, whoever asks", () => {
  it("opens no terminal for a remote, and says where to install instead", async () => {
    const sidebar = makeSidebar();

    await sidebar.setupGithubCli("install", "remote", "client-1");

    // The failure this replaces was silent AND repeatable: each press opened
    // another terminal on a screen nobody is looking at.
    expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
    const posted = sidebar.postProjectSetup.mock.calls.at(-1)?.[0];
    expect(String(posted?.error)).toMatch(/GitHub CLI/i);
    expect(String(posted?.error)).toMatch(/that computer/i);
  });

  it("still opens one at the desk, where a terminal is a thing you can see", async () => {
    const sidebar = makeSidebar();

    await sidebar.setupGithubCli("install", "local");

    expect(sidebar.host.createTerminal).toHaveBeenCalledTimes(1);
  });

  it("runs the headless sign-in for a remote asking to AUTH — the half that is safe", async () => {
    const sidebar = makeSidebar();

    await sidebar.setupGithubCli("auth", "remote", "client-1");

    expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
    expect(sidebar.startGithubDeviceLogin).toHaveBeenCalledWith("client-1");
  });
});

describe("an in-chat confirm may only be answered from the conversation it was asked in", () => {
  it("ignores an answer sent while bound to a different conversation", async () => {
    const sidebar = makeSidebar();
    const asked = new Session();
    const other = new Session();
    sidebar.remoteClients.ready("client-b");
    sidebar.remoteClients.setActive("client-b", other);

    // The confirm belongs to `asked`. Rewind is on the other side of it, and
    // rewind reverts files on disk.
    let settled: boolean | undefined;
    void sidebar.confirmInChat(asked, { title: "Revert files?", confirmLabel: "Rewind" })
      .then((ok: boolean) => { settled = ok; });
    const id = sidebar.emit.mock.calls.at(-1)?.[1]?.id;
    expect(id).toBeTruthy();

    await sidebar.onMessage({ type: "uiConfirmAnswer", id, ok: true }, "remote", "client-b");
    await Promise.resolve();

    expect(settled).toBeUndefined();
  });

  it("settles on an answer from the conversation that was asked", async () => {
    const sidebar = makeSidebar();
    const asked = new Session();
    sidebar.remoteClients.ready("client-a");
    sidebar.remoteClients.setActive("client-a", asked);

    let settled: boolean | undefined;
    void sidebar.confirmInChat(asked, { title: "Revert files?", confirmLabel: "Rewind" })
      .then((ok: boolean) => { settled = ok; });
    const id = sidebar.emit.mock.calls.at(-1)?.[1]?.id;

    await sidebar.onMessage({ type: "uiConfirmAnswer", id, ok: true }, "remote", "client-a");
    await Promise.resolve();

    expect(settled).toBe(true);
  });
});
