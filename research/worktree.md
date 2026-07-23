# Worktree ACP surface (P2-8)

Probe-confirmed against **Grok Build CLI 0.2.111** (native Windows) on 2026-07-23.

## Methods (all `_`-prefixed on the wire)

Bare `x.ai/git/worktree/*` → `-32601 Method not found`. Use `_x.ai/git/worktree/*`.

| Method | Required params | Response (after JSON-RPC `result`, often double-wrapped `{ result: T }`) |
|---|---|---|
| `_x.ai/git/worktree/create` | `sessionId`, `sourcePath` | `{ status:"creating", sessionId, worktreePath, sourceGitRoot }` |
| `_x.ai/git/worktree/list` | (none) | `{ result: WorktreeRecord[] }` — snake_case fields |
| `_x.ai/git/worktree/show` | `idOrPath` | WorktreeRecord or null |
| `_x.ai/git/worktree/apply` | `sessionId`, `worktreePath` | `{ status:"success", files:[{path,type,additions,deletions}], gitRoot }` |
| `_x.ai/git/worktree/remove` | `worktreePath` | `{ removed:true, resolvedPath }` |

Optional create field: `label` → path under `~/.grok/worktrees/<repo>/<label>`.

### Async create progress

Notification `_x.ai/git/worktree/status` (no request id):

```jsonc
{ "status": "progress", "sessionId": "…", "message": "Creating worktree with fast CoW copy…" }
{ "status": "created", "sessionId": "…", "worktreePath": "…", "commit": "…", "sourceGitRoot": "…",
  "copiedChanges": { "stagedCopied": N, "modifiedCopied": N, "untrackedCopied": N, "deletionsApplied": N, "warnings": [] } }
```

The immediate create RPC already returns `worktreePath`; the status rail is for progress UI.

### List row shape (snake_case)

```jsonc
{
  "id": "my-feature-<hash>",
  "path": "C:\\Users\\…\\.grok\\worktrees\\<repo>\\my-feature",
  "source_repo": "<main checkout>",
  "repo_name": "<basename>",
  "kind": "session",           // also: ab | pool | fork | manual | subagent
  "creation_mode": "linked",
  "git_ref": "HEAD",
  "head_commit": "…",
  "session_id": "<creator>",
  "status": "alive",           // or dead
  "metadata": { "label": "my-feature", "user_provided": false }
}
```

### Notes

- **Apply works with any live `sessionId`** (not only the creator).
- **Remove fails** while a process still has the worktree as cwd (dispose first).
- **CLI management**: `grok worktree list|show|rm|gc|db` (no create — create is ACP or `grok --worktree=`).
- **Sessions are per-cwd**: a worktree session is stored under `~/.grok/sessions/<urlencoded-worktree-path>/`, so history must scan those catalogs too.
- Fork into a worktree is possible via `_x.ai/session/fork` with `newCwd: worktreePath` (conversation copy); the extension's v1 New Worktree Session starts a **fresh** session in the worktree instead.

## Extension mapping

| UI | Flow |
|---|---|
| *New worktree session* | temp/live client → create → `startSession` with `cwd=worktreePath` |
| *Apply worktree* | `apply` with focused sessionId + worktreePath |
| *Remove worktree* | dispose sessions on that path → `remove` → new workspace session |
| History | merge indexes across workspace + worktree cwds; `worktreeLabel` on rows |

Pure helpers: `src/worktree.ts`. ACP methods: `AcpClient.createWorktree` / `listWorktrees` / `applyWorktree` / `removeWorktree`.
