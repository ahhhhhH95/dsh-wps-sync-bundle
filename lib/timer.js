'use strict'

/**
 * Debouncer used for turn-end and schedule-change exports.
 *
 * The host timer service is passed in as `schedule` so the pending callbacks are
 * owned by the plugin fiber; tests inject a plain `setTimeout` based one.
 */

function defaultSchedule(callback, delayMs) {
  const handle = setTimeout(callback, delayMs)
  if (typeof handle.unref === 'function') handle.unref()
  return () => clearTimeout(handle)
}

class Debouncer {
  /**
   * @param {{delayMs?: number, schedule?: (cb: () => void, ms: number) => () => void}} [options]
   */
  constructor(options = {}) {
    this.delayMs = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 0
    this.schedule = typeof options.schedule === 'function' ? options.schedule : defaultSchedule
    /** @type {Map<string, () => void>} */
    this.pending = new Map()
  }

  /** (Re)arm the callback for `key`, replacing any pending run. */
  push(key, callback) {
    this.cancel(key)
    const cancel = this.schedule(() => {
      this.pending.delete(key)
      try {
        callback()
      } catch {
        /* the callback reports its own failures */
      }
    }, this.delayMs)
    this.pending.set(key, cancel)
  }

  has(key) {
    return this.pending.has(key)
  }

  cancel(key) {
    const cancel = this.pending.get(key)
    if (!cancel) return false
    this.pending.delete(key)
    try {
      cancel()
    } catch {
      /* already gone */
    }
    return true
  }

  /** Cancel everything; used by `dispose()`. */
  cancelAll() {
    for (const cancel of this.pending.values()) {
      try {
        cancel()
      } catch {
        /* ignore */
      }
    }
    this.pending.clear()
  }

  get size() {
    return this.pending.size
  }
}

module.exports = { Debouncer }