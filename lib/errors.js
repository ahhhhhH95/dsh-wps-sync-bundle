'use strict'

/**
 * Errors thrown by the sync engine.
 *
 * The bridge and the tools both surface `message` verbatim, so messages are
 * written for the person reading the panel, not for a log parser.
 */

class SyncError extends Error {
  /**
   * @param {string} message human readable, already localized
   * @param {{code?: string, status?: number, details?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'SyncError'
    this.code = options.code ?? 'wps-sync/error'
    this.status = options.status ?? 400
    if (options.details !== undefined) this.details = options.details
  }
}

/** A caller supplied something the engine refuses (bad enum, traversal, ...). */
function badRequest(message, code = 'wps-sync/bad-request', details) {
  return new SyncError(message, { code, status: 400, details })
}

/** A precondition of the environment is not met (no sync root, missing dir). */
function notReady(message, code = 'wps-sync/not-ready', details) {
  return new SyncError(message, { code, status: 409, details })
}

/** Something on disk or in a remote archive cannot be trusted. */
function corrupt(message, code = 'wps-sync/corrupt', details) {
  return new SyncError(message, { code, status: 422, details })
}

module.exports = { SyncError, badRequest, notReady, corrupt }