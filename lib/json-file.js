'use strict'

/**
 * Durable JSON / byte helpers.
 *
 * Every write goes to a temporary sibling and is renamed into place, so a crash
 * (or a second device reading the folder at that moment) never observes a
 * half-written manifest or archive entry.
 */

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

async function ensureDir(dirAbs) {
  await fs.mkdir(dirAbs, { recursive: true })
  return dirAbs
}

async function pathExists(target) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

function tempNameFor(fileAbs) {
  const dir = path.dirname(fileAbs)
  const base = path.basename(fileAbs)
  const nonce = crypto.randomBytes(6).toString('hex')
  return path.join(dir, `.${base}.tmp-${process.pid}-${Date.now().toString(36)}-${nonce}`)
}

/** Atomically write bytes to `fileAbs` (temporary sibling + rename). */
async function writeBytesAtomic(fileAbs, buffer) {
  await ensureDir(path.dirname(fileAbs))
  const temp = tempNameFor(fileAbs)
  try {
    await fs.writeFile(temp, buffer)
    await fs.rename(temp, fileAbs)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
  return buffer.length
}

/** Atomically write UTF-8 text. */
async function writeTextAtomic(fileAbs, text) {
  return writeBytesAtomic(fileAbs, Buffer.from(String(text), 'utf8'))
}

/** Atomically write pretty JSON. */
async function writeJsonAtomic(fileAbs, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  await writeTextAtomic(fileAbs, text)
  return text.length
}

/** Read JSON, returning `fallback` for a missing or unreadable file. */
async function readJson(fileAbs, fallback = null) {
  try {
    const text = await fs.readFile(fileAbs, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** Read JSON and fail loudly: used where a silent fallback would lose data. */
async function readJsonStrict(fileAbs, label = 'JSON 文件') {
  let text
  try {
    text = await fs.readFile(fileAbs, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    const { corrupt } = require('./errors')
    throw corrupt(`${label}不是合法 JSON：${fileAbs}`, 'wps-sync/json-invalid')
  }
}

/**
 * Copy a file atomically (used by the workspace mirror).
 *
 * Deliberately does NOT use `fs.copyFile`. On Windows, `CopyFileW` handles a
 * cloud placeholder (WPS 云盘 / OneDrive offline file) badly: it can reject with
 * `{ code: 'UNKNOWN', errno: -4094, syscall: 'copyfile' }` and — worse — it can
 * hang without ever settling, which wedges the serial sync queue behind one
 * file. The file API path (`readFile`, which hydrates the placeholder) is the
 * behaviour the cloud filter drivers actually support, so mirroring always reads
 * the bytes and writes them into the same temporary sibling before the rename.
 * `sink.copyIn` bounds this per file, so a pathological source cannot block the
 * queue forever.
 *
 * @param {string} sourceAbs
 * @param {string} targetAbs
 * @param {{timeoutMs?: number}} [options]
 */
async function copyFileAtomic(sourceAbs, targetAbs, options = {}) {
  await ensureDir(path.dirname(targetAbs))
  const temp = tempNameFor(targetAbs)
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 0
  // Set by the timeout race: the abandoned work must not rename into place later.
  let abandoned = false
  let timer = null
  const work = (async () => {
    const buffer = await fs.readFile(sourceAbs)
    if (abandoned) return null
    await fs.writeFile(temp, buffer)
    if (abandoned) return null
    await fs.rename(temp, targetAbs)
    return buffer.length
  })()
  try {
    if (timeoutMs) {
      work.catch(() => {})
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          abandoned = true
          reject(
            Object.assign(new Error(`复制文件超时（${timeoutMs}ms）：${sourceAbs}`), {
              code: 'wps-sync/copy-timeout',
              status: 504,
            }),
          )
        }, timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
      })
      await Promise.race([work, timeout])
    } else {
      await work
    }
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readFileOrNull(fileAbs) {
  try {
    return await fs.readFile(fileAbs)
  } catch {
    return null
  }
}

async function removeTree(targetAbs) {
  await fs.rm(targetAbs, { recursive: true, force: true })
}

/** List directory entries, or `[]` when the directory does not exist. */
async function listDir(dirAbs) {
  try {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true })
    return entries
  } catch {
    return []
  }
}

module.exports = {
  ensureDir,
  pathExists,
  isDirectory,
  writeBytesAtomic,
  writeTextAtomic,
  writeJsonAtomic,
  readJson,
  readJsonStrict,
  copyFileAtomic,
  readFileOrNull,
  removeTree,
  listDir,
}