'use strict'

/**
 * Serial work queue with per-item dedupe.
 *
 * Two rules matter for this plugin:
 *  - one global serial chain, so a workspace mirror never fights a session
 *    export for the same file;
 *  - at most one job per key, so ten turn-end events for one session collapse
 *    into a single pending export instead of ten sequential ones.
 *
 * Finished jobs stay in a bounded history because the panel renders them.
 */

const crypto = require('node:crypto')

const MAX_HISTORY = 50

function stoppedError(message) {
  return Object.assign(new Error(message), { code: 'wps-sync/queue-stopped', status: 409 })
}

function nowIso(now) {
  return new Date(now()).toISOString()
}

class SyncQueue {
  /**
   * @param {{now?: () => number, maxHistory?: number, createId?: () => string}} [options]
   */
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.maxHistory = Number.isFinite(options.maxHistory) ? options.maxHistory : MAX_HISTORY
    this.createId = typeof options.createId === 'function' ? options.createId : () => crypto.randomUUID()
    /** @type {Map<string, object>} live jobs by key */
    this.live = new Map()
    /** @type {object[]} bounded history, oldest first */
    this.history = []
    this.chain = Promise.resolve()
    /** Set by `stop()`: no new work starts, and queued work is cancelled. */
    this.stopping = false
  }

  /**
   * Enqueue `run` under `key`. Returns the promise of that job's result; a
   * second call with the same key while it is queued or running shares it.
   *
   * @param {{kind: string, key: string, label?: string}} job
   * @param {() => Promise<unknown>} run
   */
  push(job, run) {
    const key = job.key
    if (this.stopping) return Promise.reject(stoppedError('同步已停止，新的任务不再排队'))
    const existing = this.live.get(key)
    if (existing) return existing.promise

    const record = {
      id: job.id ?? this.createId(),
      kind: job.kind,
      key,
      label: job.label ?? null,
      state: 'queued',
      createdAt: nowIso(this.now),
      startedAt: null,
      endedAt: null,
      error: null,
      promise: null,
      resolve: null,
      reject: null,
      run,
    }
    record.promise = new Promise((resolve, reject) => {
      record.resolve = resolve
      record.reject = reject
    })
    this.live.set(key, record)
    // Nobody consumes the promise of a job that the engine queued on its own
    // (turn/end, schedule/changed, the scan tick). A cancellation would otherwise
    // surface as an unhandled rejection during unload.
    record.promise.catch(() => {})
    this.chain = this.chain.then(() => this.#execute(record)).catch(() => {})
    return record.promise
  }

  async #execute(record) {
    if (this.live.get(record.key) !== record) return
    if (this.stopping) {
      this.#cancel(record)
      return
    }
    record.state = 'running'
    record.startedAt = nowIso(this.now)
    try {
      const value = await record.run()
      record.state = 'done'
      record.endedAt = nowIso(this.now)
      record.resolve(value)
    } catch (error) {
      record.state = 'error'
      record.endedAt = nowIso(this.now)
      record.error = error && error.message ? error.message : String(error)
      record.reject(error)
    } finally {
      if (this.live.get(record.key) === record) this.live.delete(record.key)
      this.#remember(record)
    }
  }

  /** Reject a queued job that will never run (unload) and move it to history. */
  #cancel(record) {
    record.state = 'cancelled'
    record.endedAt = nowIso(this.now)
    record.error = '同步已停止：排队任务被取消'
    record.reject(stoppedError(record.error))
    if (this.live.get(record.key) === record) this.live.delete(record.key)
    this.#remember(record)
  }

  #remember(record) {
    this.history.push({
      id: record.id,
      kind: record.kind,
      key: record.key,
      label: record.label,
      state: record.state,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      error: record.error,
    })
    while (this.history.length > this.maxHistory) this.history.shift()
  }

  /** Public job list: queued and running first, then the newest finished. */
  list() {
    return [...this.#liveJobs(), ...this.history]
  }

  /** Every job that is still queued or running, oldest first. */
  liveJobs() {
    return this.#liveJobs()
  }

  #liveJobs() {
    const live = Array.from(this.live.values(), (record) => ({
      id: record.id,
      kind: record.kind,
      key: record.key,
      label: record.label,
      state: record.state,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      error: record.error,
    }))
    live.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    return live
  }

  /** The newest `limit` finished jobs (done / error / cancelled). */
  recentJobs(limit = 20) {
    const size = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 20
    if (size === 0) return []
    return this.history.slice(-size)
  }

  /**
   * Unload semantics: refuse new work and cancel everything still queued.
   *
   * A job that is already running cannot be aborted — its file-system promise
   * belongs to Node, not to us — so it is left to settle (the engine's own
   * `stopping` flag stops it from queueing a follow-up). Returns how many queued
   * jobs were cancelled.
   */
  stop() {
    this.stopping = true
    let cancelled = 0
    for (const record of Array.from(this.live.values())) {
      if (record.state !== 'queued') continue
      this.#cancel(record)
      cancelled += 1
    }
    return cancelled
  }

  get pending() {
    return this.live.size
  }

  has(key) {
    return this.live.has(key)
  }

  /** Resolves when every job enqueued so far has settled. */
  async idle() {
    let guard = 0
    while (this.live.size > 0 && guard < 10000) {
      guard += 1
      await this.chain.catch(() => {})
      if (this.live.size === 0) break
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    return this.live.size === 0
  }

  /** Drop history and stop accepting new work. */
  clear() {
    this.history.length = 0
  }
}

module.exports = { SyncQueue, MAX_HISTORY }