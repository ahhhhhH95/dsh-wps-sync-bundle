'use strict'

/**
 * Bounded read access to a staged import.
 *
 * The panel and the `wps_sync_restore` tool need to show what a pulled archive
 * contains; both go through here so the plugin can never be talked into reading
 * an arbitrary path on the machine.
 */

const { assertSafeRelative } = require('./paths')
const { MAX_ARCHIVE_BYTES } = require('./constants')
const { badRequest, notReady } = require('./errors')

function requireImport(store, importId) {
  if (typeof importId !== 'string' || importId === '') {
    throw badRequest('缺少 importId', 'wps-sync/no-import-id')
  }
  const record = store.findImport(importId)
  if (!record) throw notReady('未找到该导入记录，请先执行 pull', 'wps-sync/import-not-found')
  return record
}

function importRoot(importId) {
  return `imports/${assertSafeRelative(importId, 'importId')}`
}

/** Metadata plus the file list of a staged import. */
async function describeImport(options) {
  const { sink, store, importId } = options
  const record = requireImport(store, importId)
  const root = importRoot(importId)
  const files = []
  let bytes = 0
  for (const entry of await sink.walk(`${root}/files`)) {
    const inner = entry.path.slice(`${root}/files`.length + 1)
    files.push({ path: inner, bytes: entry.size })
    bytes += entry.size
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return {
    importId,
    kind: record.kind,
    id: record.id,
    title: record.title,
    deviceId: record.deviceId,
    version: record.version,
    importedAt: record.importedAt,
    fileCount: files.length,
    bytes,
    files,
    runtimeImportSupported: false,
    stagedDir: record.dir,
    meta: await sink.readJson(`${root}/meta.json`, null),
  }
}

/** Read one staged file as UTF-8 text, size limited. */
async function readImportFile(options) {
  const { sink, store, importId } = options
  const record = requireImport(store, importId)
  const root = importRoot(importId)
  const relative = typeof options.path === 'string' && options.path !== '' ? options.path : null
  if (!relative) {
    return { importId, kind: record.kind, text: null, files: (await describeImport({ sink, store, importId })).files }
  }
  const inner = assertSafeRelative(relative, '归档文件路径')
  const stats = await sink.stat(`${root}/files/${inner}`)
  if (!stats || !stats.isFile) throw badRequest(`导入中不存在该文件：${inner}`, 'wps-sync/archive-file-missing')
  const limit = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? Math.min(options.maxBytes, MAX_ARCHIVE_BYTES) : MAX_ARCHIVE_BYTES
  if (stats.size > limit) {
    throw badRequest(`文件超过可读取上限（${limit} 字节）`, 'wps-sync/archive-file-too-large')
  }
  const buffer = await sink.read(`${root}/files/${inner}`)
  if (!buffer) throw badRequest(`导入文件不可读：${inner}`, 'wps-sync/archive-file-missing')
  if (buffer.includes(0)) {
    return { importId, kind: record.kind, path: inner, bytes: buffer.length, text: null, binary: true }
  }
  return { importId, kind: record.kind, path: inner, bytes: buffer.length, text: buffer.toString('utf8') }
}

module.exports = { describeImport, readImportFile, requireImport, importRoot }