import { Buffer } from "node:buffer";
import * as path from "node:path";

const ALLOWED_UPLOAD_EXTENSIONS = new Set([".md", ".txt", ".pdf", ".csv", ".xlsx", ".docx"]);
const UUID_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_STAGED_NAME_CHARS = 240;

export type FileUploadResult =
  | { ok: true; name: string; bytes: Buffer }
  | { ok: false; reason: "unsupported-extension" | "invalid-data" | "empty" | "too-large" };

type UploadRefs = Record<string, { uploadedFiles?: string[] } | undefined>;

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function comparisonKey(p: string, platform: NodeJS.Platform): string {
  const resolved = pathApi(platform).resolve(p);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Keep the user-visible basename while removing every path component and
 * host-invalid character a remote sender could use. */
export function sanitizeUploadedFileName(
  supplied: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  let name = (typeof supplied === "string" ? supplied : "").replace(/\\/g, "/").split("/").pop() ?? "";
  name = name.replace(/[\0-\x1f\x7f]/g, "_");
  if (platform === "win32") {
    name = name.replace(/[<>:"|?*]/g, "_").replace(/[. ]+$/g, "");
    const ext = path.win32.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    if (WINDOWS_RESERVED_RE.test(stem)) name = `_${name}`;
  }
  if (name.length > MAX_STAGED_NAME_CHARS) {
    const ext = path.posix.extname(name);
    name = name.slice(0, Math.max(1, MAX_STAGED_NAME_CHARS - ext.length)) + ext;
  }
  return name;
}

/** Validate an untrusted byte-carrying upload without allocating beyond the
 * shared attachment limit. The browser's FileReader produces canonical padded
 * base64, so malformed or non-canonical encodings are rejected. */
export function prepareFileUpload(
  suppliedName: unknown,
  data: unknown,
  maxBytes: number,
  platform: NodeJS.Platform = process.platform,
): FileUploadResult {
  const name = sanitizeUploadedFileName(suppliedName, platform);
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(path.posix.extname(name).toLowerCase())) {
    return { ok: false, reason: "unsupported-extension" };
  }
  if (data === "") return { ok: false, reason: "empty" };
  if (typeof data !== "string") return { ok: false, reason: "invalid-data" };
  if (
    data.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  ) {
    return { ok: false, reason: data.length > Math.ceil(maxBytes / 3) * 4 ? "too-large" : "invalid-data" };
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > maxBytes) return { ok: false, reason: "too-large" };
  if (bytes.toString("base64") !== data) return { ok: false, reason: "invalid-data" };
  return { ok: true, name, bytes };
}

/** Return the owned UUID directory for exactly
 * `<stagingRoot>/<uuid>/<filename>`, never for a broader or escaped path. */
export function stagedUploadDirectory(
  stagingRoot: string,
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const api = pathApi(platform);
  const root = api.resolve(stagingRoot);
  const file = api.resolve(filePath);
  const rel = api.relative(comparisonKey(root, platform), comparisonKey(file, platform));
  if (!rel || api.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + api.sep)) return undefined;
  const parts = rel.split(api.sep);
  if (parts.length !== 2 || !UUID_DIR_RE.test(parts[0]) || !parts[1]) return undefined;
  return api.join(root, parts[0]);
}

export function retainedUploadDirectories(
  stagingRoot: string,
  refs: UploadRefs,
  platform: NodeJS.Platform = process.platform,
): Set<string> {
  const out = new Set<string>();
  for (const meta of Object.values(refs)) {
    for (const file of meta?.uploadedFiles ?? []) {
      const dir = stagedUploadDirectory(stagingRoot, file, platform);
      if (dir) out.add(comparisonKey(dir, platform));
    }
  }
  return out;
}

/** Files owned only by the sessions being removed. Shared references (notably
 * source session + fork) remain live until the last referencing session goes. */
export function unreferencedUploadsForRemovedSessions(
  refs: UploadRefs,
  removedIds: Iterable<string>,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const removed = new Set(removedIds);
  const candidates = new Map<string, string>();
  const retained = new Set<string>();
  for (const [id, meta] of Object.entries(refs)) {
    for (const file of meta?.uploadedFiles ?? []) {
      const key = comparisonKey(file, platform);
      if (removed.has(id)) candidates.set(key, file);
      else retained.add(key);
    }
  }
  return [...candidates].filter(([key]) => !retained.has(key)).map(([, file]) => file);
}
