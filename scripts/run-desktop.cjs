#!/usr/bin/env node
/**
 * Launch the Electron desktop app with ELECTRON_RUN_AS_NODE stripped.
 * That env var makes `electron` run as plain Node and kills BrowserWindow
 * before any page code runs (spike-confirmed).
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronBin = require("electron");
const mainJs = path.join(__dirname, "..", "out", "desktop", "main.js");
const child = spawn(electronBin, [mainJs, ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
  // Windows: electron path may be electron.cmd when required — shell helps.
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
