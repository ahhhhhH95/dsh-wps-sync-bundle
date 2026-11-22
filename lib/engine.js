'use strict'

/**
 * The sync engine.
 *
 * It owns the only mutable wiring of the plugin: the sync root, the archive
 * sink, the serial queue, the debouncers and the periodic workspace scan. Tools
 * and the HTTP bridge are thin adapters over this class, so a UI click and an
 * agent tool call run exactly the same code path.
 */

const { SyncQueue } = require('./queue')
const { Debouncer } = require('./timer')
const { StateStore, itemKey } = require('./store')
const { LocalDirSink } = require('./sink')
const { resolveSyncRoot, validateSyncRoot } = require('./sync-root')
const { exportSession } = require('./export-session')
const { exportTasks } = require('./export-tasks')
const { exportWorkspace } = require('./export-workspace')
const { listRemote, pullRemote } = require('./remote')
const { restoreWorkspace } = require('./restore')
const { describeImport, readImportFile } = require('./archive')
const { readAllDevices } = require('./manifest')
const { normalizeConfig } = require('./config')
const { KINDS, PLUGIN_NAME, TASKS_KEY, SYNC_SUBDIR, SCHEMA_VERSION } = require('./constants')
const { badRequest, notReady } = require('./errors')

const STATUS_CACHE_MS = 1500
const MAX_LIST_SESSIONS = 200
const MIN_SCAN_SECONDS = 15

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function shortHash(hash) {
  return typeof hash === 'string' && hash.length >= 12 ? hash.slice(0, 12) : hash ?? null
}

/**
 * Session id of one `readTitleSnapshots` observation. The real Host answers
 * `{sessionId, status:'fulfilled', value:{session, title?:{title}}}`; older or
 * mocked shapes may pass a bare id/string, so stay tolerant.
 */
function observationSessionId(entry, ids) {
  if (typeof entry === 'string') return ids.includes(entry) ? entry : null
  if (!entry || typeof entry !== 'object') return null
  if (typeof entry.sessionId === 'string') return entry.sessionId
  if (typeof entry.id === 'string') return entry.id
  const value = entry.value
  if (value && typeof value === 'object') {
    if (typeof value.sessionId === 'string') return value.sessionId
    if (value.session && typeof value.session.id === 'string') return value.session.id
  }
  return null
}

/** Title out of one observation; `null` when the observation carries none. */
function observationTitle(entry) {
  if (typeof entry === 'string') return entry.trim() || null
  if (!entry || typeof entry !== 'object') return null
  if (entry.status === 'rejected' || entry.status === 'error') return null
  const value = entry.value && typeof entry.value === 'object' ? entry.value : entry
  const candidates = [value.title, value.title && value.title.title, value.session && value.session.title]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

class SyncEngine {
  /**
   * @param {{config: object, stateDir: string, services: object, now?: () => number, onBackgroundError?: (error: Error) => void}} options
   */
  constructor(options) {
    this.config = normalizeConfig(options.config)
    this.stateDir = options.stateDir
    this.services = options.services ?? {}
    this.now = options.now ?? (() => Date.now())
    this.onBackgroundError = options.onBackgroundError ?? (() => {})
    this.store = new StateStore({ dir: this.stateDir, deviceName: this.config.deviceName, now: this.now })
    this.queue = new SyncQueue({ now: this.now })
    this.debouncer = new Debouncer({ delayMs: this.config.debounceMs })
    this.rootInfo = null
    this.sink = null
    this.statusCache = { at: 0, value: null }
    this.started = false
    this.stopping = false
    /** How many queued jobs `stop()` cancelled on the last unload. */
    this.cancelledOnStop = 0
  }

  async init() {
    await this.store.load()
    // `autoSync` is the default for items without an explicit choice; an item
    // the user already switched on or off keeps its own flag, so flipping the
    // config never silently rewrites existing per-item decisions.
    this.store.data.defaults.auto = this.config.autoSync !== false
    await this.store.save().catch(() => {})
    return this
  }

  /* ------------------------------------------------------------------ root */

  /** Resolve (and cache) the effective sync root, creating the sink. */
  async refreshRoot(options = {}) {
    const resolved = await resolveSyncRoot({
      configured: this.config.syncRootDir,
      cached: this.store.data.syncRootDir,
      homeDir: options.homeDir,
    })
    this.rootInfo = resolved
    this.sink = resolved.root ? new LocalDirSink({ rootDir: require('node:path').join(resolved.root, SYNC_SUBDIR) }) : null
    if (resolved.root && this.store.data.syncRootDir !== resolved.root) {
      this.store.data.syncRootDir = resolved.root
      await this.store.save().catch(() => {})
    }
    this.statusCache = { at: 0, value: null }
    return resolved
  }

  async requireSink() {
    if (!this.rootInfo) await this.refreshRoot()
    if (!this.sink) {
      const error = notReady(
        this.rootInfo && this.rootInfo.error ? this.rootInfo.error : '尚未设置同步目录',
        'wps-sync/no-root',
      )
      throw error
    }
    await this.sink.ensure()
    return this.sink
  }

  /** Pick a sync root from the UI or a tool call. */
  async setRoot(dir, options = {}) {
    if (typeof dir !== 'string') throw badRequest('同步目录必须是字符串', 'wps-sync/root-invalid')
    const value = dir.trim()
    if (value === '') throw badRequest('同步目录不能为空', 'wps-sync/root-invalid')
    const checked = await validateSyncRoot(value)
    if (!checked.ok) throw badRequest(checked.error || '同步目录不可用', 'wps-sync/root-invalid')
    this.config.syncRootDir = checked.resolved
    this.store.data.syncRootDir = checked.resolved
    await this.store.save()
    await this.refreshRoot()
    const persisted = await this.persistConfig({ syncRootDir: checked.resolved }, options)
    return { syncRootDir: checked.resolved, configPersisted: persisted }
  }

  /** Write a field into the profile configuration when the editor is available. */
  async persistConfig(patch, options = {}) {
    const editor = options.configEditor ?? this.services.configEditor
    const entry = options.entry ?? this.services.entry
    if (!editor || typeof editor.edit !== 'function' || !entry) return false
    try {
      await editor.edit(entry, (current) => ({ ...current, ...patch }))
      return true
    } catch (error) {
      this.onBackgroundError(error)
      return false
    }
  }

  /* --------------------------------------------------------------- uploads */

  /** Enqueue one session export. */
  uploadSession(sessionId, options = {}) {
    const id = typeof sessionId === 'string' ? sessionId : ''
    if (!id) throw badRequest('缺少会话 ID', 'wps-sync/no-session-id')
    return this.queue.push(
      { kind: 'session', key: itemKey('session', id), label: `会话 ${id.slice(0, 8)}` },
      async () => {
        const sink = await this.requireSink()
        try {
          const result = await exportSession({
            sink,
            store: this.store,
            device: this.store.device,
            sessionQuery: this.services.sessionQuery,
            sessionId: id,
            force: options.force === true,
            now: this.now,
          })
          return result
        } catch (error) {
          this.store.recordFailure('session', id, error)
          this.store.pushError(error, { key: itemKey('session', id) })
          await this.store.save().catch(() => {})
          throw error
        }
      },
    )
  }

  uploadTasks(options = {}) {
    return this.queue.push(
      { kind: 'tasks', key: TASKS_KEY, label: '计划任务' },
      async () => {
        const sink = await this.requireSink()
        try {
          return await exportTasks({
            sink,
            store: this.store,
            device: this.store.device,
            schedule: this.services.schedule,
            config: this.config,
            force: options.force === true,
            now: this.now,
          })
        } catch (error) {
          this.store.recordFailure('tasks', TASKS_KEY, error)
          this.store.pushError(error, { key: TASKS_KEY })
          await this.store.save().catch(() => {})
          throw error
        }
      },
    )
  }

  uploadWorkspace(workspace, options = {}) {
    const target = workspace && typeof workspace === 'object' ? workspace : null
    if (!target || !target.id) throw badRequest('缺少工作区', 'wps-sync/no-workspace-id')
    return this.queue.push(
      { kind: 'workspace', key: itemKey('workspace', target.id), label: `工作区 ${target.title ?? target.id}` },
      async () => {
        const sink = await this.requireSink()
        try {
          return await exportWorkspace({
            sink,
            store: this.store,
            device: this.store.device,
            workspace: target,
            config: this.config,
            syncRoot: this.rootInfo ? this.rootInfo.root : null,
            force: options.force === true,
            now: this.now,
          })
        } catch (error) {
          this.store.recordFailure('workspace', target.id, error)
          this.store.pushError(error, { key: itemKey('workspace', target.id) })
          await this.store.save().catch(() => {})
          throw error
        }
      },
    )
  }

  /** Local workspaces, from the registry. */
  localWorkspaces() {
    const registry = this.services.workspaceRegistry
    if (!registry || typeof registry.list !== 'function') return []
    try {
      return safeArray(registry.list()).map((workspace) => ({
        id: workspace.id,
        title: workspace.title ?? workspace.id,
        path: workspace.path ?? null,
        updatedAt: workspace.updatedAt ?? null,
      }))
    } catch (error) {
      this.onBackgroundError(error)
      return []
    }
  }

  findWorkspace(id) {
    return this.localWorkspaces().find((workspace) => workspace.id === id) ?? null
  }

  /**
   * Manual upload entry point: `kind` is session | workspace | tasks | all.
   */
  async upload(kind, id, options = {}) {
    if (kind === 'all') {
      const results = []
      for (const session of await this.localSessions()) {
        results.push(await this.uploadSession(session.id, options).catch((error) => ({ status: 'error', id: session.id, error: error.message })))
      }
      for (const workspace of this.localWorkspaces()) {
        results.push(await this.uploadWorkspace(workspace, options).catch((error) => ({ status: 'error', id: workspace.id, error: error.message })))
      }
      results.push(await this.uploadTasks(options).catch((error) => ({ status: 'error', id: TASKS_KEY, error: error.message })))
      return { kind: 'all', results }
    }
    if (!KINDS.includes(kind)) throw badRequest(`未知的条目类型：${kind}`, 'wps-sync/unknown-kind')
    if (kind === 'tasks') return this.uploadTasks(options)
    if (kind === 'session') {
      if (!id) throw badRequest('缺少会话 ID', 'wps-sync/no-session-id')
      return this.uploadSession(id, options)
    }
    const workspace = id ? this.findWorkspace(id) : null
    if (!workspace) throw badRequest(`未找到工作区：${id ?? ''}`, 'wps-sync/workspace-not-found')
    return this.uploadWorkspace(workspace, options)
  }

  /* --------------------------------------------------------------- auto bits */

  isAuto(kind, id) {
    const key = kind === 'tasks' ? TASKS_KEY : itemKey(kind, id)
    const record = this.store.getItem(key)
    if (record) return record.auto !== false
    // No per-item record yet: the owner-wide default decides.
    return this.store.data.defaults.auto !== false
  }

  async setAuto(kind, id, auto, options = {}) {
    const value = auto !== false
    if (kind === 'all' || options.all === true) {
      for (const session of await this.localSessions()) this.store.ensureItem('session', session.id, { title: session.title }).auto = value
      for (const workspace of this.localWorkspaces()) this.store.ensureItem('workspace', workspace.id, { title: workspace.title, dir: workspace.path }).auto = value
      this.store.ensureItem('tasks', TASKS_KEY).auto = value
      await this.store.save()
      return { kind: 'all', auto: value }
    }
    if (!KINDS.includes(kind)) throw badRequest(`未知的条目类型：${kind}`, 'wps-sync/unknown-kind')
    if (kind === 'tasks') {
      this.store.ensureItem('tasks', TASKS_KEY).auto = value
      await this.store.save()
      return { kind, id: TASKS_KEY, auto: value }
    }
    if (!id) throw badRequest('缺少条目 ID', 'wps-sync/no-item-id')
    const record = this.store.ensureItem(kind, id, options)
    record.auto = value
    await this.store.save()
    return { kind, id, auto: value }
  }

  /* -------------------------------------------------------------- listings */

  async localSessions() {
    const sessionQuery = this.services.sessionQuery
    if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return []
    let records = []
    try {
      records = safeArray(await sessionQuery.listSessions())
    } catch (error) {
      this.onBackgroundError(error)
      return []
    }
    const rows = []
    for (const record of records.slice(0, MAX_LIST_SESSIONS)) {
      const header = (record && record.header) || record || {}
      if (!header || typeof header.id !== 'string') continue
      rows.push({
        id: header.id,
        title: this.titleFor(header.id),
        createdAt: header.createdAt ?? null,
        updatedAt: header.updatedAt ?? null,
        cwd: header.cwd ?? null,
        parentSession: header.parentSession ?? null,
        live: record && record.live === true,
      })
    }
    if (typeof sessionQuery.readTitleSnapshots === 'function' && rows.length > 0) {
      const ids = rows.map((row) => row.id)
      try {
        const titles = await sessionQuery.readTitleSnapshots(ids)
        if (Array.isArray(titles)) {
          for (const entry of titles) {
            const id = observationSessionId(entry, ids)
            const title = observationTitle(entry)
            if (!id || !title) continue
            const row = rows.find((candidate) => candidate.id === id)
            if (row) row.title = title
          }
        } else if (titles && typeof titles === 'object') {
          for (const row of rows) {
            const title = observationTitle(titles[row.id])
            if (title) row.title = title
          }
        }
      } catch (error) {
        this.onBackgroundError(error)
      }
    }
    return rows
  }

  titleFor(sessionId) {
    const record = this.store.getItem(itemKey('session', sessionId))
    return record && record.title ? record.title : `会话 ${String(sessionId).slice(0, 8)}`
  }

  async localTasks() {
    const schedule = this.services.schedule
    if (!schedule || typeof schedule.catalog !== 'function') return []
    try {
      const catalog = await schedule.catalog()
      const list = Array.isArray(catalog) ? catalog : Array.isArray(catalog && catalog.entries) ? catalog.entries : []
      return list.map((entry) => ({
        id: entry.id,
        title: entry.title ?? entry.id,
        kind: entry.kind ?? null,
        scheduledAt: entry.scheduledAt ?? null,
        status: entry.status ?? null,
        target: entry.target ?? null,
      }))
    } catch (error) {
      this.onBackgroundError(error)
      return []
    }
  }

  /** Unified item table for the panel and the tools. */
  async listItems(options = {}) {
    const sessions = await this.localSessions()
    const workspaces = this.localWorkspaces()
    const tasks = await this.localTasks()
    const items = []

    for (const session of sessions) {
      const key = itemKey('session', session.id)
      const record = this.store.getItem(key)
      items.push({
        key,
        kind: 'session',
        id: session.id,
        title: record && record.title ? record.title : session.title,
        subtitle: session.cwd ?? '',
        cwd: session.cwd ?? null,
        live: session.live,
        auto: record ? record.auto !== false : this.store.data.defaults.auto !== false,
        lastSyncAt: record ? record.lastSyncAt : null,
        updatedAt: record && record.lastSyncAt ? record.lastSyncAt : (session.updatedAt ?? null),
        lastResult: record ? record.lastResult : null,
        lastError: record ? record.lastError : null,
        hash: shortHash(record ? record.lastHash : null),
        dir: record ? record.dir : null,
        eventCount: record ? record.lastEventSeq : null,
        messageCount: record && Number.isFinite(record.lastEventSeq) ? record.lastEventSeq : null,
      })
    }
    for (const workspace of workspaces) {
      const key = itemKey('workspace', workspace.id)
      const record = this.store.getItem(key)
      items.push({
        key,
        kind: 'workspace',
        id: workspace.id,
        title: record && record.title ? record.title : workspace.title,
        subtitle: workspace.path ?? '',
        path: workspace.path ?? null,
        auto: record ? record.auto !== false : this.store.data.defaults.auto !== false,
        lastSyncAt: record ? record.lastSyncAt : null,
        updatedAt: record && record.lastSyncAt ? record.lastSyncAt : (workspace.updatedAt ?? null),
        lastResult: record ? record.lastResult : null,
        lastError: record ? record.lastError : null,
        hash: shortHash(record ? record.lastHash : null),
        dir: record ? record.dir : null,
        fileCount: record && this.store.workspaceTable(workspace.id) ? Object.keys(this.store.workspaceTable(workspace.id).files).length : null,
      })
    }
    const tasksRecord = this.store.getItem(TASKS_KEY)
    items.push({
      key: TASKS_KEY,
      kind: 'tasks',
      id: TASKS_KEY,
      title: '计划任务',
      subtitle: `${tasks.length} 个任务`,
      auto: tasksRecord ? tasksRecord.auto !== false : this.store.data.defaults.auto !== false,
      lastSyncAt: tasksRecord ? tasksRecord.lastSyncAt : null,
      lastResult: tasksRecord ? tasksRecord.lastResult : null,
      lastError: tasksRecord ? tasksRecord.lastError : null,
      hash: shortHash(tasksRecord ? tasksRecord.lastHash : null),
      dir: tasksRecord ? tasksRecord.dir : null,
      taskCount: tasks.length,
    })

    if (options.refreshedAt) items.sort((left, right) => String(right.lastSyncAt ?? '').localeCompare(String(left.lastSyncAt ?? '')))
    return {
      items,
      sessions: items.filter((item) => item.kind === 'session'),
      workspaces: items.filter((item) => item.kind === 'workspace'),
      tasks: items.find((item) => item.kind === 'tasks'),
      counts: {
        sessions: sessions.length,
        workspaces: workspaces.length,
        tasks: tasks.length,
        uploaded: items.filter((item) => item.lastSyncAt).length,
        auto: items.filter((item) => item.auto).length,
      },
    }
  }

  /**
   * Warnings derived from disk state on every read and merged into
   * `status.errors`. They are never appended to the durable error ring, so
   * polling the status cannot grow the state document.
   */
  statusWarnings(remote) {
    const at = new Date(this.now()).toISOString()
    const warnings = []
    const recovered = this.store.data.stateRecovered
    if (recovered) {
      warnings.push({
        at: recovered.at ?? at,
        code: 'wps-sync/state-recovered',
        message:
          `同步状态文件损坏，已隔离为 ${recovered.from} 并重建本地状态` +
          `（${recovered.message || recovered.code}）；逐项开关与同步记录需要重新设置。`,
      })
    }
    if (remote && remote.rootCorrupt === true) {
      warnings.push({
        at,
        code: 'wps-sync/root-manifest-corrupt',
        message: `根 manifest 无法解析，已按各设备副本重建列表：${remote.rootError ?? 'unknown'}`,
      })
    }
    for (const deviceId of (remote && remote.corruptDevices) || []) {
      warnings.push({
        at,
        code: 'wps-sync/device-manifest-corrupt',
        message: `设备 ${deviceId} 的 manifest 无法解析，该设备的条目暂时不可见`,
      })
    }
    return warnings
  }

  /** Full status document; the client renders this directly. */
  async status(options = {}) {
    if (!options.fresh && this.statusCache.value && this.now() - this.statusCache.at < STATUS_CACHE_MS) {
      return this.statusCache.value
    }
    if (!this.rootInfo) await this.refreshRoot()
    const listing = await this.listItems()
    const root = this.rootInfo ?? { root: null, requested: '', detectedRoot: null, source: 'none', valid: false, error: null }

    let remote = { devices: [], deviceCount: 0, itemCount: 0, corruptDevices: [], rootCorrupt: false, rootError: null }
    if (this.sink) {
      try {
        remote = await listRemote({ sink: this.sink, selfDeviceId: this.store.device.id })
      } catch (error) {
        this.onBackgroundError(error)
      }
    }

    const warnings = this.statusWarnings(remote)

    const value = {
      ok: true,
      plugin: PLUGIN_NAME,
      schemaVersion: SCHEMA_VERSION,
      device: { ...this.store.device },
      syncRootDir: root.root ?? '',
      configuredRoot: this.config.syncRootDir ?? '',
      detectedRoot: root.detectedRoot ?? '',
      syncRootValid: root.valid === true,
      syncRootSource: root.source,
      syncRootError: root.error ?? null,
      archiveDir: this.sink ? this.sink.rootDir : '',
      autoDefault: this.store.data.defaults.auto !== false,
      runtimeImportSupported: false,
      queue: {
        pending: this.queue.pending,
        // Live work is never truncated: a wedged job is exactly what the user
        // needs to see. Only the finished tail is capped at 20 entries.
        jobs: this.queueSnapshot(),
        stopped: this.stopping === true,
      },
      errors: [...this.store.data.errors.slice(-10), ...warnings],
      imports: this.store.data.imports.slice(-20),
      counters: { ...this.store.data.counters },
      ...listing,
      stateRecovered: this.store.data.stateRecovered ?? null,
      remote: {
        deviceCount: remote.deviceCount,
        itemCount: remote.itemCount,
        devices: remote.devices,
        // Surfaced so a damaged shared index or device manifest is visible
        // instead of looking like an empty cloud folder.
        rootCorrupt: remote.rootCorrupt === true,
        rootError: remote.rootError ?? null,
        corruptDevices: remote.corruptDevices ?? [],
      },
      updatedAt: new Date(this.now()).toISOString(),
    }
    this.statusCache = { at: this.now(), value }
    return value
  }

  /* ---------------------------------------------------------------- remote */

  async remoteList() {
    const sink = await this.requireSink()
    return listRemote({ sink, selfDeviceId: this.store.device.id })
  }

  async pull(options = {}) {
    const sink = await this.requireSink()
    return pullRemote({
      sink,
      store: this.store,
      deviceId: options.deviceId,
      kind: options.kind,
      id: options.id,
      version: options.version,
      now: this.now,
    })
  }

  async restore(options = {}) {
    const sink = await this.requireSink()
    const result = await restoreWorkspace({
      sink,
      store: this.store,
      importId: options.importId,
      targetDir: options.targetDir,
      conflict: options.conflict,
      syncRoot: this.rootInfo ? this.rootInfo.root : null,
    })
    this.statusCache = { at: 0, value: null }
    return result
  }

  async archive(options = {}) {
    const sink = await this.requireSink()
    if (options.path) {
      return readImportFile({ sink, store: this.store, importId: options.importId, path: options.path })
    }
    return describeImport({ sink, store: this.store, importId: options.importId })
  }

  /* ----------------------------------------------------------------- events */

  /** A turn ended: debounce an export when the session is on auto. */
  handleTurnEnd(sessionId) {
    if (this.stopping) return
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (!this.isAuto('session', sessionId)) return
    this.debouncer.push(itemKey('session', sessionId), () => {
      this.uploadSession(sessionId).catch((error) => this.onBackgroundError(error))
    })
  }

  handleScheduleChanged() {
    if (this.stopping) return
    if (!this.isAuto('tasks', TASKS_KEY)) return
    this.debouncer.push(TASKS_KEY, () => {
      this.uploadTasks().catch((error) => this.onBackgroundError(error))
    })
  }

  /** Periodically mirror every auto workspace. Returns how many were queued. */
  scanWorkspaces() {
    // Without a resolved sync root there is nothing to mirror; staying quiet
    // keeps `status().errors` free of one failure row per workspace per tick on
    // a fresh profile that has no WPS directory yet.
    if (this.stopping || !this.sink) return 0
    let queued = 0
    for (const workspace of this.localWorkspaces()) {
      if (!this.isAuto('workspace', workspace.id)) continue
      queued += 1
      this.uploadWorkspace(workspace).catch((error) => this.onBackgroundError(error))
    }
    return queued
  }

  /** Session created/disposed changes the cached status. */
  invalidateStatus() {
    this.statusCache = { at: 0, value: null }
  }

  async start() {
    // `stopping` guards the async init→start hand-off: if the fiber was disposed
    // while `init()` was still running, starting here would resurrect a timer that
    // nothing owns any more.
    if (this.started || this.stopping) return
    this.started = true
    await this.refreshRoot().catch((error) => this.onBackgroundError(error))
    // Disposed while the root probe was running: leave no timer behind.
    if (this.stopping) return
    // `workspaceScanIntervalSec: 0` means "never scan on a timer": do not even
    // create one. Positive values keep a sane floor to avoid hot loops.
    const seconds = Number(this.config.workspaceScanIntervalSec)
    if (!(seconds > 0) || !this.services.setInterval) {
      this.scanTimer = null
    } else {
      const delay = Math.max(MIN_SCAN_SECONDS, seconds) * 1000
      try {
        this.scanTimer = this.services.setInterval(() => {
          if (this.stopping) return
          try {
            this.scanWorkspaces()
          } catch (error) {
            this.onBackgroundError(error)
          }
        }, delay)
      } catch (error) {
        // Never swallow this: a timer that silently fails to register is
        // indistinguishable from a mirror that is simply idle (`pending: 0`,
        // `errors: []`) — exactly the shape of a hard-to-see bug.
        this.scanTimer = null
        this.store.pushError(error, { key: 'workspace-scan' })
        await this.store.save().catch(() => {})
        this.onBackgroundError(error)
      }
    }
    // Mirror once during startup instead of waiting a whole interval, so a
    // reloaded profile syncs immediately. Failures stay inside the queue.
    this.scanWorkspaces()
  }

  async stop() {
    this.stopping = true
    this.debouncer.cancelAll()
    if (this.scanTimer && typeof this.scanTimer === 'function') this.scanTimer()
    else if (this.scanTimer && typeof this.scanTimer.dispose === 'function') this.scanTimer.dispose()
    this.scanTimer = null
    // Queued work is refused from here on; a job that already started cannot be
    // aborted (its file-system promise belongs to Node), so it settles on its own.
    this.cancelledOnStop = this.queue.stop()
    await this.store.save().catch(() => {})
    this.started = false
  }

  /**
   * Live jobs first (never truncated), then the newest finished jobs up to 20.
   */
  queueSnapshot(limit = 20) {
    const live = this.queue.liveJobs()
    const room = Math.max(0, limit - live.length)
    return [...live, ...(room > 0 ? this.queue.recentJobs(room) : [])]
  }
}

module.exports = { SyncEngine, shortHash, MAX_LIST_SESSIONS, STATUS_CACHE_MS }