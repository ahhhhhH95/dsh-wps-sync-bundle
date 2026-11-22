'use strict'

/**
 * Shared constants for the WPS cloud-drive sync bundle.
 *
 * Every value the UI, the tools and the bridge agree on lives here so a single
 * edit keeps the three faces consistent.
 */

/** npm package name; also the client module id and the `plugins.bundle.config` key. */
const PLUGIN_NAME = 'dsh-wps-sync-bundle'

/** Directory created inside the user's WPS sync root. */
const SYNC_SUBDIR = 'DSH-Sync'

/** Archive format version written into every manifest and meta file. */
const SCHEMA_VERSION = 1

/** Prefix of the browser HTTP carrier added to the host web server. */
const HTTP_PREFIX = '/api/wps-sync'

/** Channel of the connection RPC carrier used by the desktop shell. */
const RPC_CHANNEL = '/wps-sync'

/** Version of the plugin-private state document. */
const STATE_VERSION = 1

/** Default excluded directory names / file globs used by the workspace mirror. */
const DEFAULT_EXCLUDES = ['node_modules', '.git', 'dist', '*.log']

/** Default per-file ceiling for mirrored workspace files, in megabytes. */
const DEFAULT_MAX_FILE_MB = 20

/** Default workspace rescan period in seconds. */
const DEFAULT_SCAN_SEC = 60

/**
 * Upper bound for mirroring a single file, in milliseconds.
 *
 * Cloud placeholders (WPS 云盘 / OneDrive) can make a file API call block while
 * the provider hydrates it. The mirroring queue is serial, so one stuck file
 * would otherwise hold every later session export hostage. A bounded read turns
 * that into one failed item instead of a frozen queue.
 * Override with `DSH_WPS_SYNC_COPY_TIMEOUT_MS` (0 disables the bound).
 */
const DEFAULT_COPY_TIMEOUT_MS = 120000

/** Default number of delivery receipts kept per scheduled task. */
const DEFAULT_TASK_HISTORY_LIMIT = 50

/** Default debounce window for turn-end and schedule-change exports. */
const DEFAULT_DEBOUNCE_MS = 1500

/** Largest JSON body accepted by the bridge (matches the host settings carrier). */
const MAX_BODY_BYTES = 262144

/** Largest text body returned by the archive reader. */
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024

/** Longest text the transcript writer keeps from one tool result. */
const TOOL_PREVIEW_CHARS = 320

/** Kinds handled by the export engine. */
const KINDS = Object.freeze(['session', 'workspace', 'tasks'])

/** Item keys used by the persisted state document. */
const TASKS_KEY = 'tasks:global'

module.exports = {
  PLUGIN_NAME,
  SYNC_SUBDIR,
  SCHEMA_VERSION,
  HTTP_PREFIX,
  RPC_CHANNEL,
  STATE_VERSION,
  DEFAULT_EXCLUDES,
  DEFAULT_MAX_FILE_MB,
  DEFAULT_SCAN_SEC,
  DEFAULT_TASK_HISTORY_LIMIT,
  DEFAULT_DEBOUNCE_MS,
  MAX_BODY_BYTES,
  MAX_ARCHIVE_BYTES,
  TOOL_PREVIEW_CHARS,
  KINDS,
  TASKS_KEY,
  DEFAULT_COPY_TIMEOUT_MS,
}