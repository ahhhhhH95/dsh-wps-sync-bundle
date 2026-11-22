'use strict'

/**
 * Workspace mirror export.
 *
 * A workspace is a directory on this machine; the archive gets a copy under
 * `workspaces/<deviceId>/<slug>-<workspaceId>/files/...`. The mirror is
 * incremental: a file whose size and mtime still match the recorded table is not
 * copied again, and files that disappeared from the source are removed from the
 * mirror (but never from any other device's directory).
 */

const path = require('node:path')
const fs = require('node:fs/promises')
const { nameWithId, assertSafeRelative, isSameOrInside, findLinkedComponent } = require('./paths')
const { hashFiles } = require('./hash')
const { publishItem } = require('./manifest')
const { itemKey } = require('./store')
const { SCHEMA_VERSION, PLUGIN_NAME, DEFAULT_MAX_FILE_MB } = require('./constants')
const { badRequest, notReady } = require('./errors')
const { createExcludeMatcher } = require('./config')
const { isDirectory } = require('./json-file')

const MAX_SCAN_ENTRIES = 20000

/**
 * List the regular files of a directory tree, skipping symlinks and links that
 * would leave the tree.
 */
async function walkSource(rootAbs, options = {}) {
  const maxEntries = options.maxEntries ?? MAX_SCAN_ENTRIES
  const out = []
  const skipped = []
  const stack = ['']
  while (stack.length > 0) {
    const rel = stack.pop()
    const abs = rel ? path.join(rootAbs, ...rel.split('/')) : rootAbs
    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        skipped.push({ path: childRel, reason: 'symlink' })
        continue
      }
      if (entry.isDirectory()) {
        // `Dirent.isSymbolicLink()` is false for a Windows junction, so the
        // directory is only descended into when no component below the
        // workspace root resolves elsewhere.
        const linked = await findLinkedComponent(rootAbs, path.join(abs, entry.name))
        if (linked) {
          skipped.push({ path: childRel, reason: 'symlink' })
          continue
        }
        stack.push(childRel)
        continue
      }
      if (!entry.isFile()) continue
      try {
        assertSafeRelative(childRel)
      } catch {
        skipped.push({ path: childRel, reason: 'unsafe-name' })
        continue
      }
      const childAbs = path.join(abs, entry.name)
      let stats
      try {
        stats = await fs.stat(childAbs)
      } catch {
        continue
      }
      out.push({ path: childRel, abs: childAbs, size: stats.size, mtimeMs: stats.mtimeMs })
      if (out.length >= maxEntries) {
        skipped.push({ path: '', reason: 'entry-limit' })
        return { files: out, skipped }
      }
    }
  }
  out.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return { files: out, skipped }
}

/**
 * @param {{sink: object, store: object, device: object, workspace: object, config: object, syncRoot?: string, force?: boolean, now?: () => number}} options
 */
async function exportWorkspace(options) {
  const { sink, store, device, workspace, force = false } = options
  const now = options.now ?? (() => Date.now())
  const config = options.config ?? {}
  if (!workspace || typeof workspace.id !== 'string' || workspace.id === '') {
    throw badRequest('缺少工作区 ID', 'wps-sync/no-workspace-id')
  }
  if (typeof workspace.path !== 'string' || workspace.path === '') {
    throw badRequest('工作区没有本地目录', 'wps-sync/workspace-no-path')
  }

  const rootPath = path.resolve(workspace.path)
  if (!(await isDirectory(rootPath))) {
    throw notReady(`工作区目录不存在：${rootPath}`, 'wps-sync/workspace-missing')
  }
  // Mirroring the sync folder into itself would grow without bound, and a
  // workspace that lives inside the archive would collide with its own mirror.
  if (isSameOrInside(rootPath, sink.rootDir) || (options.syncRoot && isSameOrInside(rootPath, options.syncRoot))) {
    throw badRequest('工作区目录包含同步目录，已跳过以防递归镜像', 'wps-sync/workspace-contains-sync-root')
  }
  if (isSameOrInside(sink.rootDir, rootPath) || (options.syncRoot && isSameOrInside(options.syncRoot, rootPath))) {
    throw badRequest('工作区目录位于同步目录内，已跳过以防递归镜像', 'wps-sync/workspace-inside-sync-root')
  }

  const matcher = createExcludeMatcher(config.excludePatterns)
  const maxBytes = Math.max(1, Number(config.maxFileSizeMB) || DEFAULT_MAX_FILE_MB) * 1024 * 1024
  const title = typeof workspace.title === 'string' && workspace.title.trim() ? workspace.title.trim() : path.basename(rootPath)
  const dir = `workspaces/${device.id}/${nameWithId(title, workspace.id, 'workspace')}`

  const previous = store.workspaceTable(workspace.id)
  const known = previous && previous.root === rootPath ? { ...previous.files } : {}

  const { files: found, skipped } = await walkSource(rootPath)
  const mirrored = {}
  const fileRecords = []
  const copied = []
  let bytes = 0

  for (const file of found) {
    if (matcher(file.path)) continue
    if (file.size > maxBytes) {
      skipped.push({ path: file.path, reason: 'too-large' })
      continue
    }
    const key = assertSafeRelative(file.path, '镜像路径')
    const before = known[key]
    if (!force && before && before.size === file.size && before.mtimeMs === file.mtimeMs && before.hash) {
      // mtime/size fast path is only valid while the mirror file still exists:
      // a user (or a cloud client) may have deleted or moved it.
      const present = await sink.stat(`${dir}/files/${key}`)
      if (present && present.isFile) {
        mirrored[key] = before
        fileRecords.push({ path: key, bytes: before.size, hash: before.hash })
        bytes += before.size
        continue
      }
    }
    const written = await sink.copyIn(`${dir}/files/${key}`, file.abs)
    mirrored[key] = { size: file.size, mtimeMs: file.mtimeMs, hash: written.hash }
    fileRecords.push({ path: key, bytes: written.bytes, hash: written.hash })
    bytes += written.bytes
    copied.push(key)
  }

  const removed = []
  for (const rel of Object.keys(known)) {
    if (Object.prototype.hasOwnProperty.call(mirrored, rel)) continue
    try {
      await sink.remove(`${dir}/files/${rel}`)
      removed.push(rel)
    } catch {
      /* a stale mirror entry that is already gone is fine */
    }
  }

  const hash = hashFiles(fileRecords)
  const exportedAt = new Date(now()).toISOString()
  const existing = store.getItem(itemKey('workspace', workspace.id))

  if (!force && existing && existing.lastHash === hash && existing.dir === dir) {
    store.setWorkspaceTable(workspace.id, rootPath, mirrored)
    store.recordResult('workspace', workspace.id, { status: 'unchanged', hash, dir, title })
    await store.save()
    return { status: 'unchanged', kind: 'workspace', id: workspace.id, title, dir, hash, fileCount: fileRecords.length, bytes }
  }

  await sink.ensure()
  const meta = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'workspace',
    id: workspace.id,
    title,
    dir,
    rootPath,
    device: { id: device.id, name: device.name, platform: device.platform },
    exportedAt,
    hash,
    fileCount: fileRecords.length,
    sizeBytes: bytes,
    files: fileRecords,
    skipped: skipped.slice(0, 50),
    source: { plugin: PLUGIN_NAME, schema: 'workspace/v1' },
  }
  await sink.writeJson(`${dir}/meta.json`, meta)

  const item = {
    deviceId: device.id,
    kind: 'workspace',
    id: workspace.id,
    title,
    dir,
    version: hash,
    hash,
    eventCount: null,
    fileCount: fileRecords.length,
    sizeBytes: bytes,
    platform: device.platform,
    exportedAt,
  }
  await publishItem(sink, device, `workspace/${workspace.id}`, item, now)

  store.setWorkspaceTable(workspace.id, rootPath, mirrored)
  store.recordResult('workspace', workspace.id, { status: 'uploaded', hash, dir, title })
  store.data.counters.uploads += 1
  await store.save()

  return {
    status: 'uploaded',
    kind: 'workspace',
    id: workspace.id,
    title,
    dir,
    hash,
    fileCount: fileRecords.length,
    bytes,
    copied: copied.length,
    removed: removed.length,
    skipped: skipped.length,
  }
}

module.exports = { exportWorkspace, walkSource, MAX_SCAN_ENTRIES }