import { describe, expect, it } from "vitest";
import {
  prepareFileUpload,
  retainedUploadDirectories,
  stagedUploadDirectory,
  unreferencedUploadsForRemovedSessions,
} from "../src/file-upload";

describe("phone document upload validation", () => {
  const MAX = 20 * 1024 * 1024;

  it.each(["md", "txt", "pdf", "csv", "xlsx", "docx"])(
    "accepts .%s and preserves the basename",
    (ext) => {
      const result = prepareFileUpload(`folder/Quarterly Notes.${ext}`, Buffer.from("hello").toString("base64"), MAX);
      expect(result).toMatchObject({ ok: true, name: `Quarterly Notes.${ext}` });
      if (result.ok) expect(result.bytes.toString()).toBe("hello");
    },
  );

  it("strips both slash styles so the supplied name cannot traverse", () => {
    const result = prepareFileUpload(
      "..\\..\\private/notes.md",
      Buffer.from("safe").toString("base64"),
      MAX,
      "win32",
    );
    expect(result).toMatchObject({ ok: true, name: "notes.md" });
  });

  it("rejects unsupported extensions, malformed base64, empty files, and oversized files", () => {
    expect(prepareFileUpload("payload.exe", "YQ==", MAX)).toEqual({ ok: false, reason: "unsupported-extension" });
    expect(prepareFileUpload("notes.md", "not base64!", MAX)).toEqual({ ok: false, reason: "invalid-data" });
    expect(prepareFileUpload("notes.md", "", MAX)).toEqual({ ok: false, reason: "empty" });
    expect(prepareFileUpload("notes.md", Buffer.alloc(5).toString("base64"), 4))
      .toEqual({ ok: false, reason: "too-large" });
  });

  it("makes Windows-reserved basenames writable without changing the extension", () => {
    const result = prepareFileUpload("C:\\fake\\CON.txt", "YQ==", MAX, "win32");
    expect(result).toMatchObject({ ok: true, name: "_CON.txt" });
  });
});

describe("uploaded document lifetime", () => {
  const ROOT = "/storage/file-staging";
  const A = `${ROOT}/11111111-1111-4111-8111-111111111111/notes.md`;
  const B = `${ROOT}/22222222-2222-4222-8222-222222222222/report.pdf`;

  it("recognizes only the uuid-directory/filename staging shape", () => {
    expect(stagedUploadDirectory(ROOT, A, "linux"))
      .toBe(`${ROOT}/11111111-1111-4111-8111-111111111111`);
    expect(stagedUploadDirectory(ROOT, `${ROOT}/../outside/secret.md`, "linux")).toBeUndefined();
    expect(stagedUploadDirectory(ROOT, `${ROOT}/not-a-uuid/notes.md`, "linux")).toBeUndefined();
    expect(stagedUploadDirectory(ROOT, `${ROOT}/11111111-1111-4111-8111-111111111111/nested/notes.md`, "linux"))
      .toBeUndefined();
  });

  it("keeps every directory referenced by session metadata", () => {
    expect(retainedUploadDirectories(ROOT, {
      s1: { uploadedFiles: [A] },
      s2: { uploadedFiles: [A, B] },
    }, "linux")).toEqual(new Set([
      `${ROOT}/11111111-1111-4111-8111-111111111111`,
      `${ROOT}/22222222-2222-4222-8222-222222222222`,
    ]));
  });

  it("deletes a removed session's upload only when no remaining session/fork references it", () => {
    const meta = {
      source: { uploadedFiles: [A, B] },
      fork: { uploadedFiles: [A] },
    };
    expect(unreferencedUploadsForRemovedSessions(meta, ["source"], "linux")).toEqual([B]);
    expect(new Set(unreferencedUploadsForRemovedSessions(meta, ["source", "fork"], "linux")))
      .toEqual(new Set([A, B]));
  });
});
