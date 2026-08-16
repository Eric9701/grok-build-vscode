"use strict";

// Session-id state for the fake ACP fixture.
//
// The host treats session ids as globally unique (pool lookups by id before
// cwd). A constant `fake-session-1` makes two workspaces shadow each other.
// `FAKE_SESSION_ID_FROM_PID=1` is not enough on its own: after session/load
// a new process would notify under its own pid-derived constant instead of
// the id that was actually loaded.

const UNIQUE_ENV = "FAKE_UNIQUE_SESSION_IDS";
const FROM_PID_ENV = "FAKE_SESSION_ID_FROM_PID";

function uniqueIdsEnabled(env) {
  return env?.[UNIQUE_ENV] === "1" || env?.[FROM_PID_ENV] === "1";
}

function createFakeSessionState(opts = {}) {
  const env = opts.env ?? process.env;
  const pid = opts.pid ?? process.pid;
  const unique = uniqueIdsEnabled(env);
  let seq = 0;
  let activeId = unique ? undefined : "fake-session-1";

  function mint() {
    seq += 1;
    return `fake-session-${pid}-${seq}`;
  }

  return {
    get id() {
      return activeId ?? (activeId = unique ? mint() : "fake-session-1");
    },
    onNew() {
      activeId = unique ? mint() : "fake-session-1";
      return activeId;
    },
    onLoad(requested) {
      if (typeof requested === "string" && requested.trim()) {
        activeId = requested.trim();
      } else if (!activeId) {
        activeId = unique ? mint() : "fake-session-1";
      }
      return activeId;
    },
  };
}

module.exports = {
  UNIQUE_ENV,
  FROM_PID_ENV,
  uniqueIdsEnabled,
  createFakeSessionState,
};
