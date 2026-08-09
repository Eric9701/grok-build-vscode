const { app, BrowserWindow, net, protocol, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");

delete process.env.ELECTRON_RUN_AS_NODE;
const SCHEME = "app-resource";
const AUTHORITY = "vsc-resource";
// No default media directory on purpose: this repository is public, and the
// clips this was built against live in somebody's session folder. Point it at
// your own with --media-dir=... or MEDIA_HARNESS_DIR.
const arg = (name, fallback) => {
  const prefix = `--${name}=`;
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
};
const mode = arg("mode", "whole");
const preload = ["none", "metadata", "auto"].includes(arg("preload", "none")) ? arg("preload", "none") : "none";
const rounds = Math.max(1, Number(arg("rounds", "8")) || 8);
const playMs = Math.max(500, Number(arg("play-ms", "1800")) || 1800);
const keepPlaying = arg("keep-playing", "0") === "1";
const mediaDirArg = arg("media-dir", process.env.MEDIA_HARNESS_DIR || "");
if (!mediaDirArg) {
  process.stderr.write(
    "media-range-harness needs a directory of clips:\n" +
      "  node scripts/run-media-range-harness.cjs --media-dir=<path to .mp4 files> [--clips=a.mp4,b.mp4]\n",
  );
  process.exit(2);
}
const mediaDir = path.resolve(mediaDirArg);
const clipNames = arg("clips", "1.mp4,2.mp4,3.mp4,4.mp4,5.mp4,6.mp4").split(",").map((x) => x.trim()).filter(Boolean);
const outputPath = arg("output", process.env.MEDIA_HARNESS_OUTPUT || "");
const output = outputPath ? fs.createWriteStream(path.resolve(outputPath), { flags: "w" }) : null;
let compiledHandler = null;
if (mode === "compiled") {
  const compiledPath = path.resolve(arg("compiled-handler", path.join(__dirname, "..", "out", "desktop", "app-resource-handler.js")));
  const { createAppResourceHandler: createCompiledAppResourceHandler } = require(compiledPath);
  compiledHandler = createCompiledAppResourceHandler({
    resolveResourceUrl(url) {
      return resourceFor(url)?.fsPath || null;
    },
    fetchFile(url) {
      return net.fetch(url);
    },
  });
}
const startedAt = Date.now();
let nextRequestId = 1;
let mainRequestCount = 0;
let rendererEventCount = 0;
let debuggerNetworkCount = 0;

function log(record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  process.stdout.write(line + "\n");
  if (output) output.write(line + "\n");
}
function requestHeaders(request) {
  if (request.headers && typeof request.headers.entries === "function") return Object.fromEntries(request.headers.entries());
  return { ...(request.headers || {}) };
}
function plainHeaders(headers) {
  if (headers && typeof headers.entries === "function") return Object.fromEntries(headers.entries());
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) result[key.toLowerCase()] = String(value);
  return result;
}
function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value || "").trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}
function accountedStream(body, requestId, metadata) {
  if (!body) { log({ type: "main-stream", requestId, outcome: "no-body", ...metadata }); return null; }
  const reader = body.getReader();
  let bytes = 0;
  let finished = false;
  const finish = (outcome, extra = {}) => {
    if (finished) return;
    finished = true;
    log({ type: "main-stream", requestId, outcome, bytes, ...metadata, ...extra });
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { finish("completed"); controller.close(); return; }
        bytes += chunk.value.byteLength || chunk.value.length || 0;
        controller.enqueue(chunk.value);
      } catch (error) {
        finish("errored", { error: String(error && error.message ? error.message : error) });
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish("cancelled", { reason: String(reason || "") });
      try { await reader.cancel(reason); } catch {}
    },
  });
}
function resourceFor(url) {
  const parsed = new URL(url);
  const file = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!clipNames.includes(file)) return null;
  const root = path.resolve(mediaDir) + path.sep;
  const fsPath = path.resolve(mediaDir, file);
  if (!fsPath.startsWith(root) || !fs.existsSync(fsPath)) return null;
  return { file, fsPath };
}
async function wholeResponse(fsPath, requestId, info) {
  const upstream = await net.fetch(pathToFileURL(fsPath).href);
  log({ type: "main-response", requestId, mode: "whole", status: upstream.status, headers: plainHeaders(upstream.headers), sentRange: false });
  return new Response(accountedStream(upstream.body, requestId, { mode: "whole", file: info.file, requestedRange: info.range || null, responseStatus: upstream.status }), { status: upstream.status, headers: upstream.headers });
}
async function wholeDirectResponse(fsPath, requestId, info) {
  const upstream = await net.fetch(pathToFileURL(fsPath).href);
  log({ type: "main-response", requestId, mode: "direct", status: upstream.status, headers: plainHeaders(upstream.headers), sentRange: false });
  return upstream;
}
function rangeResponse(fsPath, requestId, info) {
  const size = fs.statSync(fsPath).size;
  const range = parseRange(info.range, size);
  if (!range) {
    const headers = { "Accept-Ranges": "bytes", "Content-Length": String(size), "Content-Type": "video/mp4" };
    log({ type: "main-response", requestId, mode: "range", status: 200, headers: plainHeaders(headers), sentRange: false });
    return new Response(accountedStream(Readable.toWeb(fs.createReadStream(fsPath)), requestId, { mode: "range", file: info.file, requestedRange: info.range || null, responseStatus: 200 }), { status: 200, headers });
  }
  const length = range.end - range.start + 1;
  const headers = { "Accept-Ranges": "bytes", "Content-Length": String(length), "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Content-Type": "video/mp4" };
  log({ type: "main-response", requestId, mode: "range", status: 206, headers: plainHeaders(headers), sentRange: { ...range, size } });
  return new Response(accountedStream(Readable.toWeb(fs.createReadStream(fsPath, { start: range.start, end: range.end })), requestId, { mode: "range", file: info.file, requestedRange: info.range || null, responseStatus: 206, sentRange: range }), { status: 206, headers });
}
async function compiledResponse(request, requestId, info) {
  const response = await compiledHandler(request, request.url);
  const headers = plainHeaders(response.headers);
  const contentRange = headers["content-range"] || "";
  const sentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
  log({ type: "main-response", requestId, mode: "compiled", status: response.status, headers, sentRange: sentRange ? { start: Number(sentRange[1]), end: Number(sentRange[2]), size: Number(sentRange[3]) } : false });
  const body = accountedStream(response.body, requestId, { mode: "compiled", file: info.file, requestedRange: info.range || null, responseStatus: response.status });
  return new Response(body, { status: response.status, headers: response.headers });
}
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
}
function registerHandler() {
  protocol.handle(SCHEME, async (request) => {
    const requestId = nextRequestId++;
    mainRequestCount++;
    const headers = requestHeaders(request);
    const range = headers.range || headers.Range || "";
    const item = resourceFor(request.url);
    log({ type: "main-request", requestId, url: request.url, method: request.method, headers, range: range || null, file: item && item.file, accepted: Boolean(item) });
    if (!item) return new Response("Not found", { status: 404 });
    try {
      const info = { file: item.file, range };
      if (mode === "compiled") return compiledResponse(request, requestId, info);
      if (mode === "range") return rangeResponse(item.fsPath, requestId, info);
      if (mode === "direct") return wholeDirectResponse(item.fsPath, requestId, info);
      return wholeResponse(item.fsPath, requestId, info);
    } catch (error) {
      log({ type: "main-response", requestId, mode, status: 500, error: String(error && error.message ? error.message : error) });
      return new Response("Internal error", { status: 500 });
    }
  });
}

const rendererEvents = ["loadstart", "loadedmetadata", "loadeddata", "canplay", "canplaythrough", "play", "playing", "pause", "waiting", "stalled", "suspend", "progress", "seeking", "seeked", "timeupdate", "ended", "emptied", "abort", "error"];
function rendererHtml(config) {
  return `<!doctype html><meta charset="utf-8"><title>Media range harness</title><body><main id="clips"></main><script>
const config=${JSON.stringify(config)}; const eventNames=${JSON.stringify(rendererEvents)}; const videos=[];
function send(x){window.mediaHarness.send({...x,at:performance.now()});}
function ranges(v){const a=[];try{for(let i=0;i<v.buffered.length;i++)a.push({start:v.buffered.start(i),end:v.buffered.end(i)});}catch(e){a.push({error:String(e)});}return a;}
function snap(v){return {readyState:v.readyState,networkState:v.networkState,currentTime:v.currentTime,duration:v.duration,paused:v.paused,ended:v.ended,buffered:ranges(v),error:v.error?{code:v.error.code,message:v.error.message||""}:null};}
for(const clip of config.clips){const v=document.createElement("video");v.id="video-"+clip;v.controls=true;v.muted=true;v.preload=config.preload;v.width=320;v.height=180;for(const name of eventNames)v.addEventListener(name,()=>send({type:"renderer-event",round:v.__harnessRound,clip,event:name,...snap(v)}));document.getElementById("clips").appendChild(v);videos.push({clip,video:v});}
const delay=(ms)=>new Promise(r=>setTimeout(r,ms));
function waitSignal(v,ms){return new Promise(resolve=>{let done=false;const finish=x=>{if(done)return;done=true;clearTimeout(timer);resolve(x);};const timer=setTimeout(()=>finish("timeout"),ms);v.addEventListener("playing",()=>finish("playing"),{once:true});v.addEventListener("error",()=>finish("error"),{once:true});v.addEventListener("ended",()=>finish("ended"),{once:true});});}
async function attempt(round,item){const {clip,video}=item;video.__harnessRound=round;send({type:"attempt",round,clip,action:"prepare",...snap(video)});video.pause();video.removeAttribute("src");video.load();video.src=config.urls[clip];video.preload=config.preload;video.load();send({type:"attempt",round,clip,action:"load-called",...snap(video)});let playResult="pending";try{await video.play();playResult="resolved";}catch(e){playResult="rejected: "+(e&&e.name?e.name+": "+e.message:e);}send({type:"attempt",round,clip,action:"play-result",playResult,...snap(video)});const signal=!video.paused&&video.readyState>=3?"already-playing":await waitSignal(video,Math.min(2200,config.playMs));await delay(config.playMs);const after=snap(video);if(!config.keepPlaying)video.pause();send({type:"attempt",round,clip,action:"finished",signal,playResult,advanced:after.currentTime>.25,...after});await delay(120);}
async function run(){send({type:"run",action:"start",config});for(let r=1;r<=config.rounds;r++)for(const item of videos)await attempt(r,item);send({type:"run",action:"complete"});window.mediaHarness.complete();}window.mediaHarness.onBegin(()=>run().catch(e=>{send({type:"run",action:"error",error:String(e&&e.stack?e.stack:e)});window.mediaHarness.complete();}));
</script>`;
}

async function main() {
  log({ type: "main", action: "starting", mode, preload, mediaDir, rounds, playMs, keepPlaying });
  if (!fs.existsSync(mediaDir)) throw new Error(`media directory not found: ${mediaDir}`);
  const harnessUserData = path.join(app.getPath("temp"), `media-range-harness-user-data-${process.pid}`);
  fs.mkdirSync(harnessUserData, { recursive: true });
  app.setPath("userData", harnessUserData);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  log({ type: "main", action: "isolated-electron-state", userData: harnessUserData });
  const clips = clipNames.filter((name) => fs.existsSync(path.join(mediaDir, name)));
  if (!clips.length) throw new Error("no clips found");
  log({ type: "main", action: "registering-scheme" });
  registerScheme();
  log({ type: "main", action: "waiting-for-app" });
  await app.whenReady();
  log({ type: "main", action: "app-ready" });
  registerHandler();
  log({ type: "main", action: "protocol-handler-ready" });
  const win = new BrowserWindow({ width: 1100, height: 900, show: true, webPreferences: { preload: path.join(__dirname, "media-range-harness-preload.cjs"), contextIsolation: true, sandbox: false } });
  log({ type: "main", action: "window-created" });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => log({ type: "renderer-load", action: "failed", errorCode, errorDescription, validatedURL }));
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => log({ type: "renderer-console", level, message, line, sourceId }));
  ipcMain.on("media-harness-renderer", (_event, record) => { rendererEventCount++; log(record); });
  ipcMain.on("media-harness-complete", () => { log({ type: "run-summary", mode, preload, rounds, clips, playMs, mainRequestCount, rendererEventCount, debuggerNetworkCount, elapsedMs: Date.now() - startedAt }); setTimeout(() => { if (output) output.end(); app.quit(); }, 300); });
  const urls = Object.fromEntries(clips.map((clip) => [clip, `${SCHEME}://${AUTHORITY}/${encodeURIComponent(clip)}`]));
  const html = rendererHtml({ mode, preload, rounds, playMs, keepPlaying, clips, urls });
  log({ type: "main", action: "loading-page", bytes: Buffer.byteLength(html), urls });
  const htmlPath = path.join(app.getPath("temp"), `media-range-harness-${process.pid}.html`);
  fs.writeFileSync(htmlPath, html, "utf8");
  win.webContents.on("did-finish-load", () => log({ type: "main", action: "did-finish-load" }));
  const beginWithDebugger = async () => {
    try {
      win.webContents.debugger.attach("1.3");
      win.webContents.debugger.on("message", (_event, method, params) => {
        if (!method.startsWith("Network.")) return;
        debuggerNetworkCount++;
        if (["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"].includes(method)) log({ type: "debugger-network", method, params: { requestId: params.requestId, url: params.request && params.request.url, requestHeaders: params.request && params.request.headers, status: params.response && params.response.status, responseHeaders: params.response && params.response.headers, encodedDataLength: params.encodedDataLength, errorText: params.errorText } });
      });
      await Promise.race([win.webContents.debugger.sendCommand("Network.enable"), new Promise((resolve) => setTimeout(resolve, 1000))]);
      log({ type: "debugger-network", action: "enabled-or-timed-out" });
    } catch (error) {
      log({ type: "debugger-network", action: "unavailable", error: String(error && error.message ? error.message : error) });
    }
    win.webContents.send("media-harness-begin");
  };
  setTimeout(() => {
    log({ type: "main", action: "load-call" });
    win.loadFile(htmlPath).then(async () => { log({ type: "main", action: "page-loaded", htmlPath }); await beginWithDebugger(); }).catch((error) => log({ type: "renderer-load", action: "promise-rejected", error: String(error && error.message ? error.message : error) }));
  }, 50);
}
main().catch((error) => { log({ type: "run-summary", mode, error: String(error && error.stack ? error.stack : error) }); if (output) output.end(); app.quit(); });
