'use strict'

/**
 * The `SyncSink` abstraction and its local-directory implementation.
 *
 * Everything the engine writes goes through a sink, addressed by a POSIX path
 * relative to `<syncRoot>/DSH-Sync`. A future WebDAV or object-store sink only
 * has to implement the same handful of methods; the exporter never touches the
 * file system directly.
 */

const path = require('node:path')
const fs = require('node:fs/promises')
const {
  assertSafeRelative,
  resolveInside,
  isInside,
  toPosix,
  findLinkedComponent,
} = require('./paths')
const { hashBuffer } = require('./hash')
const { badRequest } = require('./errors')
const { DEFAULT_COPY_TIMEOUT_MS } = require('./constants')
const {
  ensureDir,
  writeBytesAtomic,
  writeJsonAtomic,
  readJson,
  readFileOrNull,
  pathExists,
  listDir,
  removeTree,
  copyFileAtomic,
  isDirectory,
} = require('./json-file')

/**
 * Per-file mirroring bound: `DSH_WPS_SYNC_COPY_TIMEOUT_MS` overrides the default
 * (`0` = unbounded), mostly for tests and for providers that hydrate slowly.
 */
function resolveCopyTimeout(explicit) {
  if (Number.isFinite(explicit)) return Math.max(0, Math.trunc(explicit))
  const raw = process.env.DSH_WPS_SYNC_COPY_TIMEOUT_MS
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed))
  }
  return DEFAULT_COPY_TIMEOUT_MS
}

class SyncSink {
  /* eslint-disable no-unused-vars */
  async ensure() {
    throw new Error('not implemented')
  }

  async write(relative, buffer) {
    throw new Error('not implemented')
  }

  async read(relative) {
    throw new Error('not implemented')
  }

  async stat(relative) {
    throw new Error('not implemented')
  }

  async list(relative) {
    throw new Error('not implemented')
  }
  /* eslint-enable no-unused-vars */
}

class LocalDirSink extends SyncSink {
  /**
   * @param {{rootDir: string}} options `rootDir` is `<syncRoot>/DSH-Sync`
   */
  constructor(options) {
    super()
    this.root = path.resolve(options.rootDir)
  }

  get rootDir() {
    return this.root
  }

  /** Absolute path of an archive-relative entry, refusing escapes. */
  resolve(relative, label = '路径') {
    return resolveInside(this.root, relative, label)
  }

  /**
   * Refuse an absolute target whose already-existing components below the
   * archive root are symbolic links or Windows junctions.
   *
   * The archive lives inside a *cloud-synced* folder, so its tree can be
   * replaced by a link pointing anywhere on disk. Every write/delete therefore
   * walks the existing components with `lstat` (which does not follow links)
   * and stops at the first one that is a link. After the walk the parent's
   * realpath is compared with the archive root's realpath.
   */
  async assertNoLinks(absTarget, label = '路径') {
    if (!isInside(this.root, absTarget)) {
      throw badRequest(`${label}越界：${toPosix(absTarget)}`, 'wps-sync/path-invalid')
    }
    // `findLinkedComponent` is the authoritative check: on Windows a junction
    // reports `isSymbolicLink() === false` and `readlink` fails with EINVAL, so
    // link-ness is decided by comparing `realpath` with the expected path.
    const linked = await findLinkedComponent(this.root, absTarget)
    if (linked) {
      throw badRequest(`${label}包含符号链接或目录联接：${linked}`, 'wps-sync/link-detected')
    }
    return absTarget
  }

  async ensure() {
    await ensureDir(this.root)
    return this.root
  }

  async write(relative, buffer) {
    const target = this.resolve(relative)
    await this.assertNoLinks(target, '写入路径')
    await writeBytesAtomic(target, buffer)
    return { path: toPosix(assertSafeRelative(relative)), bytes: buffer.length, hash: hashBuffer(buffer) }
  }

  async writeText(relative, text) {
    return this.write(relative, Buffer.from(String(text), 'utf8'))
  }

  async writeJson(relative, value) {
    const target = this.resolve(relative)
    await this.assertNoLinks(target, '写入路径')
    await writeJsonAtomic(target, value)
    const text = `${JSON.stringify(value, null, 2)}\n`
    return { path: toPosix(assertSafeRelative(relative)), bytes: Buffer.byteLength(text), hash: hashBuffer(Buffer.from(text, 'utf8')) }
  }

  async read(relative) {
    const target = this.resolve(relative)
    // Reading must not follow a link out of the archive either.
    await this.assertNoLinks(target, '读取路径')
    return readFileOrNull(target)
  }

  async readJson(relative, fallback = null) {
    return readJson(this.resolve(relative), fallback)
  }

  async exists(relative) {
    return pathExists(this.resolve(relative))
  }

  async stat(relative) {
    try {
      const stats = await fs.stat(this.resolve(relative))
      return { isDirectory: stats.isDirectory(), isFile: stats.isFile(), size: stats.size, mtimeMs: stats.mtimeMs }
    } catch {
      return null
    }
  }

  async list(relative) {
    return listDir(this.resolve(relative))
  }

  async isDirectory(relative) {
    try {
      return await isDirectory(this.resolve(relative))
    } catch {
      return false
    }
  }

  /** Recursively list regular files under `relative`, POSIX paths. */
  async walk(relative, options = {}) {
    const base = this.resolve(relative)
    const out = []
    const maxEntries = options.maxEntries ?? 20000
    const stack = [{ abs: base, rel: assertSafeRelative(relative) }]
    while (stack.length > 0) {
      if (out.length >= maxEntries) break
      const current = stack.pop()
      const entries = await listDir(current.abs)
      for (const entry of entries) {
        const childRel = `${current.rel}/${entry.name}`
        try {
          assertSafeRelative(childRel)
        } catch {
          continue
        }
        const childAbs = path.join(current.abs, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          // A junction reports as a directory; walking into one would copy files
          // from outside the archive into an import.
          const linked = await findLinkedComponent(this.root, childAbs)
          if (linked) continue
          stack.push({ abs: childAbs, rel: childRel })
          continue
        }
        if (!entry.isFile()) continue
        const stats = await fs.stat(childAbs)
        out.push({ path: childRel, abs: childAbs, size: stats.size, mtimeMs: stats.mtimeMs })
      }
    }
    return out
  }

  async remove(relative) {
    const target = this.resolve(relative)
    await this.assertNoLinks(target, '删除路径')
    await fs.rm(target, { force: true, recursive: false })
  }

  async removeTree(relative) {
    const target = this.resolve(relative)
    if (!isInside(this.root, target)) throw badRequest(`拒绝删除同步目录外的路径：${relative}`)
    await this.assertNoLinks(target, '删除路径')
    await removeTree(target)
  }

  async copyIn(relative, sourceAbs, options = {}) {
    const target = this.resolve(relative, '镜像路径')
    await this.assertNoLinks(target, '镜像路径')
    const timeoutMs = resolveCopyTimeout(options.timeoutMs)
    await copyFileAtomic(sourceAbs, target, { timeoutMs })
    const buffer = await fs.readFile(target)
    return { path: toPosix(assertSafeRelative(relative)), bytes: buffer.length, hash: hashBuffer(buffer) }
  }

  async fileHash(relative) {
    const buffer = await this.read(relative)
    return buffer ? hashBuffer(buffer) : null
  }
}

module.exports = { SyncSink, LocalDirSink }