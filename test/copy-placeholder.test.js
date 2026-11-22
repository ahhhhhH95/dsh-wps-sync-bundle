'use strict'

/**
 * Cloud placeholders and `fs.copyFile`.
 *
 * WPS 云盘 (like OneDrive) may keep a file as an offline placeholder. On Windows
 * `CopyFileW` handles that badly: it rejected with
 *   { code: 'UNKNOWN', errno: -4094, syscall: 'copyfile' }
 * and, in a later live run, it never settled at all — one wedged copy would hold
 * the serial sync queue forever while every later session stayed unexported.
 *
 * The fix is structural, not a fallback: mirroring never calls `fs.copyFile`. It
 * always reads the bytes (which is what hydrates a placeholder) and writes them
 * into a temporary sibling before the rename, bounded by a per-file timeout.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const { copyFileAtomic } = require('../lib/json-file')
const { LocalDirSink } = require('../lib/sink')

const PLACEHOLDER = Object.assign(new Error('UNKNOWN: unknown error, copyfile'), {
  code: 'UNKNOWN',
  errno: -4094,
  syscall: 'copyfile',
})

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** Run `fn` with `fs.promises.copyFile` replaced, then always restore it. */
async function withCopyFile(replacement, fn) {
  const original = fs.copyFile
  fs.copyFile = replacement
  try {
    return await fn()
  } finally {
    fs.copyFile = original
  }
}

/** Run `fn` with `fs.promises.readFile` replaced (the original is passed in). */
async function withReadFile(replacement, fn) {
  const original = fs.readFile
  fs.readFile = (file, ...rest) => replacement(original, file, ...rest)
  try {
    return await fn()
  } finally {
    fs.readFile = original
  }
}

test('mirroring a placeholder-shaped source never calls CopyFileW', async () => {
  const dir = await tempDir('wps-sync-copy-')
  const source = path.join(dir, 'extract.mjs')
  const target = path.join(dir, 'mirror', 'extract.mjs')
  const bytes = Buffer.from('export const answer = 42\n', 'utf8')
  await fs.writeFile(source, bytes)
  let calls = 0
  await withCopyFile(
    () => {
      calls += 1
      throw PLACEHOLDER
    },
    async () => {
      await copyFileAtomic(source, target)
    },
  )
  assert.equal(calls, 0, 'fs.copyFile must not be used by the mirror')
  assert.equal((await fs.readFile(target)).toString('utf8'), bytes.toString('utf8'))
})

test('a copyFile that never settles cannot block the mirror', async () => {
  const dir = await tempDir('wps-sync-copy-')
  const source = path.join(dir, 'a.txt')
  const target = path.join(dir, 'b.txt')
  await fs.writeFile(source, 'hello')
  await withCopyFile(
    () => new Promise(() => {}),
    async () => {
      await copyFileAtomic(source, target)
    },
  )
  assert.equal(await fs.readFile(target, 'utf8'), 'hello')
})

test('copyIn returns the real hash and leaves no temporary sibling', async () => {
  const dir = await tempDir('wps-sync-copy-')
  const syncRoot = path.join(dir, 'WPS Cloud Files')
  const source = path.join(dir, 'note.md')
  const text = '# 报告\n\n内容\n'
  await fs.writeFile(source, text, 'utf8')
  const sink = new LocalDirSink({ rootDir: path.join(syncRoot, 'DSH-Sync') })
  const result = await sink.copyIn('workspaces/dev-1/ws/files/note.md', source)
  assert.equal(result.path, 'workspaces/dev-1/ws/files/note.md')
  assert.equal(result.hash, crypto.createHash('sha256').update(Buffer.from(text)).digest('hex'))
  assert.equal(result.bytes, Buffer.byteLength(text))
  const absolute = sink.resolve(result.path, '镜像路径')
  assert.equal(await fs.readFile(absolute, 'utf8'), text)
  const siblings = await fs.readdir(path.dirname(absolute))
  assert.deepEqual(siblings, ['note.md'], 'no .tmp sibling may survive the rename')
})

test('a source that never hydrates fails with a timeout instead of hanging', async () => {
  const dir = await tempDir('wps-sync-copy-')
  const source = path.join(dir, 'offline.bin')
  const target = path.join(dir, 'mirror', 'offline.bin')
  await fs.writeFile(source, 'x')
  await withReadFile(
    (original, file, ...rest) =>
      String(file) === source ? new Promise(() => {}) : original.call(fs, file, ...rest),
    async () => {
      await assert.rejects(
        () => copyFileAtomic(source, target, { timeoutMs: 50 }),
        (error) => {
          assert.equal(error.code, 'wps-sync/copy-timeout')
          assert.match(error.message, /复制文件超时/)
          return true
        },
      )
    },
  )
  await assert.rejects(() => fs.stat(target), /ENOENT/)
})

test('a missing source still surfaces its own error', async () => {
  const dir = await tempDir('wps-sync-copy-')
  await assert.rejects(
    () => copyFileAtomic(path.join(dir, 'nope.txt'), path.join(dir, 'out', 'nope.txt')),
    (error) => {
      assert.equal(error.code, 'ENOENT')
      return true
    },
  )
})