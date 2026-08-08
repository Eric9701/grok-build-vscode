/**
 * Desktop application menu template (pure).
 *
 * Built into a real Electron Menu in main.ts. Kept pure so the packaged-gate
 * on Developer Tools can be unit-tested without spawning Electron.
 */
import type { MenuItemConstructorOptions } from "electron";
import { DESKTOP_APP_FULL_NAME } from "./host-dialogs";

/** Env var set by `scripts/run-desktop.cjs --open-devtools` (desktop-dev). */
export const DESKTOP_OPEN_DEVTOOLS_ENV = "GROK_DESKTOP_OPEN_DEVTOOLS";

/** CLI flag mirrored into the env above; also accepted on the main process argv. */
export const DESKTOP_OPEN_DEVTOOLS_FLAG = "--open-devtools";

/** Packaged/signed builds must not expose a DevTools door. */
export function desktopDevToolsAllowed(isPackaged: boolean): boolean {
  return !isPackaged;
}

/**
 * Open DevTools at startup only when explicitly requested AND the build is
 * unpackaged. Separate from the relay-dev staging URL — someone can want one
 * without the other.
 */
export function shouldOpenDevToolsAtStartup(opts: {
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
}): boolean {
  if (!desktopDevToolsAllowed(opts.isPackaged)) return false;
  const env = opts.env ?? {};
  const flag = env[DESKTOP_OPEN_DEVTOOLS_ENV];
  if (flag === "1" || /^true$/i.test(flag ?? "")) return true;
  const argv = opts.argv ?? [];
  return argv.includes(DESKTOP_OPEN_DEVTOOLS_FLAG);
}

export interface DesktopAppMenuActions {
  addProjectFolder?: () => void;
  removeProjectFolder?: () => void;
}

/** Accelerator for Toggle Developer Tools (works with autoHideMenuBar). */
export const DESKTOP_DEVTOOLS_ACCELERATOR = "CmdOrCtrl+Shift+I";

/**
 * True when a keyboard event should toggle DevTools (unpackaged only).
 * Covers Ctrl/Cmd+Shift+I and F12 — neither needs the menu bar to be visible.
 */
export function isDesktopDevToolsShortcut(input: {
  type?: string;
  key?: string;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}): boolean {
  if (input.type !== "keyDown") return false;
  const key = String(input.key || "");
  if (key === "F12") return true;
  // Electron Input: key is often "I" with modifiers; also accept "i".
  if ((key === "I" || key === "i") && input.shift && (input.control || input.meta) && !input.alt) {
    return true;
  }
  return false;
}

/**
 * Second launch of the same profile (single-instance lock) should open DevTools
 * when the new argv/env asked for it — otherwise `npm run desktop-dev` looks
 * like a silent no-op while a leftover process holds the lock.
 */
export function secondInstanceShouldOpenDevTools(opts: {
  isPackaged: boolean;
  commandLine?: string[];
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (!desktopDevToolsAllowed(opts.isPackaged)) return false;
  const argv = opts.commandLine ?? [];
  if (argv.includes(DESKTOP_OPEN_DEVTOOLS_FLAG)) return true;
  return shouldOpenDevToolsAtStartup({
    isPackaged: opts.isPackaged,
    env: opts.env,
    argv,
  });
}

/**
 * Application menu template: no stock Electron Help links; public repo only.
 * File → Add/Close Project Folder drive multi-folder (rail + config store).
 * View → Toggle Developer Tools only when `!isPackaged`. The accelerator
 * (CmdOrCtrl+Shift+I) is registered with the menu and still fires while
 * autoHideMenuBar hides the bar on Windows — Alt is not required. main.ts also
 * wires F12 / the same chord via before-input-event, and gear → Advanced offers
 * the same action, so discoverability does not depend on a hidden menu bar.
 */
export function desktopAppMenuTemplate(opts: {
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  actions?: DesktopAppMenuActions;
  openPublicRepo?: () => void;
}): MenuItemConstructorOptions[] {
  const isMac = (opts.platform ?? process.platform) === "darwin";
  const openRepo =
    opts.openPublicRepo ??
    (() => {
      /* wired by main */
    });
  const actions = opts.actions;
  const allowDevTools = desktopDevToolsAllowed(opts.isPackaged);

  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: "reload" },
    { role: "forceReload" },
    ...(allowDevTools
      ? [
          {
            role: "toggleDevTools" as const,
            label: "Toggle Developer Tools",
            accelerator: DESKTOP_DEVTOOLS_ACCELERATOR,
          },
        ]
      : []),
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];

  return [
    ...(isMac
      ? [
          {
            label: DESKTOP_APP_FULL_NAME,
            submenu: [
              { role: "about" as const, label: `About ${DESKTOP_APP_FULL_NAME}` },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Add Project Folder…",
          click: () => {
            try {
              actions?.addProjectFolder?.();
            } catch {
              /* best-effort */
            }
          },
        },
        {
          label: "Close Project Folder",
          click: () => {
            try {
              actions?.removeProjectFolder?.();
            } catch {
              /* best-effort */
            }
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit", label: "Quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: viewSubmenu,
    },
    {
      label: "Help",
      submenu: [
        {
          label: "GitHub Repository",
          click: () => {
            openRepo();
          },
        },
        {
          label: `About ${DESKTOP_APP_FULL_NAME}`,
          click: () => {
            openRepo();
          },
        },
      ],
    },
  ];
}
