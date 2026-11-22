'use strict'

/**
 * Scheduled-task export.
 *
 * The scheduler keeps its own durable store, so this export is a *copy* for
 * cross-device visibility: tasks are read through `ctx.schedule.catalog()` and
 * optional per-task delivery history through `ctx.schedule.history()`. Nothing
 * is written back into the scheduler from this plugin.
 */

const { hashFiles, hashBuffer } = require('./hash')
const { publishItem } = require('./manifest')
const { itemKey } = require('./store')
const { SCHEMA_VERSION, PLUGIN_NAME, TASKS_KEY } = require('./constants')
const { notReady } = require('./errors')

function asArray(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  for (const key of ['entries', 'tasks', 'items', 'messages', 'history', 'records']) {
    if (Array.isArray(value[key])) return value[key]
  }
  return []
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

function normalizeTask(raw) {
  const task = cloneJson(raw) ?? {}
  if (typeof task.id !== 'string') return null
  return {
    id: task.id,
    title: typeof task.title === 'string' ? task.title : task.id,
    prompt: typeof task.prompt === 'string' ? task.prompt : '',
    kind: typeof task.kind === 'string' ? task.kind : null,
    scheduledAt: task.scheduledAt ?? null,
    everySeconds: Number.isFinite(task.everySeconds) ? task.everySeconds : null,
    target: task.target ?? null,
    status: typeof task.status === 'string' ? task.status : null,
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
    executionActive: task.executionActive === true,
    deliveryFloorEndsAt: task.deliveryFloorEndsAt ?? null,
    lastDelivery: task.lastDelivery ?? null,
    involvedSessionIds: Array.isArray(task.involvedSessionIds) ? task.involvedSessionIds : [],
    rrule: task.rrule ?? null,
    details: task,
  }
}

async function readTasks(schedule) {
  if (!schedule || typeof schedule.catalog !== 'function') {
    throw notReady('计划任务服务不可用', 'wps-sync/no-schedule')
  }
  const catalog = await schedule.catalog()
  return asArray(catalog).map(normalizeTask).filter(Boolean)
}

async function readHistory(schedule, id, limit) {
  if (!schedule || typeof schedule.history !== 'function' || !(limit > 0)) return []
  // The Host service caps history at 100 entries per call.
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)))
  try {
    const result = await schedule.history({ id, limit: safeLimit })
    return asArray(result).map((entry) => cloneJson(entry)).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * @param {{sink: object, store: object, device: object, schedule: object, config: object, force?: boolean, now?: () => number}} options
 */
async function exportTasks(options) {
  const { sink, store, device, schedule, force = false } = options
  const now = options.now ?? (() => Date.now())
  const config = options.config ?? {}
  const historyLimit = Number.isFinite(config.taskHistoryLimit) ? config.taskHistoryLimit : 0

  const tasks = await readTasks(schedule)
  const withHistory = []
  for (const task of tasks) {
    const history = await readHistory(schedule, task.id, historyLimit)
    withHistory.push({ ...task, history })
  }

  const exportedAt = new Date(now()).toISOString()
  const dir = `tasks/${device.id}`
  // No `exportedAt` here: the document is content, the timestamp belongs in
  // meta.json only, otherwise every export would hash differently.
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'tasks',
    device: { id: device.id, name: device.name, platform: device.platform },
    taskCount: withHistory.length,
    historyLimit,
    tasks: withHistory,
    source: { plugin: PLUGIN_NAME, schema: 'tasks/v1' },
  }
  const taskBuffer = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8')

  const files = [{ path: 'scheduled-tasks.json', bytes: taskBuffer.length, hash: hashBuffer(taskBuffer) }]
  const hash = hashFiles(files)

  const existing = store.getItem(TASKS_KEY)
  if (!force && existing && existing.lastHash === hash && existing.dir === dir) {
    const present = await sink.stat(`${dir}/scheduled-tasks.json`)
    if (present && present.isFile) {
      store.recordResult('tasks', TASKS_KEY, { status: 'unchanged', hash, dir, title: '计划任务' })
      await store.save()
      return { status: 'unchanged', kind: 'tasks', id: TASKS_KEY, dir, hash, taskCount: withHistory.length }
    }
  }

  await sink.ensure()
  await sink.write(`${dir}/scheduled-tasks.json`, taskBuffer)

  const meta = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'tasks',
    id: TASKS_KEY,
    dir,
    device: { id: device.id, name: device.name, platform: device.platform },
    exportedAt,
    hash,
    taskCount: withHistory.length,
    historyLimit,
    files,
    source: { plugin: PLUGIN_NAME, schema: 'tasks/v1' },
  }
  await sink.writeJson(`${dir}/meta.json`, meta)

  const item = {
    deviceId: device.id,
    kind: 'tasks',
    id: TASKS_KEY,
    title: '计划任务',
    dir,
    version: hash,
    hash,
    eventCount: withHistory.length,
    fileCount: files.length,
    sizeBytes: taskBuffer.length,
    platform: device.platform,
    exportedAt,
  }
  await publishItem(sink, device, 'tasks/global', item, now)

  store.recordResult('tasks', TASKS_KEY, { status: 'uploaded', hash, dir, title: '计划任务' })
  store.data.counters.uploads += 1
  await store.save()

  return { status: 'uploaded', kind: 'tasks', id: TASKS_KEY, dir, hash, taskCount: withHistory.length }
}

module.exports = { exportTasks, normalizeTask, readTasks, readHistory, asArray }