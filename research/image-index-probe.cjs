#!/usr/bin/env node
/**
 * What does the grok CLI count when it resolves an `[Image #N]` reference?
 *
 * ANSWERED — this probe drove the 2026-08-12 fix. Numbering is now PER-MESSAGE
 * (`withPerMessageImageIndices`, src/chips.ts). Kept because it is the only
 * thing that can re-check the CLI's side of the contract when grok updates.
 *
 * WHY (at the time). Our index was SESSION-scoped (`++session.imageCounter`,
 * sidebar.ts) and `prompt-builder.ts` writes that number into the tag the agent
 * reads. The CLI evidently numbers the images IT can see, starting at 1 — so
 * attaching one image, then another in a later message, had us say `#2` while
 * the CLI said `#1`, and `image_edit` refused:
 *
 *     image reference "[Image #2]" does not match any attached image.
 *     Available: [Image #1].
 *
 * The fix depends on what "available" means, and that is what this measures:
 *   (a) images in THIS prompt        → per-prompt numbering
 *   (b) images anywhere in the transcript → session numbering, and we are wrong
 *       about something else
 *
 * METHOD. Send two prompts, one image each, tagged the way we tag them. Then
 * ask for a reference that CANNOT exist (`[Image #9]`). The refusal enumerates
 * what the CLI does have, which is the answer — and it costs nothing to
 * generate, because the tool fails before doing any work.
 *
 * Run: node research/image-index-probe.cjs [cwd]
 * grok-dependent, so it lives here and never runs under `npm test`.
 */
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const jpeg = require("jpeg-js");

const cwd = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "grok-imgprobe-"));

/** A solid-colour 8x8 JPEG, so the two images are distinguishable if we ever
 *  need the model to tell them apart. */
function solidJpeg(r, g, b) {
  const width = 8;
  const height = 8;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return jpeg.encode({ data, width, height }, 90).data.toString("base64");
}

const proc = spawn("grok", ["agent", "stdio"], { cwd, env: process.env, shell: true });
const rl = createInterface({ input: proc.stdout });

let nextId = 1;
const pending = new Map();
const agentText = [];
const toolEvents = [];

function request(method, params, timeoutMs = 300000) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout on ${method}`));
      }
    }, timeoutMs);
  });
}

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    return msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  }
  // Auto-approve so a tool call reaches its own error instead of ours.
  if (msg.method === "session/request_permission" && msg.id !== undefined) {
    const opts = msg.params?.options || [];
    const pick = opts.find((o) => /allow/i.test(o.optionId || "")) || opts[0];
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { outcome: { outcome: "selected", optionId: pick && pick.optionId } },
      }) + "\n",
    );
    return;
  }
  const u = msg.params?.update;
  if (!u) return;
  if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
    agentText.push(u.content.text);
  }
  if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
    toolEvents.push({
      title: u.title,
      status: u.status,
      content: JSON.stringify(u.content || u.rawOutput || "").slice(0, 1200),
    });
  }
});

proc.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));

/** The tag `prompt-builder.ts` writes for an inlined image. */
const tag = (n) => `[Image #${n}] (attached inline — already visible to you; do not read it from disk)`;

(async () => {
  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  });
  const { sessionId } = await request("session/new", { cwd, mcpServers: [] });
  console.log(`session ${sessionId}\ncwd ${cwd}\n`);

  console.log("--- prompt 1: one image, tagged #1 ---");
  agentText.length = 0;
  await request("session/prompt", {
    sessionId,
    prompt: [
      { type: "text", text: `${tag(1)}\n\nReply with exactly: GOT1` },
      { type: "image", mimeType: "image/jpeg", data: solidJpeg(220, 30, 30) },
    ],
  });
  console.log(agentText.join("").trim().slice(0, 300) + "\n");

  console.log("--- prompt 2: a second image, tagged #2, then an impossible reference ---");
  agentText.length = 0;
  toolEvents.length = 0;
  await request("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text:
          `${tag(2)}\n\n` +
          "Call the image_edit tool ONCE with image reference \"[Image #9]\" and prompt \"make it green\". " +
          "That reference is deliberately wrong. When it fails, reply with the tool's EXACT error text " +
          "verbatim and nothing else. Do not retry with a different reference.",
      },
      { type: "image", mimeType: "image/jpeg", data: solidJpeg(30, 30, 220) },
    ],
  });

  console.log("\n=== agent reply ===");
  console.log(agentText.join("").trim().slice(0, 1500));
  console.log("\n=== tool events ===");
  for (const t of toolEvents) console.log(`  ${t.title} [${t.status}] ${t.content}`);
  console.log(
    "\nMEASURED 2026-08-11 against grok 1.0.0 (3cd0d0cbce):\n" +
      '  image reference "[Image #9]" matches no image attached to THIS MESSAGE.\n' +
      "  If it was attached earlier in the conversation, ask the user to re-attach\n" +
      "  it here; otherwise pass an absolute filesystem path or a data: URL.\n\n" +
      "So the CLI resolves a reference against the images on the CURRENT message\n" +
      "only, numbered from 1 — earlier images are not addressable by index at all,\n" +
      "which is why it tells the agent to ask for a re-attach.\n\n" +
      "Our tag has matched that since 2026-08-12: it is the image's position among\n" +
      "the visible image chips of the message it rides on (withPerMessageImageIndices,\n" +
      "src/chips.ts). If a future CLI build changes the answer above, that function\n" +
      "is the one place to change.\n\n" +
      "Note the wording differs from the owner's report ('does not match any\n" +
      "attached image. Available: [Image #1].'), so the message is not stable\n" +
      "across builds — match on behaviour, never on this string.",
  );
  proc.kill();
  process.exit(0);
})().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  proc.kill();
  process.exit(1);
});
