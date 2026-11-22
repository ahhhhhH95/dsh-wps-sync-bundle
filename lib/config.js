'use strict'

/**
 * Plugin configuration and the exclude matcher.
 *
 * `Config` is built lazily from the host peer `@deepseek-ai/schemastery` so the
 * bundle can run with or without a loadable schema: the patch already carries a
 * complete configuration, and the panel edits go through the host settings
 * document rather than through this schema.
 */

const {
  DEFAULT_EXCLUDES,
  DEFAULT_MAX_FILE_MB,
  DEFAULT_SCAN_SEC,
  DEFAULT_TASK_HISTORY_LIMIT,
  DEFAULT_DEBOUNCE_MS,
} = require('./constants')

/** Configuration served to callers when the patch omits a field. */
const DEFAULTS = Object.freeze({
  syncRootDir: '',
  autoSync: true,
  excludePatterns: DEFAULT_EXCLUDES,
  maxFileSizeMB: DEFAULT_MAX_FILE_MB,
  workspaceScanIntervalSec: DEFAULT_SCAN_SEC,
  taskHistoryLimit: DEFAULT_TASK_HISTORY_LIMIT,
  debounceMs: DEFAULT_DEBOUNCE_MS,
  deviceName: '',
})

function loadSchemaFactory() {
  try {
    // The host ships schemastery as a peer; a profile-installed bundle may not
    // have it, in which case `Config` simply stays undefined.
    const loaded = require('@deepseek-ai/schemastery')
    const candidate = loaded && (loaded.default ?? loaded)
    if (candidate && typeof candidate.object === 'function') return candidate
    if (candidate && candidate.Schema && typeof candidate.Schema.object === 'function') return candidate.Schema
  } catch {
    /* no host peer available: run without a schema */
  }
  return null
}

function buildConfigSchema() {
  const Schema = loadSchemaFactory()
  if (!Schema) return null
  try {
    return Schema.object({
      syncRootDir: Schema.string().default('').description('WPS 同步目录，留空则自动探测'),
      autoSync: Schema.boolean().default(true).description('新建条目默认开启自动同步'),
      excludePatterns: Schema.array(Schema.string())
        .default(DEFAULT_EXCLUDES)
        .description('工作区镜像排除规则（目录名或 *.ext）'),
      maxFileSizeMB: Schema.number().default(DEFAULT_MAX_FILE_MB).description('单个文件上限（MB）'),
      workspaceScanIntervalSec: Schema.number()
        .default(DEFAULT_SCAN_SEC)
        .description('工作区扫描周期（秒），0 表示关闭'),
      taskHistoryLimit: Schema.number().default(DEFAULT_TASK_HISTORY_LIMIT).description('每个任务保留的投递记录'),
      debounceMs: Schema.number().default(DEFAULT_DEBOUNCE_MS).description('回合结束后的导出防抖（毫秒）'),
      deviceName: Schema.string().default('').description('设备显示名，留空则使用主机名'),
    })
  } catch {
    return null
  }
}

function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'string' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

function normalizePatterns(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\n]/)
      : []
  const out = []
  for (const entry of list) {
    const pattern = String(entry ?? '').trim()
    if (!pattern) continue
    if (out.includes(pattern)) continue
    out.push(pattern)
    if (out.length >= 200) break
  }
  return out.length > 0 ? out : [...DEFAULT_EXCLUDES]
}

/** Merge raw patch config into the effective settings. */
function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  return {
    syncRootDir: typeof input.syncRootDir === 'string' ? input.syncRootDir.trim() : '',
    autoSync: input.autoSync !== false,
    excludePatterns: normalizePatterns(input.excludePatterns),
    maxFileSizeMB: clampNumber(input.maxFileSizeMB, 1, 2048, DEFAULT_MAX_FILE_MB),
    workspaceScanIntervalSec: clampNumber(
      input.workspaceScanIntervalSec,
      0,
      86400,
      DEFAULT_SCAN_SEC,
    ),
    taskHistoryLimit: clampNumber(input.taskHistoryLimit, 0, 500, DEFAULT_TASK_HISTORY_LIMIT),
    debounceMs: clampNumber(input.debounceMs, 0, 60000, DEFAULT_DEBOUNCE_MS),
    deviceName: typeof input.deviceName === 'string' ? input.deviceName.trim().slice(0, 80) : '',
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Translate a simple glob (`*`, `?`) into an anchored RegExp. */
function globToRegExp(pattern) {
  let source = ''
  for (const char of String(pattern)) {
    if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += escapeRegExp(char)
  }
  return new RegExp(`^${source}$`, 'i')
}

/**
 * Build a predicate over archive-relative POSIX paths.
 *
 * A pattern without `/` matches a path segment (directory name) or the file
 * name; a pattern with `/` matches the whole relative path.
 */
function createExcludeMatcher(patterns) {
  const list = normalizePatterns(patterns)
  const rules = list.map((pattern) => {
    const posix = pattern.replace(/\\/g, '/').replace(/^\/+/, '')
    return { posix, hasSlash: posix.includes('/'), regex: globToRegExp(posix) }
  })
  return function isExcluded(relativePosix) {
    const target = String(relativePosix).replace(/\\/g, '/')
    const segments = target.split('/')
    const base = segments[segments.length - 1]
    for (const rule of rules) {
      if (rule.hasSlash) {
        if (rule.regex.test(target)) return true
        continue
      }
      if (rule.regex.test(base)) return true
      for (let index = 0; index < segments.length - 1; index += 1) {
        if (rule.regex.test(segments[index])) return true
      }
    }
    return false
  }
}

module.exports = {
  DEFAULTS,
  Config: buildConfigSchema(),
  normalizeConfig,
  createExcludeMatcher,
  globToRegExp,
  normalizePatterns,
}