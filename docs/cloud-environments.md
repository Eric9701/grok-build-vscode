# Running in a cloud environment

A **cloud environment** is a machine AFK Pilot runs for you, rather than one you
own. The same host runs there as on your desk — this repository's code, the same
agent CLIs, the same projects and routines — reached from a phone or browser
through [the relay](https://github.com/phuryn/grok-remote).

This page is about what the *host* does differently when it is hosted. The
user-facing half lives in the relay repo's
[cloud environments](https://github.com/phuryn/grok-remote/blob/main/docs/cloud-environments.md).

> **Status: the host side is built and tested. Provisioning is not.** You cannot
> create one yet.

## How the host knows

One environment variable, read in one place:

```bash
GROK_CLOUD_ENVIRONMENT=1
```

`isCloudEnvironment()` in [`src/remote-frames.ts`](../src/remote-frames.ts) is
the only reader. Deliberately not inferred from the platform or the relay URL —
both of those have other reasons to look cloud-shaped, and a host that guesses
wrong about what it is will guess wrong about what it may do.

## What changes

### It says what it is

The device picker shows a **cloud** kind with "(by afkpilot.com)", not "Desktop
app, Linux". Both of those are true and neither is any use: nobody installed a
desktop app, and the operating system of a machine you do not administer is not
information. See [Signing agents in](provider-login.md) for the same principle
applied to sign-in.

### It tells the relay when to wake up

A routine fires on a laptop because somebody opened the laptop. A hosted machine
has nobody to open it, so `nextWakeAt()` in [`src/routines.ts`](../src/routines.ts)
reduces the whole schedule to a single timestamp and posts it to
`/api/environment/wake-at` whenever the schedule changes.

**The relay is told when, never what.** Not the cadence, not the routine's name,
not the prompt — one number. Teaching the relay about routines would put
schedules in a database that deliberately holds no payloads.

`null` is a real value: pausing or deleting your last routine clears the standing
wake, or the machine starts up nightly for something that no longer exists.

Best-effort. A relay that is unreachable or older than the endpoint gets silence,
because a failure here **delays** a routine and never loses one — catch-up is
arithmetic, so a missed window still runs when the machine next comes up.

### Connectors are hidden

`mcpSettings` is withheld. Connecting an MCP connector is a browser OAuth flow at
the vendor, and a hosted machine has no browser — nor, unlike a desk, any
computer to walk over to.

This is the **one** host-local capability that does not re-home. The rest of them
— opening a file, a diff, a URL, settings — are all things the remote client can
do itself, because in a cloud environment it is the only client there is. That
one genuinely cannot: nobody can complete somebody else's OAuth on their behalf.

Hidden rather than shown-and-disabled: a control that explains why it will not
work is still a control that does not work.

### Signing in works; signing out is the interesting case

Connecting an agent uses the device-code flow that any remote client uses
(shipped 3.19.0 — see [Signing agents in](provider-login.md)). It has to work:
there is no desk to fall back to, so a cloud environment with nothing connected
could otherwise never be made usable.

Signing **out** is currently `host-local`, and that classification was reasoned
about a desk: revoking a credential affects every other surface using it. In a
cloud environment, that environment *is* the only surface, so the argument
inverts. Not yet changed, and recorded here because it is a real difference
rather than an oversight.

## What does not change

Everything else. The host is the same binary running the same code: chat,
sessions, projects, file browse and edit, worktrees, routines, permission
prompts and the capability policy all behave exactly as they do on a desk,
because none of them ever depended on who owned the machine.

Two things are worth knowing anyway:

- **`keep-awake.ts` is inert.** It holds an OS wake lock so an idle laptop does
  not drop the uplink; there is no lid to close in a container, and
  `systemd-inhibit` is unavailable. It fails silently, which is what that module
  does by design.
- **Your agent credentials live in the environment.** Sign-in completes there,
  against the vendor, and nothing transits the relay. That is required for Claude
  and good practice for the rest — a token that never moves cannot leak in
  transit — and it means the environment is a credential store.

## Running one yourself

The image and its verification live in the relay repo (`cloud/`), because hosting
is that side's concern. In short: a Linux container with Node, git, the agent
CLIs and a display server, running this repo's desktop host under `Xvfb` with
`--no-sandbox`, given `GROK_RELAY_URL`, `GROK_RELAY_DEVICE_TOKEN` and
`GROK_CLOUD_ENVIRONMENT=1`.

Two things that will bite anyone reproducing it, both fixed here but worth
knowing:

- The desktop app could not start on Linux unpackaged at all until `ebdc6b8` —
  `electron-updater` builds `AppImageUpdater` on first read of `autoUpdater`, and
  its constructor rejects the `"0.0"` version an unpackaged app reports.
- `xvfb-run` cannot authenticate Electron to its own X server in a container, and
  fails in the worst way: the node process vanishes while `xvfb-run` stays alive,
  so the container looks healthy and hosts nothing. Start `Xvfb` directly with
  `-ac`.
