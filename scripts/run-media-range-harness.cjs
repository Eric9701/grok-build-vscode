const { spawn } = require("node:child_process");
const path = require("node:path");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const electronBin = require("electron");
const mainScript = path.join(__dirname, "media-range-harness-main.cjs");
const child = spawn(electronBin, ["--no-sandbox", "--disable-gpu", "--disable-gpu-compositing", mainScript, ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
