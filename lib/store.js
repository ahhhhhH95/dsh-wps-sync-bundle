'use strict'

/**
 * Plugin-private state document.
 *
 * It lives next to the profile (`<profile>/dsh-wps-sync/state.json`) and holds
 * everything the plugin must remember across restarts: the device identity, the
 * per-item auto-sync flags and last results, the incremental tables, the staged
 * imports and a small error ring.
 *
 * The document is deliberately independent of `ctx.storageDomain`: the domain
 * facility needs zod schemas supplied by the host package graph, which a
 * profile-installed bundle cannot resolve, and a single atomic JSON file is
 * enough for this amount of data.
 */

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const { STATE_VERSION, TASKS_KEY } = require('./constants')
const { readJsonStrict, writeJsonAtomic, ensureDir } = require('./json-file')

const MAX_ERRORS = 50
const CORRUPT_CODE = 'wps-sync/json-invalid'

function emptyState(device) {
  return {
    version: STATE_VERSION,
    device,
    syncRootDir: '',
    defaults: { auto: true },
    items: {},
    workspaceFiles: {},
    imports: [],
    errors: [],
    counters: { uploads: 0, pulls: 0 },
    // Set when a corrupt state file was quarantined; kept durable so the status
    // keeps explaining where the original bytes went.
    stateRecovered: null,
  }
}

/** `<dir>/state.json.corrupt-<timestamp>` — no colons, so Windows accepts it. */
function corruptBackupName(now) {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
  return `state.json.corrupt-${stamp}`
}

function isCorruptState(error) {
  return Boolean(error) && error.code === CORRUPT_CODE
}

function createDevice(options = {}) {
  const source = typeof options === 'string' ? { name: options } : options
  const now = typeof source.now === 'function' ? source.now : () => Date.now()
  return {
    id: crypto.randomUUID(),
    name: source.name || os.hostname() || 'device',
    platform: `${process.platform}/${process.arch}`,
    createdAt: new Date(now()).toISOString(),
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizeState(raw, { deviceName, now }) {
  const source = asObject(raw)
  const deviceSource = asObject(source.device)
  const device =
    typeof deviceSource.id === 'string' && deviceSource.id.length > 0
      ? {
          id: deviceSource.id,
          name: typeof deviceSource.name === 'string' && deviceSource.name ? deviceSource.name : deviceName || os.hostname() || 'device',
          platform: typeof deviceSource.platform === 'string' && deviceSource.platform ? deviceSource.platform : `${process.platform}/${process.arch}`,
          createdAt: typeof deviceSource.createdAt === 'string' ? deviceSource.createdAt : new Date(now()).toISOString(),
        }
      : createDevice({ name: deviceName, now })

  const items = {}
  for (const [key, value] of Object.entries(asObject(source.items))) {
    const item = asObject(value)
    items[key] = {
      auto: item.auto !== false,
      lastSyncAt: typeof item.lastSyncAt === 'string' ? item.lastSyncAt : null,
      lastResult: typeof item.lastResult === 'string' ? item.lastResult : null,
      lastError: typeof item.lastError === 'string' ? item.lastError : null,
      lastHash: typeof item.lastHash === 'string' ? item.lastHash : null,
      lastEventSeq: Number.isFinite(item.lastEventSeq) ? item.lastEventSeq : null,
      exportedAt: typeof item.exportedAt === 'string' ? item.exportedAt : null,
      dir: typeof item.dir === 'string' ? item.dir : null,
      title: typeof item.title === 'string' ? item.title : null,
    }
  }

  const workspaceFiles = {}
  for (const [id, value] of Object.entries(asObject(source.workspaceFiles))) {
    const entry = asObject(value)
    const files = {}
    for (const [rel, meta] of Object.entries(asObject(entry.files))) {
      const record = asObject(meta)
      files[rel] = {
        size: Number.isFinite(record.size) ? record.size : 0,
        mtimeMs: Number.isFinite(record.mtimeMs) ? record.mtimeMs : 0,
        hash: typeof record.hash === 'string' ? record.hash : null,
      }
    }
    workspaceFiles[id] = {
      root: typeof entry.root === 'string' ? entry.root : null,
      files,
    }
  }

  const imports = asArray(source.imports)
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.importId === 'string')
    .slice(-500)
    .map((entry) => ({
      importId: entry.importId,
      kind: typeof entry.kind === 'string' ? entry.kind : 'unknown',
      id: typeof entry.id === 'string' ? entry.id : null,
      title: typeof entry.title === 'string' ? entry.title : null,
      deviceId: typeof entry.deviceId === 'string' ? entry.deviceId : null,
      version: typeof entry.version === 'string' ? entry.version : null,
      importedAt: typeof entry.importedAt === 'string' ? entry.importedAt : new Date(0).toISOString(),
      dir: typeof entry.dir === 'string' ? entry.dir : null,
      fileCount: Number.isFinite(entry.fileCount) ? entry.fileCount : 0,
      bytes: Number.isFinite(entry.bytes) ? entry.bytes : 0,
    }))

  const errors = asArray(source.errors)
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.message === 'string')
    .slice(-MAX_ERRORS)
    .map((entry) => ({
      at: typeof entry.at === 'string' ? entry.at : new Date(now()).toISOString(),
      code: typeof entry.code === 'string' ? entry.code : 'wps-sync/error',
      message: entry.message,
      key: typeof entry.key === 'string' ? entry.key : null,
    }))

  return {
    version: STATE_VERSION,
    device,
    syncRootDir: typeof source.syncRootDir === 'string' ? source.syncRootDir : '',
    defaults: { auto: asObject(source.defaults).auto !== false },
    items,
    workspaceFiles,
    imports,
    errors,
    counters: {
      uploads: Number.isFinite(asObject(source.counters).uploads) ? asObject(source.counters).uploads : 0,
      pulls: Number.isFinite(asObject(source.counters).pulls) ? asObject(source.counters).pulls : 0,
    },
    stateRecovered: normalizeRecovered(source.stateRecovered),
  }
}

/** The quarantine record (`{from, at, code, message}`) or null. */
function normalizeRecovered(value) {
  const source = asObject(value)
  if (typeof source.from !== 'string' || source.from === '') return null
  return {
    from: source.from,
    at: typeof source.at === 'string' ? source.at : null,
    code: typeof source.code === 'string' ? source.code : CORRUPT_CODE,
    message: typeof source.message === 'string' ? source.message : '',
  }
}

/** Item key used by the state document and by the client. */
function itemKey(kind, id) {
  if (kind === 'tasks') return TASKS_KEY
  if (kind !== 'session' && kind !== 'workspace') {
    throw new Error(`unknown kind: ${kind}`)
  }
  return `${kind}:${id}`
}

/** Parse `session:<id>` / `workspace:<id>` / `tasks:global`. */
function parseItemKey(key) {
  if (key === TASKS_KEY) return { kind: 'tasks', id: 'global' }
  const index = String(key).indexOf(':')
  if (index <= 0) return null
  const kind = key.slice(0, index)
  const id = key.slice(index + 1)
  if (kind !== 'session' && kind !== 'workspace') return null
  if (!id) return null
  return { kind, id }
}

class StateStore {
  /**
   * @param {{dir: string, deviceName?: string, now?: () => number}} options
   */
  constructor(options) {
    this.dir = options.dir
    this.file = path.join(this.dir, 'state.json')
    this.deviceName = options.deviceName ?? ''
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.data = emptyState(createDevice({ name: this.deviceName, now: this.now }))
    this.writeChain = Promise.resolve()
    this.loaded = false
    /** Non-null when the state file could not be read and must not be overwritten. */
    this.loadFailure = null
  }

  /**
   * Load the state document.
   *
   * A corrupt file is never silently replaced: the original bytes are renamed
   * to `state.json.corrupt-<timestamp>` first, and only then is a fresh state
   * written. If even the rename fails (read-only medium, locked file) the load
   * fails and every later `save()` is refused, so the damaged document cannot be
   * destroyed by a background write.
   */
  async load() {
    let raw = null
    try {
      raw = await readJsonStrict(this.file, '同步状态文件')
    } catch (error) {
      this.loadFailure = {
        code: (error && error.code) || 'wps-sync/state-unreadable',
        message: error && error.message ? error.message : String(error),
      }
      if (!isCorruptState(error)) throw error
      const from = await this.quarantineCorruptFile()
      const state = normalizeState(null, { deviceName: this.deviceName, now: this.now })
      state.stateRecovered = {
        from,
        at: new Date(this.now()).toISOString(),
        code: CORRUPT_CODE,
        message: this.loadFailure.message,
      }
      this.data = state
      this.loaded = true
      this.loadFailure = null
      await this.save()
      return this.data
    }
    this.data = normalizeState(raw, { deviceName: this.deviceName, now: this.now })
    this.loaded = true
    if (!raw) await this.save()
    return this.data
  }

  /** Move the unreadable state file aside; throws when that is impossible. */
  async quarantineCorruptFile() {
    await ensureDir(this.dir)
    const from = path.join(this.dir, corruptBackupName(this.now))
    // rename (not copy+delete): the bytes either move intact or nothing changes.
    await fs.rename(this.file, from)
    return from
  }

  get device() {
    return this.data.device
  }

  get items() {
    return this.data.items
  }

  /** Snapshot write: serialized so concurrent updates cannot interleave. */
  save() {
    if (this.loadFailure) {
      const error = new Error(
        `同步状态文件不可读，已停止写入以免覆盖损坏数据：${this.file}（${this.loadFailure.message}）`,
      )
      error.code = 'wps-sync/state-locked'
      return Promise.reject(error)
    }
    const snapshot = JSON.parse(JSON.stringify(this.data))
    const write = this.writeChain.then(async () => {
      await ensureDir(this.dir)
      await writeJsonAtomic(this.file, snapshot)
    })
    // Keep the chain usable after a failed write while still rejecting the
    // caller that observed the failure.
    this.writeChain = write.catch(() => {})
    return write
  }

  async mutate(mutator) {
    const result = mutator(this.data)
    await this.save()
    return result
  }

  /** Existing item record, or a fresh one honouring the default auto flag. */
  ensureItem(kind, id, options = {}) {
    const key = itemKey(kind, id)
    const existing = this.data.items[key]
    if (existing) {
      if (typeof options.title === 'string' && options.title) existing.title = options.title
      if (typeof options.dir === 'string' && options.dir) existing.dir = options.dir
      return existing
    }
    const record = {
      auto: options.auto !== undefined ? Boolean(options.auto) : this.data.defaults.auto !== false,
      lastSyncAt: null,
      lastResult: null,
      lastError: null,
      lastHash: null,
      lastEventSeq: null,
      exportedAt: null,
      dir: typeof options.dir === 'string' ? options.dir : null,
      title: typeof options.title === 'string' ? options.title : null,
    }
    this.data.items[key] = record
    return record
  }

  getItem(key) {
    return this.data.items[key] ?? null
  }

  recordResult(kind, id, result, options = {}) {
    const record = this.ensureItem(kind, id, options)
    const at = new Date(this.now()).toISOString()
    record.lastSyncAt = at
    record.exportedAt = at
    if (result && typeof result === 'object') {
      record.lastResult = typeof result.status === 'string' ? result.status : 'ok'
      record.lastError = typeof result.error === 'string' ? result.error : null
      if (typeof result.hash === 'string') record.lastHash = result.hash
      if (Number.isFinite(result.lastEventSeq)) record.lastEventSeq = result.lastEventSeq
      if (typeof result.dir === 'string') record.dir = result.dir
      if (typeof result.title === 'string' && result.title) record.title = result.title
    } else {
      record.lastResult = 'ok'
      record.lastError = null
    }
    return record
  }

  recordFailure(kind, id, error, options = {}) {
    const record = this.ensureItem(kind, id, options)
    record.lastSyncAt = new Date(this.now()).toISOString()
    record.lastResult = 'error'
    record.lastError = error && error.message ? error.message : String(error)
    return record
  }

  pushError(error, context = {}) {
    const message = error && error.message ? error.message : String(error)
    this.data.errors.push({
      at: new Date(this.now()).toISOString(),
      code: (error && error.code) || 'wps-sync/error',
      message,
      key: typeof context.key === 'string' ? context.key : null,
    })
    while (this.data.errors.length > MAX_ERRORS) this.data.errors.shift()
  }

  addImport(record) {
    const existing = this.data.imports.findIndex((entry) => entry.importId === record.importId)
    const normalized = {
      importId: record.importId,
      kind: record.kind,
      id: record.id ?? null,
      title: record.title ?? null,
      deviceId: record.deviceId ?? null,
      version: record.version ?? null,
      importedAt: record.importedAt ?? new Date(this.now()).toISOString(),
      dir: record.dir ?? null,
      fileCount: Number.isFinite(record.fileCount) ? record.fileCount : 0,
      bytes: Number.isFinite(record.bytes) ? record.bytes : 0,
    }
    if (existing >= 0) this.data.imports[existing] = normalized
    else this.data.imports.push(normalized)
    while (this.data.imports.length > 500) this.data.imports.shift()
    return normalized
  }

  findImport(importId) {
    return this.data.imports.find((entry) => entry.importId === importId) ?? null
  }

  workspaceTable(id) {
    const entry = this.data.workspaceFiles[id]
    if (!entry) return null
    return entry
  }

  setWorkspaceTable(id, root, files) {
    this.data.workspaceFiles[id] = { root, files }
  }
}

module.exports = { StateStore, itemKey, parseItemKey, normalizeState, createDevice, MAX_ERRORS }