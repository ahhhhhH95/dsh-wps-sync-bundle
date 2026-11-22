'use strict'

/**
 * Reading other devices' archives and staging an import.
 *
 * A pull never mutates another device's data and never writes into the live
 * session store or scheduler: it validates the remote manifest, copies the files
 * into `imports/<importId>/`, and re-checks the advertised hash before the
 * import is recorded. Recovery from there is explicit (`wps_sync_restore`).
 */

const { assertSafeRelative, sanitizeId } = require('./paths')
const { hashFiles, hashBuffer } = require('./hash')
const { readAllDevices, readDeviceManifest } = require('./manifest')
const { SCHEMA_VERSION, KINDS, PLUGIN_NAME } = require('./constants')
const { badRequest, corrupt } = require('./errors')

/** Files every archive kind must contain inside its item directory. */
const REQUIRED_FILES = {
  session: ['session.jsonl', 'transcript.md'],
  tasks: ['scheduled-tasks.json'],
  workspace: [],
}

function expectedPrefix(deviceId, kind) {
  if (kind === 'session') return `conversations/${deviceId}/`
  if (kind === 'workspace') return `workspaces/${deviceId}/`
  return `tasks/${deviceId}`
}

/**
 * The remote catalogue: every device, every item it published.
 *
 * @param {{sink: object, selfDeviceId?: string}} options
 */
async function listRemote(options) {
  const { sink } = options
  const selfDeviceId = options.selfDeviceId ?? null
  const { root, devices, rootCorrupt, rootError } = await readAllDevices(sink)

  const rows = []
  for (const [deviceId, manifest] of devices) {
    const items = Object.entries(manifest.items).map(([key, item]) => ({
      key,
      kind: item.kind,
      id: item.id,
      title: item.title,
      version: item.version,
      hash: item.hash,
      dir: item.dir,
      fileCount: item.fileCount,
      eventCount: item.eventCount,
      sizeBytes: item.sizeBytes,
      exportedAt: item.exportedAt,
    }))
    const info = manifest.device ?? {}
    rows.push({
      id: deviceId,
      name: info.name ?? deviceId,
      platform: info.platform ?? '',
      updatedAt: manifest.updatedAt ?? null,
      self: selfDeviceId !== null && deviceId === selfDeviceId,
      itemCount: items.length,
      items,
      // A device whose manifest cannot be parsed is reported instead of
      // silently looking empty.
      corrupt: manifest.corrupt === true,
      error: manifest.corrupt === true ? (manifest.error ?? '设备清单无法解析') : null,
      errorCode: manifest.corrupt === true ? (manifest.errorCode ?? null) : null,
    })
  }
  rows.sort((left, right) => {
    if (left.self !== right.self) return left.self ? 1 : -1
    return String(left.name).localeCompare(String(right.name))
  })

  return {
    schemaVersion: SCHEMA_VERSION,
    syncRoot: sink.rootDir,
    devices: rows,
    deviceCount: rows.length,
    itemCount: rows.reduce((total, row) => total + row.itemCount, 0),
    corruptDevices: rows.filter((row) => row.corrupt).map((row) => row.id),
    rootUpdatedAt: root.updatedAt ?? null,
    // The shared index was unreadable and was rebuilt from the device copies.
    rootCorrupt: rootCorrupt === true,
    rootError: rootCorrupt === true ? rootError : null,
  }
}

function buildImportId(deviceId, kind, id, version) {
  // Content-addressed: the same advertised version always maps to the same
  // import id, so pulling an unchanged item is idempotent instead of piling up
  // a new staging directory every time. The version is normally a full sha256,
  // so keep all 64 chars — a 12-char prefix could collide across contents.
  const stamp = sanitizeId(String(version ?? ''), 'v0').slice(0, 64)
  return `${sanitizeId(deviceId, 'device').slice(0, 12)}.${kind}.${sanitizeId(id, 'item').slice(0, 40)}.${stamp}`
}

const HASH_RE = /^[a-f0-9]{64}$/

/**
 * Whether a recorded import is still staged in full (staging dir, its `files`
 * subdirectory, and the same number of content files that were copied the first
 * time). A pruned staging directory — or one whose files were partly deleted —
 * must be re-copied, not reported as already imported.
 */
async function stagedImportExists(sink, previous, fallbackDir) {
  const dir = typeof previous.dir === 'string' && previous.dir !== '' ? previous.dir : fallbackDir
  let relative
  try {
    relative = assertSafeRelative(dir, '暂存目录')
  } catch {
    return false
  }
  const stats = await sink.stat(relative)
  if (!stats || !stats.isDirectory) return false
  const base = `${relative}/files`
  const files = await sink.stat(base)
  if (!files || !files.isDirectory) return false
  const expected = previous.fileCount
  if (!Number.isSafeInteger(expected) || expected < 0) return true
  let walked
  try {
    walked = await sink.walk(base)
  } catch {
    // An unreadable staging tree is not a complete one.
    return false
  }
  // `fileCount` records the content files only: `meta.json` describes the archive
  // itself and is never part of the content hash (`pullRemote` below).
  const staged = walked.filter((entry) => entry.path.slice(base.length + 1) !== 'meta.json').length
  return staged === expected
}

/** Collect the files of one remote item, validated and size-capped. */
async function collectRemoteFiles(sink, itemDir, kind, maxBytes) {
  const files = []
  const required = REQUIRED_FILES[kind] ?? []
  for (const name of required) {
    const relative = `${itemDir}/${name}`
    const stats = await sink.stat(relative)
    if (!stats || !stats.isFile) {
      throw corrupt(`归档缺少必需文件：${name}`, 'wps-sync/archive-incomplete')
    }
    files.push({ relative, inner: name, size: stats.size })
  }
  if (kind === 'workspace') {
    const base = `${itemDir}/files`
    const walked = await sink.walk(base)
    for (const entry of walked) {
      const inner = entry.path.slice(base.length + 1)
      assertSafeRelative(inner, '归档文件路径')
      files.push({ relative: entry.path, inner, size: entry.size })
    }
  }
  let total = 0
  for (const file of files) {
    total += file.size
    if (total > maxBytes) throw badRequest('归档超过允许的大小上限', 'wps-sync/archive-too-large')
  }
  return files
}

/**
 * Pull one remote item into the staging area.
 *
 * @param {{sink: object, store: object, deviceId: string, kind: string, id: string, version?: string, now?: () => number, maxBytes?: number}} options
 */
async function pullRemote(options) {
  const { sink, store, deviceId, kind, id } = options
  const now = options.now ?? (() => Date.now())
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024

  if (!KINDS.includes(kind)) throw badRequest(`未知的条目类型：${kind}`, 'wps-sync/unknown-kind')
  if (typeof deviceId !== 'string' || deviceId === '') throw badRequest('缺少 deviceId', 'wps-sync/no-device-id')
  if (deviceId === store.device.id) throw badRequest('不能从本机设备拉取，请直接上传', 'wps-sync/self-pull')
  if (typeof id !== 'string' || id === '') throw badRequest('缺少条目 ID', 'wps-sync/no-item-id')

  const manifest = await readDeviceManifest(sink, { id: deviceId, name: deviceId, platform: '' })
  if (Number(manifest.schemaVersion) !== SCHEMA_VERSION) {
    throw corrupt(
      `设备清单版本不受支持：${manifest.schemaVersion}（本插件为 ${SCHEMA_VERSION}）`,
      'wps-sync/schema-mismatch',
    )
  }
  const key = kind === 'tasks' ? 'tasks/global' : `${kind}/${id}`
  const record = manifest.items[key]
  if (!record) throw badRequest('目标设备上没有该条目，请刷新列表', 'wps-sync/item-not-found')
  if (options.version && record.version !== options.version) {
    throw badRequest('远端条目版本已变化，请刷新列表后重试', 'wps-sync/version-mismatch')
  }
  if (record.kind !== kind) {
    throw corrupt('清单条目的类型与请求不一致', 'wps-sync/manifest-mismatch')
  }
  const expectedId = kind === 'tasks' ? 'tasks:global' : id
  if (record.id !== expectedId && record.id !== id) {
    throw corrupt('清单条目的 ID 与请求不一致', 'wps-sync/manifest-mismatch')
  }
  // A missing/empty hash must never degrade into "skip verification".
  if (typeof record.hash !== 'string' || !HASH_RE.test(record.hash)) {
    throw corrupt('清单条目缺少有效的内容哈希，请让来源设备重新上传', 'wps-sync/manifest-invalid')
  }

  const itemDir = assertSafeRelative(record.dir, '归档目录')
  if (!itemDir.startsWith(expectedPrefix(deviceId, kind))) {
    throw corrupt('归档目录与该设备/条目类型不符', 'wps-sync/manifest-mismatch')
  }

  const importId = buildImportId(deviceId, kind, id, record.version ?? record.hash)
  const stagingDir = `imports/${importId}`
  // Idempotent pull: the same content is already staged *and still on disk*.
  // `imports/` is a normal directory the user (or the cloud client) may prune,
  // so a stale state entry must not short-circuit into a phantom import.
  const previous = typeof store.findImport === 'function' ? store.findImport(importId) : null
  if (previous && (await stagedImportExists(sink, previous, stagingDir))) {
    return {
      importId,
      kind,
      id,
      title: previous.title ?? record.title ?? '',
      deviceId,
      version: previous.version ?? record.version ?? '',
      importedAt: previous.importedAt ?? null,
      fileCount: previous.fileCount ?? 0,
      bytes: previous.bytes ?? 0,
      hash: record.hash,
      stagedDir: previous.dir ?? stagingDir,
      runtimeImportSupported: false,
      alreadyImported: true,
      message: '该内容此前已拉取过，直接复用暂存结果（未重复写入）',
    }
  }
  await sink.ensure()

  try {
    const collected = await collectRemoteFiles(sink, itemDir, kind, maxBytes)
    const hashed = []
    let bytes = 0
    for (const file of collected) {
      const buffer = await sink.read(file.relative)
      if (!buffer) throw corrupt(`归档文件不可读：${file.inner}`, 'wps-sync/archive-unreadable')
      const targetRel = `${stagingDir}/files/${file.inner}`
      await sink.write(targetRel, buffer)
      bytes += buffer.length
      // meta.json describes the archive itself; it is not part of the content hash.
      if (file.inner !== 'meta.json') hashed.push({ path: file.inner, hash: hashBuffer(buffer) })
    }

    const contentHash = hashFiles(hashed)
    if (contentHash !== record.hash) {
      throw corrupt('归档内容与清单哈希不一致（可能仍在同步中）', 'wps-sync/hash-mismatch')
    }

    const importedAt = new Date(now()).toISOString()
    const meta = {
      schemaVersion: SCHEMA_VERSION,
      kind: 'import',
      importId,
      itemKind: kind,
      itemId: id,
      title: record.title ?? '',
      deviceId,
      version: record.version ?? '',
      dir: itemDir,
      importedAt,
      fileCount: hashed.length,
      bytes,
      hash: contentHash,
      runtimeImportSupported: false,
      source: { plugin: PLUGIN_NAME, schema: 'import/v1' },
      files: hashed,
    }
    await sink.writeJson(`${stagingDir}/meta.json`, meta)

    store.addImport({
      importId,
      kind,
      id,
      title: record.title ?? '',
      deviceId,
      version: record.version ?? '',
      importedAt,
      dir: stagingDir,
      fileCount: hashed.length,
      bytes,
    })
    store.data.counters.pulls += 1
    await store.save()

    return {
      importId,
      kind,
      id,
      title: record.title ?? '',
      deviceId,
      version: record.version ?? '',
      importedAt,
      fileCount: hashed.length,
      bytes,
      hash: contentHash,
      stagedDir: stagingDir,
      runtimeImportSupported: false,
      message:
        kind === 'workspace'
          ? '已暂存，可用 wps_sync_restore 恢复到指定目录'
          : '已暂存为可读归档；DSH 不支持安全导入会话/任务（runtimeImportSupported:false），请直接浏览或复制文本',
    }
  } catch (error) {
    await sink.removeTree(stagingDir).catch(() => {})
    throw error
  }
}

module.exports = { listRemote, pullRemote, buildImportId, collectRemoteFiles, stagedImportExists, REQUIRED_FILES, expectedPrefix }