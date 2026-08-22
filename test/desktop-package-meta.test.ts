import { describe, it, expect } from "vitest";
import { OFFICIAL_EXTENSION_ID } from "../src/telemetry";
import { extensionIdFromPackageMeta, PACKAGED_EXTENSION_ID_FIELD } from "../src/desktop/package-meta";

describe("extensionIdFromPackageMeta", () => {
  it("prefers grokExtensionId so extraMetadata.name cannot silently disable telemetry", () => {
    expect(PACKAGED_EXTENSION_ID_FIELD).toBe("grokExtensionId");
    expect(extensionIdFromPackageMeta({
      publisher: "PawelHuryn",
      name: "grok-build-desktop",
      grokExtensionId: OFFICIAL_EXTENSION_ID,
    })).toBe(OFFICIAL_EXTENSION_ID);
  });

  it("falls back to publisher.name when the explicit field is absent or blank", () => {
    expect(extensionIdFromPackageMeta({
      publisher: "PawelHuryn",
      name: "grok-build-desktop",
    })).toBe("PawelHuryn.grok-build-desktop");
    expect(extensionIdFromPackageMeta({
      publisher: "PawelHuryn",
      name: "grok-build-desktop",
      grokExtensionId: "  ",
    })).toBe("PawelHuryn.grok-build-desktop");
  });

  it("lets a fork opt out by changing the explicit field", () => {
    expect(extensionIdFromPackageMeta({
      publisher: "Acme",
      name: "grok-build-desktop",
      grokExtensionId: "Acme.grok-fork",
    })).toBe("Acme.grok-fork");
    expect(extensionIdFromPackageMeta({
      publisher: "Acme",
      name: "grok-build-desktop",
    })).not.toBe(OFFICIAL_EXTENSION_ID);
  });
});
