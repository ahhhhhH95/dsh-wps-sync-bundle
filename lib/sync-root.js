'use strict'

/**
 * Locating and validating the sync root.
 *
 * The user's WPS cloud folder is a normal directory that the WPS client keeps in
 * sync; the account folder inside it differs per machine, so the default is the
 * first account directory found under `WPS Cloud Files`.
 */

const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs/promises')
const { badRequest, notReady } = require('./errors')
const { isDirectory, listDir, pathExists } = require('./json-file')
const { isAbsoluteLike } = require('./paths')

/** Candidate parent directories that may hold WPS account folders. */
function wpsRootCandidates(homeDir = os.homedir()) {
  const candidates = [
    path.join(homeDir, 'WPS Cloud Files'),
    path.join(homeDir, 'WPSDrive'),
    path.join(homeDir, 'WPS Cloud'),
    path.join(homeDir, 'Documents', 'WPS Cloud Files'),
  ]
  return candidates
}

/**
 * Detect the WPS sync root. Returns `{root, base, account, source}` or null.
 *
 * The first existing candidate wins; inside it the first account directory is
 * used when present, otherwise the candidate itself.
 */
async function detectSyncRoot(options = {}) {
  const homeDir = options.homeDir ?? os.homedir()
  for (const base of wpsRootCandidates(homeDir)) {
    if (!(await isDirectory(base))) continue
    const entries = (await listDir(base))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'))
    if (entries.length > 0) {
      return { root: path.join(base, entries[0]), base, account: entries[0], source: 'wps-cloud-files' }
    }
    return { root: base, base, account: null, source: 'wps-cloud-files' }
  }
  return null
}

/**
 * Validate a user supplied sync root.
 * @returns {Promise<{ok: boolean, resolved?: string, error?: string}>}
 */
async function validateSyncRoot(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: '同步目录为空' }
  }
  const raw = input.trim()
  if (!isAbsoluteLike(raw)) {
    return { ok: false, error: '同步目录必须是绝对路径' }
  }
  const resolved = path.resolve(raw)
  if (!(await pathExists(resolved))) {
    return { ok: false, resolved, error: '同步目录不存在' }
  }
  if (!(await isDirectory(resolved))) {
    return { ok: false, resolved, error: '同步目录不是一个文件夹' }
  }
  try {
    await fs.access(resolved, fs.constants.W_OK)
  } catch {
    return { ok: false, resolved, error: '同步目录不可写' }
  }
  return { ok: true, resolved }
}

/**
 * Resolve the effective root: explicit config wins, then the cached choice, then
 * auto-detection. Never throws.
 */
async function resolveSyncRoot(options = {}) {
  const configured = typeof options.configured === 'string' ? options.configured.trim() : ''
  const cached = typeof options.cached === 'string' ? options.cached.trim() : ''
  const detected = await detectSyncRoot({ homeDir: options.homeDir })

  if (configured) {
    const checked = await validateSyncRoot(configured)
    return {
      root: checked.ok ? checked.resolved : null,
      requested: configured,
      detectedRoot: detected ? detected.root : null,
      source: 'config',
      valid: checked.ok,
      error: checked.ok ? null : checked.error,
    }
  }

  if (cached) {
    const checked = await validateSyncRoot(cached)
    if (checked.ok) {
      return { root: checked.resolved, requested: cached, detectedRoot: detected ? detected.root : null, source: 'state', valid: true, error: null }
    }
  }

  if (detected) {
    const checked = await validateSyncRoot(detected.root)
    return {
      root: checked.ok ? checked.resolved : null,
      requested: detected.root,
      detectedRoot: detected.root,
      source: 'detected',
      valid: checked.ok,
      error: checked.ok ? null : checked.error,
    }
  }

  return { root: null, requested: '', detectedRoot: null, source: 'none', valid: false, error: '未找到 WPS 同步目录，请手动选择' }
}

/** Throw unless a usable root exists. */
function requireRoot(resolved) {
  if (!resolved || !resolved.root) {
    throw notReady(resolved && resolved.error ? resolved.error : '尚未设置同步目录', 'wps-sync/no-root')
  }
  return resolved.root
}

/**
 * Guard for the workspace restore target: it must be an absolute path outside
 * the sync root (and outside the DSH-Sync folder inside it).
 */
async function validateRestoreTarget(targetDir, syncRoot) {
  if (typeof targetDir !== 'string' || targetDir.trim() === '') {
    throw badRequest('恢复工作区必须指定 targetDir', 'wps-sync/target-required')
  }
  const raw = targetDir.trim()
  if (!isAbsoluteLike(raw)) throw badRequest('targetDir 必须是绝对路径', 'wps-sync/target-invalid')
  const resolved = path.resolve(raw)
  if (syncRoot) {
    const rootAbs = path.resolve(syncRoot)
    const { isSameOrInside } = require('./paths')
    if (isSameOrInside(rootAbs, resolved)) {
      throw badRequest('targetDir 不能是同步目录或位于同步目录内', 'wps-sync/target-in-sync-root')
    }
  }
  return resolved
}

module.exports = {
  wpsRootCandidates,
  detectSyncRoot,
  validateSyncRoot,
  resolveSyncRoot,
  requireRoot,
  validateRestoreTarget,
}