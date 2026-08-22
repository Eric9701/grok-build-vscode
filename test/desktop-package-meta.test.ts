import { describe, expect, it } from "vitest";
import { extensionIdFromPackageMeta, PACKAGED_EXTENSION_NAME_FIELD } from "../src/desktop/package-meta";
import { OFFICIAL_EXTENSION_ID } from "../src/telemetry";

describe("extensionIdFromPackageMeta", () => {
  it("restores the name half that extraMetadata.name overwrites", () => {
    expect(PACKAGED_EXTENSION_NAME_FIELD).toBe("grokExtensionName");
    // Exactly what a packaged asar carries: electron-builder has rewritten
    // `name`, so the derived id would otherwise be PawelHuryn.grok-build-desktop.
    expect(extensionIdFromPackageMeta({
      publisher: "PawelHuryn",
      name: "grok-build-desktop",
      grokExtensionName: "grok-vscode-phuryn",
    })).toBe(OFFICIAL_EXTENSION_ID);
  });

  // The property this field must never break. A fork publishes under its own
  // publisher; if the full id were baked into electron-builder.yml the fork
  // would inherit ours and report into the official Aptabase project without
  // anyone intending it. Only the NAME is carried, so `publisher` still decides.
  it("still opts a fork out when it changes publisher", () => {
    expect(extensionIdFromPackageMeta({
      publisher: "Acme",
      name: "grok-build-desktop",
      grokExtensionName: "grok-vscode-phuryn",
    })).toBe("Acme.grok-vscode-phuryn");
    expect(extensionIdFromPackageMeta({
      publisher: "Acme",
      name: "grok-build-desktop",
      grokExtensionName: "grok-vscode-phuryn",
    })).not.toBe(OFFICIAL_EXTENSION_ID);
  });

  it("falls back to the packaged name when the field is missing or blank", () => {
    expect(extensionIdFromPackageMeta({
      publisher: "PawelHuryn",
      name: "grok-build-desktop",
    })).toBe("PawelHuryn.grok-build-desktop");
    expect(extensionIdFromPackageMeta({
      publisher: "PawelHuryn",
      name: "grok-build-desktop",
      grokExtensionName: "   ",
    })).toBe("PawelHuryn.grok-build-desktop");
  });

  it("falls back to the official values only when the package says nothing", () => {
    expect(extensionIdFromPackageMeta({})).toBe(OFFICIAL_EXTENSION_ID);
    expect(extensionIdFromPackageMeta({
      publisher: 7 as unknown as string,
      name: null as unknown as string,
    })).toBe(OFFICIAL_EXTENSION_ID);
  });
});
