/**
 * Re-export: pure file-tree helpers live in `src/file-tree.ts` so the common
 * host path (sidebar / remote browse) does not import from `desktop/`.
 * Desktop modules keep their existing `./file-tree` import paths.
 */
export * from "../file-tree";
