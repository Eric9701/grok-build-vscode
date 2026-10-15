# Projects

A project is a folder. That is the whole definition — no `git init`, no
manifest, no marker file. Grok works inside it, conversations are grouped by it,
and routines are scheduled against it.

## Three ways in

**Add project** — the `+` above the project list, or the button on an empty
rail — offers up to three:

| | You give it | It makes |
|---|---|---|
| **New project** | A name | `~/AFK Pilot/<Name>` |
| **Import a folder** | A folder | Nothing — it records the one you picked |
| **Clone from GitHub** | A repository URL | `~/AFK Pilot/<repo>` |

Machines set up before this changed keep using `~/Grok Build` as that folder,
and nothing moves — splitting your projects across two places to improve a
folder name would be a poor trade.

Which ones appear depends on two things. **Cloning is offered in Coding mode**
(Settings → General → Use this app for) because that is where it belongs;
switching to Coding adds it and takes nothing away. And **importing needs the
desk**: it opens your operating system's folder picker, which a phone or browser
has no way to show. Naming and cloning work from anywhere, because you supply a
name or a URL and the computer running the extension decides where it goes.

If a host offers only one of the three, there is no menu — the button just does
that one thing.

## New project

Type a name. The destination appears underneath as you type, and the folder is
created when you press Create.

`~/AFK Pilot` is where it goes — the same folder the desktop app uses for its
first-run project. It sits directly in your home directory on purpose: on macOS
that location is not privacy-protected the way Desktop, Documents and Downloads
are, so creating it raises no consent dialog, and it stays easy to find in Finder
or Explorer.

You can move the folder afterwards. Nothing tracks it by location beyond the
project list, and you can remove and re-add it from wherever you put it.

Some names are refused, and the form says why:

- anything with `\ / : * ? " < > |`, because those cannot be in a folder name;
- a name ending in a space or a dot, because Windows silently strips those and
  you would end up looking at a folder you did not name;
- Windows device names (`CON`, `NUL`, `LPT1`, and the rest), with or without an
  extension;
- a name starting with `.`, which would hide the folder rather than create it.

## Import a folder

The unchanged path: your operating system's picker opens and whatever you choose
joins the project list.

What happens next differs by app, and deliberately:

- **Desktop** switches to the folder you added and starts a conversation there.
- **VS Code** adds it to Grok's project list and nothing else moves. Adding a
  second folder to a single-folder VS Code window converts it to a multi-root
  workspace, which restarts the extension host and takes running conversations
  with it — so the Explorer, the open folder and every live session stay exactly
  where they were.

## Clone from GitHub

Cloning is available in every mode. The form is one field: type to filter the
repositories this machine can see, or type a URL / `owner/repo` and clone that.
The folder name comes from the repository — `https://github.com/you/project`
becomes `~/AFK Pilot/project` — and is shown before you commit to it. A name
that is already taken asks for a different folder.

**GitHub is a connection**, like Grok or Codex. Settings → Providers shows
whether this machine is signed in and as whom. Connect from that row, or from
the clone form: Connect with the GitHub CLI is the main action, a token is the
quieter advanced path under it. Public URLs still clone without signing in.

A pasted token is an advanced option on both the Settings row and the clone
form, not a competing control. It is sent once to `gh auth login --with-token`
and never stored by us; `gh` owns it after that. Do not put a token in the
clone URL.

Closing the clone form cancels an in-flight `gh` login. Reopening starts the
choice again — a `projectSetup` frame naming a waiting login does not reopen
the form.

**Credentials are git's own.** Whatever you already have set up — a credential
helper, an SSH key, `gh auth login` — is what authenticates. Public repositories
need nothing at all.

### When a private repository fails

Prompts are disabled during the clone on purpose: without that, git blocks
waiting for a username at a terminal that is not on screen, and the form would
hang instead of telling you anything. So a private repository you are not signed
in for fails quickly, and the form offers the next step:

- **Sign in to GitHub** runs `gh auth login` **and then `gh auth setup-git`**.
  At the computer that is a terminal: answer the questions, finish in the
  browser it opens, then try the clone again. From a phone or browser it is
  the same two-step device-code flow the agent connect card uses: first a
  choice (CLI, or a token), then a short code and a button that opens
  GitHub in a new tab. The form stays open so you can Clone again when it
  finishes. The second command is the
  one that matters and is easy to miss: `gh auth login` asks whether to
  configure Git and lets you say no, which would leave the clone failing
  exactly as before. `gh auth setup-git` wires the CLI into Git either way,
  and running it twice is harmless. Nothing here writes a token; `gh` owns
  the credential.
- If the GitHub CLI is not installed, the button instead offers to install it
  and names the exact command first — `winget install --id GitHub.cli -e` on
  Windows, `brew install gh` on macOS, `sudo apt install gh` on Debian/Ubuntu.
- If neither the CLI **nor** a package manager to install it with is on the
  machine — a Mac without Homebrew, or Windows without winget — no button is
  offered, because it would run a command that is not there either. The message
  points at [cli.github.com](https://cli.github.com) instead.

### Why signing out of `gh` may not seem to change anything

If you already had credentials, `gh auth logout` will not necessarily stop
clones working, and that is not a bug. On Windows, Git usually authenticates
through **Git Credential Manager**, which keeps its own token in the Windows
Credential Store. Git asks that helper, not `gh` — so signing out of `gh` leaves
Git exactly as it was. The same is true anywhere Git has a credential helper or
an SSH key configured.

Which is worth knowing for the opposite reason too: **you may never need the
GitHub CLI at all.** It is offered as a way out of a failure, not a requirement.

GitHub answers a private repository you cannot see with "not found" rather than
"not allowed", so a repository that exists but is invisible to you and a typo in
the URL look identical from outside. That is why the message mentions both.

For anything that is not github.com, the failure is reported as git described
it — `gh auth login` cannot help a GitLab or Bitbucket sign-in, and offering it
would send you down the wrong path.

## Telling them apart

The `⋯` on a project row offers **Set color** and **Set icon**. The colour tints
the project's mark; the icon is the mark itself — ninety-five to choose from,
grouped by what projects tend to be (Shapes, Build, Work, Talk, People, Play),
with a search over their names and the plain folder at the top to go back to
none.

Both belong to the project rather than to the machine you set them on, so a
project looks the same in VS Code, in the desktop app, on a Cloud machine and on
your phone. The mark is drawn everywhere the project is named: its row in the
rail, the chip above the message box, the project switcher, and the title above
the file panel. The same project always shows the same glyph — that is the
point of it.

## Recent

**Recent**, above the projects in the rail, is the short way back to what you
were doing: the conversations you sent a message in through AFK Pilot (from VS
Code, the desktop app or your phone), plus the ones you opened here in the last
three days, newest first. It spans every folder, including a folder that is not
one of your projects. A conversation that only exists in an agent's own history
is not in it, and neither is one an automated run started: a headless Grok run,
`codex exec`, a Claude Code SDK script, or a routine. The host builds the list
(`buildRecentSessions`) from its own record of what you sent and opened.

## Removing a project

The `⋯` on a project row offers **Remove**, which takes it out of the list and
leaves the folder alone. Nothing on disk is deleted, ever, by removing a project.

Projects you have finished with can be **archived** instead: they drop out of the
main list but keep their conversations, and routines scheduled against them keep
running.

## Where projects come from

A project is a folder you chose. In VS Code that means: the folder VS Code has
open; a folder you created, cloned or added; and any folder you pinned,
coloured, gave an icon or archived. A folder is never a project just because an
agent ran there — benchmark runs, scripts and other tools drive the same agents
and leave the same history behind.

When this arrived, AFK Pilot added once the folders you had sent a message in
through it (from VS Code, the desktop app or your phone) in the previous 30
days. After that a folder joins Projects only when you say so:

- **Add, create or clone** a project as above.
- **"Add notes to Projects?"** — the first time you send a message in a
  conversation whose folder is not a project, a small strip above the message
  box asks. **Add**, **Not now** (for this conversation), or **Never for this
  folder**. You can answer from your phone too. The setting
  `grok.askToAddProjects` stops the question altogether.
- **Recent** — a conversation's `⋯` offers **Add to Projects** when its folder
  is not one.

**AFK Pilot: Rebuild Projects from recent activity** (command palette) forgets
what that one-time pass added and runs it again with the same 30-day rule. It
leaves everything you chose alone — added, created and cloned folders, pins,
colours, icons, archives and your "Never for this folder" answers — and touches
nothing on disk.

The desktop app and Cloud machines already list only the folders they have open.
On a first run the desktop app opens the checkouts you have been working in —
ten or more conversations in the last ninety days, each in a verified git
repository — once; after that the list is yours, and removing a project does not
bring it back.
