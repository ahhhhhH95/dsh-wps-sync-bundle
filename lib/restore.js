'use strict'

/**
 * Restoring a staged workspace import into a directory the user chose.
 *
 * Only workspaces can be materialized: DSH offers no supported way to inject a
 * foreign session log or a foreign scheduler store, so sessions and tasks stay
 * readable archives instead of being restored into the live profile.
 */

const path = require('node:path')
const fs = require('node:fs/promises')
const { assertSafeRelative, resolveInside, isInside, findLinkedComponent } = require('./paths')
const { validateRestoreTarget } = require('./sync-root')
const { badRequest, notReady, corrupt } = require('./errors')
const { requireImport, importRoot } = require('./archive')
const { ensureDir, pathExists } = require('./json-file')

const CONFLICT_POLICIES = ['skip', 'rename']
const MAX_FILES = 20000

function nextCandidate(targetAbs, attempt) {
  const dir = path.dirname(targetAbs)
  const base = path.basename(targetAbs)
  const ext = path.extname(base)
  const stem = ext && ext.length < 16 ? base.slice(0, base.length - ext.length) : base
  return path.join(dir, `${stem} (${attempt})${ext}`)
}

/**
 * Walk the existing components between `baseAbs` and `targetAbs` and refuse a
 * symbolic link or Windows junction: a restore must never be redirected out of
 * the directory the user picked by a link planted under it.
 */
async function assertNoLinksFrom(baseAbs, targetAbs, label = '恢复路径') {
  const relative = path.relative(baseAbs, targetAbs)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw badRequest(`${label}越界：${targetAbs}`, 'wps-sync/path-escape')
  }
  const linked = await findLinkedComponent(baseAbs, targetAbs)
  if (linked) {
    throw badRequest(`${label}包含符号链接或目录联接：${linked}`, 'wps-sync/link-detected')
  }
}

/**
 * @param {{sink: object, store: object, importId: string, targetDir: string, conflict?: 'skip'|'rename', syncRoot?: string, maxBytes?: number}} options
 */
async function restoreWorkspace(options) {
  const { sink, store, importId, targetDir } = options
  const conflict = options.conflict ?? 'skip'
  if (!CONFLICT_POLICIES.includes(conflict)) {
    throw badRequest(`未知的冲突策略：${conflict}（可选 skip / rename）`, 'wps-sync/conflict-invalid')
  }

  const record = requireImport(store, importId)
  if (record.kind !== 'workspace') {
    throw badRequest(
      `${record.kind} 归档暂不支持导入到运行中的 DSH（runtimeImportSupported:false），请用 /archive 查看或复制文本`,
      'wps-sync/kind-not-restorable',
    )
  }

  const target = await validateRestoreTarget(targetDir, options.syncRoot)
  // The target itself (and every existing component) must not be a link.
  await assertNoLinksFrom(path.dirname(target), target, 'targetDir')
  const root = importRoot(importId)
  const sourceBase = `${root}/files`
  const walked = await sink.walk(sourceBase)
  if (walked.length === 0) throw corrupt('该导入没有可恢复的文件', 'wps-sync/import-empty')
  if (walked.length > MAX_FILES) throw badRequest('导入文件过多，拒绝恢复', 'wps-sync/import-too-large')
  if (await pathExists(target)) {
    const stats = await fs.stat(target)
    if (!stats.isDirectory()) throw badRequest('targetDir 已存在且不是文件夹', 'wps-sync/target-not-directory')
  }
  await ensureDir(target)

  // `realpath` catches a link that already existed when we started, and a
  // symlinked sync root pointing back at the target directory.
  if (options.syncRoot) {
    const realTarget = await fs.realpath(target).catch(() => target)
    const realSyncRoot = await fs.realpath(options.syncRoot).catch(() => null)
    if (realSyncRoot && (realTarget === realSyncRoot || isInside(realSyncRoot, realTarget))) {
      throw badRequest('targetDir 不能是同步目录或位于其内部', 'wps-sync/target-in-sync-root')
    }
  }

  let maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 64 * 1024 * 1024
  const restored = []
  const skipped = []
  const renamed = []
  let bytes = 0

  for (const entry of walked) {
    const inner = assertSafeRelative(entry.path.slice(sourceBase.length + 1), '归档文件路径')
    const buffer = await sink.read(entry.path)
    if (!buffer) continue
    bytes += buffer.length
    if (bytes > maxBytes) throw badRequest('恢复内容超过大小上限', 'wps-sync/restore-too-large')

    let destination = resolveInside(target, inner, '恢复路径')
    if (await pathExists(destination)) {
      if (conflict === 'skip') {
        skipped.push(inner)
        continue
      }
      let attempt = 2
      let candidate = nextCandidate(destination, attempt)
      while (await pathExists(candidate)) {
        attempt += 1
        if (attempt > 999) throw badRequest(`无法为 ${inner} 找到可用的新文件名`, 'wps-sync/rename-exhausted')
        candidate = nextCandidate(destination, attempt)
      }
      destination = candidate
      renamed.push({ from: inner, to: path.relative(target, candidate).split(path.sep).join('/') })
    }

    if (!isInside(target, destination) && path.resolve(destination) !== path.resolve(target)) {
      throw badRequest(`恢复路径越界：${inner}`, 'wps-sync/path-escape')
    }
    await assertNoLinksFrom(target, path.dirname(destination), '恢复路径')
    await ensureDir(path.dirname(destination))
    // 'wx' refuses an existing file: a restore can never overwrite silently.
    try {
      await fs.writeFile(destination, buffer, { flag: 'wx' })
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        skipped.push(inner)
        continue
      }
      throw error
    }
    restored.push(inner)
  }

  return {
    importId,
    kind: 'workspace',
    title: record.title,
    targetDir: target,
    restored: restored.length,
    skipped: skipped.length,
    renamed: renamed.length,
    bytes,
    conflict,
    files: restored.slice(0, 200),
    skippedFiles: skipped.slice(0, 50),
    renamedFiles: renamed.slice(0, 50),
    message: skipped.length > 0 ? `已恢复 ${restored.length} 个文件，跳过 ${skipped.length} 个已存在的文件` : `已恢复 ${restored.length} 个文件`,
  }
}

module.exports = { restoreWorkspace, CONFLICT_POLICIES, nextCandidate }