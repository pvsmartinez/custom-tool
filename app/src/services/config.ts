/**
 * Single source of truth for workspace-internal constants.
 *
 * Import from here instead of redeclaring in each service.
 */

/** Folder name (inside the workspace root) used for app config/logs/marks. */
export const CONFIG_DIR = 'cafezin';

/**
 * Directory / file names that should be skipped when walking the workspace
 * file tree (listing, searching, etc.).
 */
export const WORKSPACE_SKIP = new Set([
  'node_modules',
  '.git',
  'cafezin',
  'target',
  '.DS_Store',
]);
