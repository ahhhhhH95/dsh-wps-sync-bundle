'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  assertSafeRelative,
  assertSafeSegment,
  isInside,
  isSameOrInside,
  resolveInside,
  relativePosix,
  toPosix,
  slugify,
  nameWithId,
  sanitizeId,
  isAbsoluteLike,
} = require('../lib/paths')
const { validateRestoreTarget } = require('../lib/sync-root')

test('assertSafeRelative accepts ordinary relative paths', () => {
  assert.equal(assertSafeRelative('a/b.txt'), 'a/b.txt')
  assert.equal(assertSafeRelative('dir\\sub\\file.md'), 'dir/sub/file.md')
  assert.equal(assertSafeRelative('中文/文件.md'), '中文/文件.md')
  assert.equal(assertSafeRelative('a//b.txt'), 'a/b.txt')
  // a '.' segment is rejected rather than silently collapsed
  assert.throws(() => assertSafeRelative('./x/y'), /./)
})

test('assertSafeRelative rejects traversal, absolute, drive and UNC paths', () => {
  const bad = [
    '',
    '.',
    '..',
    '../etc/passwd',
    'a/../../b',
    'a/..',
    '/etc/passwd',
    '\\\\server\\share\\file',
    '//server/share/file',
    'C:\\Windows\\system32',
    'c:/windows',
    'file\u0000name',
    'a/b\u0001c',
  ]
  for (const value of bad) {
    assert.throws(() => assertSafeRelative(value), /./, `expected rejection for ${JSON.stringify(value)}`)
  }
})

test('assertSafeRelative rejects Windows device names, trailing dots and long segments', () => {
  for (const value of ['con', 'dir/PRN.txt', 'aux.md', 'com1', 'lpt9/x', 'name.', 'name ', 'a'.repeat(200)]) {
    assert.throws(() => assertSafeRelative(value), /./, `expected rejection for ${JSON.stringify(value)}`)
  }
})

test('assertSafeSegment validates a single component', () => {
  assert.equal(assertSafeSegment('note.md'), 'note.md')
  assert.throws(() => assertSafeSegment('a/b'), /./)
  assert.throws(() => assertSafeSegment('..'), /./)
})

test('isAbsoluteLike recognises every absolute-looking form', () => {
  for (const value of ['/x', '\\x', 'C:/x', 'c:\\x', '\\\\srv\\share', '//srv/share']) {
    assert.equal(isAbsoluteLike(value), true, value)
  }
  assert.equal(isAbsoluteLike('a/b'), false)
})

test('containment helpers distinguish inside from same', () => {
  const root = path.resolve('/tmp/root')
  assert.equal(isInside(root, path.join(root, 'sub', 'file.txt')), true)
  assert.equal(isInside(root, root), false)
  assert.equal(isSameOrInside(root, root), true)
  assert.equal(isSameOrInside(root, path.join(root, 'sub')), true)
  assert.equal(isSameOrInside(root, path.resolve('/tmp/other')), false)
  // a sibling whose name merely starts with the root's name is not inside it
  assert.equal(isSameOrInside(root, `${root}-sibling`), false)
})

test('resolveInside re-checks containment after resolution', () => {
  const root = path.resolve('/tmp/root')
  assert.equal(resolveInside(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'))
  assert.throws(() => resolveInside(root, '../escape'), /./)
  assert.throws(() => resolveInside(root, '/abs'), /./)
})

test('toPosix and relativePosix always emit forward slashes', () => {
  assert.equal(toPosix('a\\b\\c'), 'a/b/c')
  assert.equal(relativePosix(path.resolve('/tmp/root'), path.resolve('/tmp/root/a/b.txt')), 'a/b.txt')
})

test('slugify keeps CJK, preserves ASCII case and always leaves a usable core', () => {
  assert.equal(slugify('Hello World!'), 'Hello-World')
  assert.equal(slugify('我的 报告'), '我的-报告')
  assert.equal(slugify('   '), 'item')
  assert.ok(slugify('x'.repeat(200)).length <= 48)
})

test('nameWithId always appends the id', () => {
  const value = nameWithId('季度 报告', 'sess-1', 'session')
  assert.ok(value.endsWith('-sess-1'), value)
  assert.ok(!value.includes(' '), value)
})

test('sanitizeId strips separators and unsafe characters', () => {
  assert.equal(sanitizeId('a/b\\c:d'), 'a-b-c-d')
  assert.equal(sanitizeId(''), 'item')
})

test('validateRestoreTarget refuses a target equal to or inside the sync root', async () => {
  const syncRoot = path.resolve('/tmp/wps-root')
  await assert.rejects(() => validateRestoreTarget(syncRoot, syncRoot), (error) => error.code === 'wps-sync/target-in-sync-root')
  await assert.rejects(
    () => validateRestoreTarget(path.join(syncRoot, 'inner'), syncRoot),
    (error) => error.code === 'wps-sync/target-in-sync-root',
  )
  assert.equal(await validateRestoreTarget(path.resolve('/tmp/restore-target'), syncRoot), path.resolve('/tmp/restore-target'))
})

test('validateRestoreTarget requires an absolute existing-syntax path', async () => {
  await assert.rejects(() => validateRestoreTarget('', '/tmp/root'), /./)
  await assert.rejects(() => validateRestoreTarget('relative/dir', '/tmp/root'), /./)
})