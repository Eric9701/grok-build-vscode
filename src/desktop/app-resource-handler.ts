import * as fs from "node:fs";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  mediaContentTypeForPath,
  parseByteRange,
} from "./app-resource-policy";

export interface AppResourceRequest {
  url: string;
  headers?: Headers | Record<string, string | string[] | undefined>;
}

export interface AppResourceHandlerOptions {
  resolveResourceUrl: (url: string) => string | null;
  fetchFile: (url: string) => Promise<Response>;
  log?: (message: string) => void;
}

function headerValue(
  headers: AppResourceRequest["headers"],
  name: string,
): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const value =
    record[name.toLowerCase()] ??
    record[name] ??
    Object.entries(record).find(([key]) => key.toLowerCase() === name)?.[1];
  if (Array.isArray(value)) return value.join(", ");
  return value ?? null;
}

function fileStream(fsPath: string, start?: number, end?: number): ReadableStream {
  return Readable.toWeb(
    fs.createReadStream(fsPath, start == null ? undefined : { start, end }),
  ) as unknown as ReadableStream;
}

/** Build the non-document half of the app-resource protocol handler. */
export function createAppResourceHandler(
  options: AppResourceHandlerOptions,
): (request: AppResourceRequest, resourceUrl: string) => Promise<Response> {
  return async (request, resourceUrl) => {
    // This is intentionally the first resource operation. The resolver owns
    // the static-root and registry policy; Range must never widen that policy.
    const fsPath = options.resolveResourceUrl(resourceUrl);
    if (!fsPath) {
      options.log?.(`blocked resource: ${resourceUrl}`);
      return new Response("Forbidden", { status: 403 });
    }

    const contentType = mediaContentTypeForPath(fsPath);
    if (!contentType) {
      // Preserve Chromium's file:// MIME handling for every non-media asset.
      try {
        return await options.fetchFile(pathToFileURL(fsPath).href);
      } catch (error) {
        options.log?.(
          `resource fetch failed ${fsPath}: ${(error as Error).message}`,
        );
        return new Response("Not found", { status: 404 });
      }
    }

    try {
      const size = fs.statSync(fsPath).size;
      const range = parseByteRange(headerValue(request.headers, "range"), size);
      if (range.kind === "unsatisfiable") {
        return new Response(null, {
          status: 416,
          headers: {
            "Content-Range": `bytes */${size}`,
            "Accept-Ranges": "bytes",
          },
        });
      }

      if (range.kind === "single") {
        const length = range.end - range.start + 1;
        return new Response(fileStream(fsPath, range.start, range.end), {
          status: 206,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Length": String(length),
            "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
            "Content-Type": contentType,
          },
        });
      }

      return new Response(fileStream(fsPath), {
        status: 200,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(size),
          "Content-Type": contentType,
        },
      });
    } catch (error) {
      options.log?.(
        `resource fetch failed ${fsPath}: ${(error as Error).message}`,
      );
      return new Response("Not found", { status: 404 });
    }
  };
}
