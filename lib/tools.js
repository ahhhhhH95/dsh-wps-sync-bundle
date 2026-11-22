'use strict'

/**
 * The seven agent tools.
 *
 * The registry stores a raw `ToolDefinition` as-is and does not validate
 * arguments for it (only `defineTool` instances carry a compiled validator), so
 * every tool below validates its own arguments before touching the engine —
 * strictly, and with an error a model can act on.
 */

const path = require('node:path')
const { KINDS } = require('./constants')
const { isAbsoluteLike } = require('./paths')

const TEXT_OUTPUT = {
  type: 'object',
  additionalProperties: true,
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function fail(message) {
  const error = new Error(message)
  error.code = 'wps-sync/tool-arguments'
  return error
}

function ensureObjectArgs(args, allowed) {
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) throw fail('参数必须是一个对象')
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw fail(`不支持的参数：${key}（可用：${allowed.join(', ') || '无'}）`)
  }
  return args
}

function optionalString(args, key) {
  if (args[key] === undefined || args[key] === null) return undefined
  if (typeof args[key] !== 'string') throw fail(`参数 ${key} 必须是字符串`)
  return args[key]
}

function requiredString(args, key) {
  const value = optionalString(args, key)
  if (value === undefined || value.trim() === '') throw fail(`缺少必填参数 ${key}`)
  return value.trim()
}

function optionalBoolean(args, key) {
  if (args[key] === undefined || args[key] === null) return undefined
  if (typeof args[key] !== 'boolean') throw fail(`参数 ${key} 必须是布尔值`)
  return args[key]
}

function requiredBoolean(args, key) {
  const value = optionalBoolean(args, key)
  if (value === undefined) throw fail(`缺少必填参数 ${key}`)
  return value
}

function optionalInteger(args, key, minimum, maximum) {
  if (args[key] === undefined || args[key] === null) return undefined
  const value = args[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) throw fail(`参数 ${key} 必须是整数`)
  if (value < minimum || value > maximum) throw fail(`参数 ${key} 必须在 ${minimum}..${maximum} 之间`)
  return value
}

function requiredEnum(args, key, choices) {
  const value = requiredString(args, key)
  if (!choices.includes(value)) throw fail(`参数 ${key} 必须是 ${choices.join(' / ')} 之一`)
  return value
}

function optionalEnum(args, key, choices) {
  const value = optionalString(args, key)
  if (value === undefined) return undefined
  if (!choices.includes(value)) throw fail(`参数 ${key} 必须是 ${choices.join(' / ')} 之一`)
  return value
}

function summarizeList(items, limit) {
  const rows = items.slice(0, limit).map((item) => ({
    kind: item.kind,
    id: item.id,
    title: item.title,
    auto: item.auto,
    lastSyncAt: item.lastSyncAt,
    lastResult: item.lastResult,
    lastError: item.lastError,
    hash: item.hash,
    dir: item.dir,
  }))
  return { items: rows, total: items.length, truncated: items.length > rows.length }
}

/**
 * @param {import('./engine').SyncEngine} engine
 */
function createToolDefinitions(engine) {
  return [
    {
      name: 'wps_sync_list',
      description:
        '列出可与 WPS 云同步的本地条目（会话 / 工作区 / 计划任务），包含自动同步开关、最近一次同步时间与结果。只读。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...KINDS, 'all'], description: '只列出某一类条目，默认 all' },
          limit: { type: 'integer', description: '最多返回多少条，1..500，默认 50' },
        },
        additionalProperties: false,
      },
      output: { schema: TEXT_OUTPUT, render: renderJson },
      async execute(rawArgs) {
        const args = ensureObjectArgs(rawArgs, ['kind', 'limit'])
        const kind = optionalEnum(args, 'kind', [...KINDS, 'all']) ?? 'all'
        const limit = optionalInteger(args, 'limit', 1, 500) ?? 50
        const listing = await engine.listItems()
        const filtered = kind === 'all' ? listing.items : listing.items.filter((item) => item.kind === kind)
        return {
          kind,
          ...summarizeList(filtered, limit),
          counts: listing.counts,
          syncRootDir: engine.rootInfo ? engine.rootInfo.root ?? '' : '',
          syncRootValid: Boolean(engine.rootInfo && engine.rootInfo.valid),
        }
      },
    },
    {
      name: 'wps_sync_upload',
      description:
        '把本地会话 / 工作区 / 计划任务导出到 WPS 同步目录（<syncRoot>/DSH-Sync）。单个条目会先经过串行队列，重复调用同一会话只会执行一次。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...KINDS, 'all'], description: 'session / workspace / tasks / all' },
          id: { type: 'string', description: 'kind=session 时的会话 ID；kind=workspace 时的工作区 ID；tasks/all 可省略' },
          force: { type: 'boolean', description: '为 true 时即使内容哈希未变也重写一次' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      output: { schema: TEXT_OUTPUT, render: renderJson },
      async execute(rawArgs) {
        const args = ensureObjectArgs(rawArgs, ['kind', 'id', 'force'])
        const kind = requiredEnum(args, 'kind', [...KINDS, 'all'])
        const id = optionalString(args, 'id')
        const force = optionalBoolean(args, 'force') === true
        const result = await engine.upload(kind, id, { force })
        engine.invalidateStatus()
        return result
      },
    },
    {
      name: 'wps_sync_set_auto',
      description: '打开或关闭某个条目（或全部条目）的自动同步。默认全部为开启。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...KINDS, 'all'], description: 'session / workspace / tasks / all' },
          id: { type: 'string', description: 'kind=session 或 workspace 时的条目 ID；tasks/all 可省略' },
          auto: { type: 'boolean', description: 'true 开启自动同步，false 关闭' },
        },
        required: ['kind', 'auto'],
        additionalProperties: false,
      },
      output: { schema: TEXT_OUTPUT, render: renderJson },
      async execute(rawArgs) {
        const args = ensureObjectArgs(rawArgs, ['kind', 'id', 'auto'])
        const kind = requiredEnum(args, 'kind', [...KINDS, 'all'])
        const auto = requiredBoolean(args, 'auto')
        const id = optionalString(args, 'id')
        const result = await engine.setAuto(kind === 'all' ? 'all' : kind, id, auto)
        engine.invalidateStatus()
        return result
      },
    },
    {
      name: 'wps_sync_status',
      description: '查看同步状态：同步目录、队列、最近错误、导入记录，以及每一项的自动同步与哈希。只读。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: TEXT_OUTPUT, render: renderJson },
      async execute(rawArgs) {
        ensureObjectArgs(rawArgs, [])
        const status = await engine.status({ fresh: true })
        return status
      },
    },
    {
      name: 'wps_sync_remote_list',
      description: '列出同步目录中其他设备发布的条目（会话 / 工作区 / 计划任务），用于跨设备查看与拉取。只读。',
      parameters: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: '只看某一个设备，省略则返回全部设备' },
        },
        additionalProperties: false,
      },
      output: { schema: TEXT_OUTPUT, render: renderJson },
      async execute(rawArgs) {
        const args = ensureObjectArgs(rawArgs, ['deviceId'])
        const deviceId = optionalString(args, 'deviceId')
        const remote = await engine.remoteList()
        const devices = deviceId ? remote.devices.filter((device) => device.id === deviceId) : remote.devices
        return {
          deviceCount: devices.length,
          itemCount: devices.reduce((total, device) => total + device.itemCount, 0),
          devices,
          syncRoot: remote.syncRoot,
        }
      },
    },
    {
      name: 'wps_sync_pull',
      description:
        '把另一个设备发布的某个条目拉取到本地 imports/ 暂存区，并校验清单哈希。会话与任务只作为可读归档（runtimeImportSupported:false），工作区可再用 wps_sync_restore 恢复。',
      parameters: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: '来源设备 ID（见 wps_sync_remote_list）' },
          kind: { type: 'string', enum: [...KINDS], description: 'session / workspace / tasks' },
          id: { type: 'string', description: '条目 ID；tasks 使用 tasks:global' },
          version: { type: 'string', description: '可选：远端条目的 version，用于确认拉取的是刚看到的版本' },
        },
        required: ['deviceId', 'kind', 'id'],
        additionalProperties: false,
      },
      output: { schema: TEXT_OUTPUT, render: renderJson },
      async execute(rawArgs) {
        const args = ensureObjectArgs(rawArgs, ['deviceId', 'kind', 'id', 'version'])
        const deviceId = requiredString(args, 'deviceId')
        const kind = requiredEnum(args, 'kind', KINDS)
        const id = requiredString(args, 'id')
        const version = optionalString(args, 'version')
        const result = await engine.pull({ deviceId, kind, id, version })
        engine.invalidateStatus()
        return result
      },
    },
    {
      name: 'wps_sync_restore',
      description:
        '把已拉取（pull）的工作区归档恢复到一个明确的本地目录。绝不覆盖已有文件：冲突策略默认 skip，可选 rename。targetDir 必须是绝对路径且不在同步目录内。',
      parameters: {
        type: 'object',
        properties: {
          importId: { type: 'string', description: 'wps_sync_pull 返回的 importId' },
          targetDir: { type: 'string', description: '恢复目标目录（绝对路径，必须由用户明确指定）' },
          conflict: { type: 'string', enum: ['skip', 'rename'], description: '冲突策略，默认 skip' },
        },
        required: ['importId', 'targetDir'],
        additionalProperties: false,
      },
      output: { schema: TEXT_OUTPUT, render: renderJson },
      async execute(rawArgs) {
        const args = ensureObjectArgs(rawArgs, ['importId', 'targetDir', 'conflict'])
        const importId = requiredString(args, 'importId')
        const targetDir = requiredString(args, 'targetDir')
        if (!path.isAbsolute(targetDir) && !isAbsoluteLike(targetDir)) {
          throw fail('targetDir 必须是绝对路径')
        }
        const conflict = optionalEnum(args, 'conflict', ['skip', 'rename']) ?? 'skip'
        const result = await engine.restore({ importId, targetDir, conflict })
        return result
      },
    },
  ]
}

module.exports = { createToolDefinitions, ensureObjectArgs, renderJson, TEXT_OUTPUT }