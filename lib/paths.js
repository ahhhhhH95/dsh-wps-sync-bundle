'use strict'

/**
 * Path handling shared by the exporter, the importer and the restore path.
 *
 * Archives always store POSIX relative paths; Windows separators are converted
 * on the way in, and any path that could escape the sync root is refused
 * before it reaches the filesystem.
 */

const path = require('node:path')
const { badRequest } = require('./errors')

/** `C:` or `c:` at the start of a value. */
const DRIVE_RE = /^[A-Za-z]:/

/** `\\server\share` or `//server/share`. */
const UNC_RE = /^(?:\\\\|\/\/)/

/** Characters Windows refuses in a file name (the archive is portable). */
const ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f\u007f]/

/** Device names Windows reserves regardless of extension. */
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.[^.]*)?$/i

/** Longest relative path we are willing to materialize. */
const MAX_RELATIVE_BYTES = 900

/** Longest single segment after slugging. */
const MAX_SEGMENT_BYTES = 180

function toPosix(value) {
  return String(value).replace(/\\/g, '/')
}

function isAbsoluteLike(value) {
  const text = String(value)
  return (
    text.startsWith('/') ||
    text.startsWith('\\') ||
    DRIVE_RE.test(text) ||
    UNC_RE.test(text) ||
    path.isAbsolute(text)
  )
}

/**
 * Validate one archive-relative path and return it in canonical POSIX form.
 * Throws a `SyncError` for absolute paths, drive letters, UNC prefixes,
 * traversal segments, illegal characters and over-long paths.
 */
function assertSafeRelative(value, label = '路径') {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`${label}必须是非空字符串`, 'wps-sync/path-invalid')
  }
  const posix = toPosix(value)
  if (posix.includes('\u0000')) {
    throw badRequest(`${label}包含空字符`, 'wps-sync/path-invalid')
  }
  if (isAbsoluteLike(posix)) {
    throw badRequest(`${label}必须是相对路径：${value}`, 'wps-sync/path-absolute')
  }
  if (Buffer.byteLength(posix, 'utf8') > MAX_RELATIVE_BYTES) {
    throw badRequest(`${label}过长：${value}`, 'wps-sync/path-too-long')
  }
  const segments = posix.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) {
    throw badRequest(`${label}不能是空路径`, 'wps-sync/path-invalid')
  }
  for (const segment of segments) {
    assertSafeSegment(segment, label)
  }
  return segments.join('/')
}

/** Validate a single path segment (file or directory name). */
function assertSafeSegment(segment, label = '路径') {
  if (segment === '' || segment === '.' || segment === '..') {
    throw badRequest(`${label}包含非法段：${segment}`, 'wps-sync/path-traversal')
  }
  if (segment.includes('/') || segment.includes('\\')) {
    throw badRequest(`${label}的段不能包含分隔符：${segment}`, 'wps-sync/path-invalid')
  }
  if (ILLEGAL_CHARS.test(segment)) {
    throw badRequest(`${label}包含非法字符：${segment}`, 'wps-sync/path-invalid')
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    throw badRequest(`${label}的段不能以点或空格结尾：${segment}`, 'wps-sync/path-invalid')
  }
  if (RESERVED_NAME.test(segment)) {
    throw badRequest(`${label}使用了系统保留名：${segment}`, 'wps-sync/path-invalid')
  }
  if (Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES) {
    throw badRequest(`${label}的段过长：${segment}`, 'wps-sync/path-too-long')
  }
  return segment
}

/** True when `child` is strictly inside `parent` (case aware on Windows). */
function isInside(parentAbs, childAbs) {
  const relative = path.relative(path.resolve(parentAbs), path.resolve(childAbs))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** True when `child` equals `parent` or is inside it. */
function isSameOrInside(parentAbs, childAbs) {
  return path.resolve(parentAbs) === path.resolve(childAbs) || isInside(parentAbs, childAbs)
}

/**
 * Resolve an archive-relative path under an absolute root, refusing escapes.
 * The returned value is absolute and guaranteed to live under `rootAbs`.
 */
function resolveInside(rootAbs, relative, label = '路径') {
  const safe = assertSafeRelative(relative, label)
  const root = path.resolve(rootAbs)
  const target = path.resolve(root, ...safe.split('/'))
  if (!isInside(root, target)) {
    throw badRequest(`${label}越出了目标目录：${relative}`, 'wps-sync/path-escape')
  }
  return target
}

/** Convert an absolute path to a POSIX path relative to `rootAbs`. */
function relativePosix(rootAbs, absPath) {
  return toPosix(path.relative(path.resolve(rootAbs), path.resolve(absPath)))
}

/** Make a title safe to use as one directory-name fragment. */
function slugify(title, options = {}) {
  const fallback = options.fallback ?? 'item'
  const maxLength = options.maxLength ?? 48
  let text = String(title ?? '').normalize('NFKC').trim()
  if (!text) return fallback
  text = text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+/, '')
  if (!text) return fallback
  const chars = Array.from(text)
  if (chars.length > maxLength) text = chars.slice(0, maxLength).join('')
  text = text.replace(/[-._]+$/, '')
  if (!text || RESERVED_NAME.test(text)) return fallback
  return text
}

/** Make an id safe to use as one directory-name fragment without slugging CJK. */
function sanitizeId(id, fallback = 'item') {
  const text = String(id ?? '')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  if (!text || RESERVED_NAME.test(text)) return fallback
  const chars = Array.from(text)
  if (chars.length > 96) return chars.slice(0, 96).join('')
  return text
}

/** `<base>-<id>` so two different items can never collide in one directory. */
function nameWithId(title, id, fallback = 'item') {
  const base = slugify(title, { fallback })
  const suffix = sanitizeId(id, 'anonymous')
  return `${base}-${suffix}`
}

/** Compact UTC stamp, safe in file and directory names. */
function timestampStamp(date = new Date()) {
  const iso = new Date(date).toISOString()
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/** Windows paths compare case-insensitively. */
function samePath(left, right) {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase()
  return left === right
}

/**
 * Find the first *existing* component between `baseAbs` and `targetAbs` that is
 * a symbolic link, a Windows junction or any other reparse point.
 *
 * `lstat().isSymbolicLink()` misses Windows junctions (Node reports them as
 * directories) and `readlink` fails on them too, so link-ness is decided by
 * comparing `realpath()` with the expected path below the base. Ancestor links
 * *above* the base are normalised away by resolving the base first, so a sync
 * root that is itself a junction is not misreported.
 *
 * @returns {Promise<string|null>} POSIX path of the offending component
 */
async function findLinkedComponent(baseAbs, targetAbs) {
  const fs = require('node:fs/promises')
  const base = path.resolve(baseAbs)
  const target = path.resolve(targetAbs)
  if (!isSameOrInside(base, target) && !samePath(base, target)) {
    throw badRequest(`路径越界：${targetAbs}`, 'wps-sync/path-escape')
  }
  const baseReal = await fs.realpath(base).catch(() => base)
  let current = base
  const relative = path.relative(base, target)
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue
    current = path.join(current, segment)
    let stats
    try {
      stats = await fs.lstat(current)
    } catch {
      // The first missing component ends the walk: nothing below it exists.
      return null
    }
    if (typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) {
      return toPosix(path.relative(base, current))
    }
    const real = await fs.realpath(current).catch(() => null)
    if (real === null) return null
    const expected = path.join(baseReal, path.relative(base, current))
    if (!samePath(real, expected)) return toPosix(path.relative(base, current))
  }
  return null
}

module.exports = {
  toPosix,
  isAbsoluteLike,
  assertSafeRelative,
  assertSafeSegment,
  isInside,
  isSameOrInside,
  resolveInside,
  relativePosix,
  slugify,
  sanitizeId,
  nameWithId,
  timestampStamp,
  samePath,
  findLinkedComponent,
  MAX_RELATIVE_BYTES,
}