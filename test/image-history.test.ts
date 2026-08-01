import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  historyImagePreviews,
  STAGED_IMAGE_TAG_HINT,
  WORKSPACE_IMAGE_TAG_HINT,
} from "../src/image-history";

describe("history image path resolution", () => {
  const stagingDir = path.join(process.cwd(), "image-staging");
  const workspaceRoot = path.join(process.cwd(), "workspace");

  it("resolves staged basenames and workspace-relative origins by their tag form", () => {
    const images = historyImagePreviews(
      [
        `[Image #1] (image-1.png — ${STAGED_IMAGE_TAG_HINT})`,
        `[Image #2] (assets/hero.png — ${WORKSPACE_IMAGE_TAG_HINT})`,
      ].join("\n"),
      stagingDir,
      workspaceRoot,
    );
    expect(images).toEqual([
      { imageIndex: 1, path: path.join(stagingDir, "image-1.png") },
      { imageIndex: 2, path: path.join(workspaceRoot, "assets", "hero.png") },
    ]);
  });

  it("rejects traversal, separators in staged basenames, and absolute paths", () => {
    const images = historyImagePreviews(
      [
        `[Image #1] (../secret.png — ${WORKSPACE_IMAGE_TAG_HINT})`,
        `[Image #2] (nested/image.png — ${STAGED_IMAGE_TAG_HINT})`,
        `[Image #3] (C:\\secret.png — ${WORKSPACE_IMAGE_TAG_HINT})`,
        `[Image #4] (C:\\secret.png — ${STAGED_IMAGE_TAG_HINT})`,
        `[Image #5] (..\\secret.png — ${STAGED_IMAGE_TAG_HINT})`,
      ].join("\n"),
      stagingDir,
      workspaceRoot,
    );
    expect(images).toEqual([
      { imageIndex: 1 },
      { imageIndex: 2 },
      { imageIndex: 3 },
      { imageIndex: 4 },
      { imageIndex: 5 },
    ]);
  });
});

