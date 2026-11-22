'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { StateStore, itemKey, parseItemKey, createDevice } = require('../lib/store')
const { SyncQueue } = require('../lib/queue')
const { Debouncer } = require('../lib/timer')
const { tempDir } = require('./helpers')

test('itemKey and parseItemKey are inverses for the three kinds', () => {
  assert.equal(itemKey('session', 's1'), 'session:s1')
  assert.equal(itemKey('workspace', 'w1'), 'workspace:w1')
  assert.equal(itemKey('tasks', 'anything'), 'tasks:global')
  assert.deepEqual(parseItemKey('session:s1'), { kind: 'session', id: 's1' })
  assert.deepEqual(parseItemKey('tasks:global'), { kind: 'tasks', id: 'global' })
})

test('createDevice mints a unique uuid and a display name', () => {
  const one = createDevice('my-laptop')
  const two = createDevice('my-laptop')
  assert.notEqual(one.id, two.id)
  assert.equal(one.name, 'my-laptop')
  assert.ok(one.platform.length > 0)
})

test('state persists the device id, items and defaults across reloads', async () => {
  const dir = await tempDir('wps-state-')
  const store = new StateStore({ dir, deviceName: 'laptop' })
  await store.load()
  const deviceId = store.device.id
  assert.equal(store.data.defaults.auto, true)

  const item = store.ensureItem('session', 's1', { title: '演示' })
  assert.equal(item.auto, true)
  item.auto = false
  store.recordResult('session', 's1', { status: 'uploaded', hash: 'abc', dir: 'conversations/x' })
  store.pushError(new Error('boom'), { key: 'session:s1' })
  store.addImport({ importId: 'i1', kind: 'session', id: 's1' })
  await store.save()

  const reloaded = new StateStore({ dir, deviceName: 'laptop' })
  await reloaded.load()
  assert.equal(reloaded.device.id, deviceId, 'device id is stable')
  assert.equal(reloaded.getItem('session:s1').auto, false)
  assert.equal(reloaded.getItem('session:s1').lastResult, 'uploaded')
  assert.equal(reloaded.getItem('session:s1').lastHash, 'abc')
  assert.equal(reloaded.findImport('i1').importId, 'i1')
  assert.equal(reloaded.data.errors.length, 1)
})

test('state capping keeps the newest imports and errors', async () => {
  const dir = await tempDir('wps-state2-')
  const store = new StateStore({ dir, deviceName: 'x' })
  await store.load()
  for (let index = 0; index < 60; index += 1) store.pushError(new Error(`e${index}`))
  assert.ok(store.data.errors.length <= 50)
  assert.equal(store.data.errors.at(-1).message, 'e59')
})

test('queue dedupes the same key while running and runs different keys serially', async () => {
  const queue = new SyncQueue({})
  const order = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })

  const first = queue.push({ kind: 'session', key: 'session:s1', label: 'one' }, async () => {
    order.push('start-1')
    await gate
    order.push('end-1')
    return 'one'
  })
  const duplicate = queue.push({ kind: 'session', key: 'session:s1', label: 'dup' }, async () => {
    order.push('should-not-run')
    return 'dup'
  })
  const other = queue.push({ kind: 'tasks', key: 'tasks:global', label: 'two' }, async () => {
    order.push('start-2')
    return 'two'
  })

  assert.equal(queue.pending, 2, 'the duplicate shares the running job')
  release()
  assert.deepEqual(await Promise.all([first, duplicate, other]), ['one', 'one', 'two'])
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2'], 'no overlap and no duplicate run')
  await queue.idle()
  assert.equal(queue.pending, 0)
  const jobs = queue.list()
  assert.ok(jobs.every((job) => job.state === 'done'))
})

test('queue records a failure without breaking later jobs', async () => {
  const queue = new SyncQueue({})
  const failed = queue.push({ kind: 'session', key: 'session:a' }, async () => {
    throw new Error('nope')
  })
  await assert.rejects(() => failed, /nope/)
  const ok = queue.push({ kind: 'session', key: 'session:b' }, async () => 'fine')
  assert.equal(await ok, 'fine')
  const jobs = queue.list()
  assert.equal(jobs.find((job) => job.key === 'session:a').state, 'error')
})

test('debouncer collapses pushes per key and cancels on demand', async () => {
  const calls = []
  const debouncer = new Debouncer({ delayMs: 5 })
  debouncer.push('a', () => calls.push('a1'))
  debouncer.push('a', () => calls.push('a2'))
  debouncer.push('b', () => calls.push('b1'))
  assert.equal(debouncer.size, 2)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(calls.sort(), ['a2', 'b1'], 'only the last callback per key runs')
  assert.equal(debouncer.size, 0)

  debouncer.push('c', () => calls.push('c1'))
  debouncer.cancelAll()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(calls.includes('c1'), false)
})