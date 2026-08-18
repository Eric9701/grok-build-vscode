# Command-output replay on `session/load` — all three providers

Measured 2026-08-18. Probe: `research/replay-shape-per-provider-probe.cjs <grok|codex|claude>`
— one live turn running `echo REPLAY_MARKER_4b7c`, then a FRESH process that
`session/load`s the same id and records every tool row. Dumps in
`%TEMP%/replay-shape-<provider>.json`.

Builds: grok CLI 1.0.5; codex-acp and claude-agent-acp as vendored in `node_modules`.

## Result

| | grok | codex | claude |
|---|---|---|---|
| tool rows on replay | yes | **none — 0 rows** | yes |
| output replayed | **yes** | **no** | **yes** |
| best source for OUT | `content` (raw stdout) | — | `rawOutput` (plain string) |
| `content` on replay | raw stdout | — | stdout wrapped in a ```` ```console ```` fence |
| `rawOutput` on replay | `{type:"Bash", output_for_prompt:"exit: 0\n<stdout>\n", exit_code, output_file, …}` | — | the stdout string itself |

**The two live providers want opposite fields.** For grok, `content` is the clean
stdout and `rawOutput.output_for_prompt` carries an `exit: N` prefix line that must
not be shown as output. For claude it inverts: `content` is markdown-fenced
(```` ```console\n<stdout>\n``` ````) and `rawOutput` is the bare string. Hydrating
uniformly from `content` renders literal fences for claude; uniformly from
`rawOutput` renders an `exit: 0` line for grok.

**Codex replays no tool rows at all.** Not the command, not the output. A restored
codex conversation therefore cannot show command history by any client-side means —
this is an adapter/CLI gap, not something a store on our side would fix. Issue #44's
premise (client has the data, CLI won't give it back) is true only for codex, and
for codex the client does not have it either after the process is gone.

## Raw

grok replay, the tool row:

    tool_call  kind="execute"  status="completed"
      title="Execute `echo REPLAY_MARKER_4b7c`"
      rawInput={"variant":"Bash","command":"echo REPLAY_MARKER_4b7c",…}
      content=[{"type":"content","content":{"type":"text","text":"REPLAY_MARKER_4b7c\r\n"}}]
      rawOutput={"type":"Bash","output":[…bytes…],"output_for_prompt":"exit: 0\nREPLAY_MARKER_4b7c\n",
                 "exit_code":0,"command":"echo …","output_file":"…/terminal/call-….log",…}

claude replay, two rows:

    tool_call        kind="execute" status="pending" title="echo REPLAY_MARKER_4b7c"
                     content=[{…text:"Echo replay marker string"}]      <- the DESCRIPTION, not output
    tool_call_update status="completed"
                     content=[{…text:"```console\nREPLAY_MARKER_4b7c\n```"}]
                     rawOutput="REPLAY_MARKER_4b7c"

Note claude's first row's `content` is the tool's human description, so a client that
takes the first `content` it sees renders the description where the output belongs.

codex replay: `session/load` returned no error and emitted **0** `tool_call` /
`tool_call_update` updates.
