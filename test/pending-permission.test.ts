import { describe, expect, it } from "vitest";
import {
  Session,
  createPendingPermission,
  pendingPermissionOptions,
  preferredPermissionAllowOption,
  sessionUiSnapshot,
  type PendingPermission,
} from "../src/session";

describe("pending permission options", () => {
  const pending: PendingPermission = {
    title: "Run a read-only command",
    toolKind: "execute",
    options: [
      { optionId: "always", kind: "allow_always", name: "Allow always" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ],
    planOptions: [
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ],
  };

  it("keeps persistent grants unavailable while Plan mode is active", () => {
    expect(pendingPermissionOptions(pending, true)).toEqual([
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ]);
    expect(preferredPermissionAllowOption(pending, true)).toBeUndefined();
  });

  it("restores the original grant after the user leaves Plan mode", () => {
    expect(pendingPermissionOptions(pending, false)).toEqual(pending.options);
    expect(preferredPermissionAllowOption(pending, false)).toEqual({
      optionId: "always",
      kind: "allow_always",
      name: "Allow always",
    });
  });

  it("snapshots the option set matching the session's current mode", () => {
    const session = new Session();
    session.pendingPermissions.set(7, pending);

    session.planActive = true;
    expect(sessionUiSnapshot(session, "plan")).toContainEqual({
      type: "permissionOptions",
      requestId: 7,
      options: pending.planOptions,
    });

    session.planActive = false;
    expect(sessionUiSnapshot(session, "agent")).toContainEqual({
      type: "permissionOptions",
      requestId: 7,
      options: pending.options,
    });
  });

  it("caches Plan-safe options when the request arrives in Agent mode", () => {
    const session = new Session();
    session.planActive = false;
    const arrivedInAgentMode = createPendingPermission({
      title: "Run a read-only command",
      toolKind: "execute",
      options: [
        { optionId: "always", kind: "allow_always", name: "Allow always" },
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    });
    session.pendingPermissions.set(8, arrivedInAgentMode);

    expect(pendingPermissionOptions(arrivedInAgentMode, false).map((option) => option.optionId))
      .toEqual(["always", "once", "reject"]);

    session.planActive = true;
    expect(sessionUiSnapshot(session, "plan")).toContainEqual({
      type: "permissionOptions",
      requestId: 8,
      options: [
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    });
  });
});
