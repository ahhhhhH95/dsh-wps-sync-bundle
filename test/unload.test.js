'use strict'

/**
 * Unload semantics and the live-job view.
 *
 * Two live-host problems are pinned here:
 *
 * 1. Reloading the bundle while the serial queue is busy used to leave queued
 *    work behind that the *old* engine instance would still start, writing into
 *    the archive next to the new instance. `queue.stop()` must refuse new work
 *    and reject everything still queued.
 * 2. `status.queue.jobs` used to be `queue.list().slice(-20)`, which cut exactly
 *    the oldest entries — the running/queued head. A wedged job was therefore
 *    invisible in the UI. Live work is now never truncated.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { SyncQueue } = require('../lib/queue')
const { SyncEngine } = require('../lib/engine')
const { makeArchive, tempDir, fakeSessionQuery, sessionSnapshot, writeFile, NOW } = require('./helpers')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('stop() cancels queued jobs and refuses new ones', async () => {
  const queue = new SyncQueue({ now: NOW, createId: () => 'job-1' })
  const gate = deferred()
  const ran = []
  const first = queue.push({ kind: 'session', key: 'session:a', label: 'a' }, async () => {
    ran.push('a')
    await gate.promise
    return 'a-done'
  })
  const second = queue.push({ kind: 'session', key: 'session:b', label: 'b' }, async () => {
    ran.push('b')
    return 'b-done'
  })
  // Let the first job start before stopping.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(queue.pending, 2)

  const cancelled = queue.stop()
  assert.equal(cancelled, 1, 'only the queued job is cancellable')
  await assert.rejects(() => second, (error) => {
    assert.equal(error.code, 'wps-sync/queue-stopped')
    return true
  })
  assert.equal(queue.pending, 1, 'the running job is still tracked')
  await assert.rejects(() => queue.push({ kind: 'session', key: 'session:c' }, async () => 'c'), (error) => {
    assert.equal(error.code, 'wps-sync/queue-stopped')
    return true
  })

  gate.resolve()
  assert.equal(await first, 'a-done', 'a job that already started is allowed to finish')
  assert.deepEqual(ran, ['a'], 'the cancelled job never runs')
  const states = queue.list().map((job) => job.state)
  assert.ok(states.includes('cancelled'))
  assert.ok(states.includes('done'))
})

test('status keeps every live job even when the history is longer than the cap', async () => {
  const archive = await makeArchive()
  const stateDir = path.join(archive.base, 'state')
  const engine = new SyncEngine({
    config: { syncRootDir: archive.syncRoot, autoSync: true, debounceMs: 0, workspaceScanIntervalSec: 0 },
    stateDir,
    services: { sessionQuery: fakeSessionQuery(sessionSnapshot('sess-1'), '队列测试') },
    now: NOW,
  })
  await engine.init()
  try {
    for (let index = 0; index < 25; index += 1) {
      await engine.queue.push({ kind: 'session', key: `session:old-${index}` }, async () => 'ok')
    }
    const gate = deferred()
    engine.queue.push({ kind: 'session', key: 'session:wedge-1' }, () => gate.promise)
    engine.queue.push({ kind: 'session', key: 'session:wedge-2' }, async () => 'ok')
    await new Promise((resolve) => setImmediate(resolve))

    const status = await engine.status({ fresh: true })
    const keys = status.queue.jobs.map((job) => job.key)
    assert.ok(keys.includes('session:wedge-1'), 'a running job must be visible')
    assert.ok(keys.includes('session:wedge-2'), 'a queued job must be visible')
    assert.equal(status.queue.jobs[0].state, 'running', 'live jobs come first')
    assert.ok(status.queue.jobs.length <= 20)
    assert.equal(status.queue.pending, 2)
    gate.resolve()
    await engine.queue.idle()
  } finally {
    await engine.stop()
  }
})

test('engine.stop() cancels queued work and stops the scan timer', async () => {
  const archive = await makeArchive()
  const workspaceRoot = await tempDir('wps-unload-ws-')
  await writeFile(path.join(workspaceRoot, 'a.txt'), 'a')
  const stateDir = path.join(archive.base, 'state')
  const timers = []
  const engine = new SyncEngine({
    config: { syncRootDir: archive.syncRoot, autoSync: true, debounceMs: 0, workspaceScanIntervalSec: 60 },
    stateDir,
    services: {
      sessionQuery: fakeSessionQuery(sessionSnapshot('sess-1'), '卸载测试'),
      workspaceRegistry: { list: () => [{ id: 'ws-1', title: '工作区', path: workspaceRoot, updatedAt: NOW() }] },
      setInterval: (callback, delay) => {
        timers.push({ callback, delay })
        return () => {
          timers.pop()
        }
      },
    },
    now: NOW,
  })
  await engine.init()
  await engine.start()
  await engine.queue.idle()
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delay, 60000)

  const gate = deferred()
  engine.queue.push({ kind: 'session', key: 'session:slow' }, () => gate.promise)
  const queued = engine.queue.push({ kind: 'session', key: 'session:later' }, async () => 'ok')
  // Let the first job enter the running state: only *queued* work is cancellable.
  await new Promise((resolve) => setImmediate(resolve))
  await engine.stop()

  assert.equal(timers.length, 0, 'the scan timer is cleared on unload')
  assert.equal(engine.cancelledOnStop, 1)
  await assert.rejects(() => queued, (error) => {
    assert.equal(error.code, 'wps-sync/queue-stopped')
    return true
  })
  // Background triggers must not enqueue after unload.
  engine.handleTurnEnd('sess-1')
  assert.equal(engine.scanWorkspaces(), 0)
  gate.resolve()
  await engine.queue.idle()

  const status = await engine.status({ fresh: true })
  assert.equal(status.queue.stopped, true)
  assert.ok(status.queue.jobs.some((job) => job.state === 'cancelled'))
})

test('a cancelled job never writes into the archive', async () => {
  const archive = await makeArchive()
  const stateDir = path.join(archive.base, 'state')
  const engine = new SyncEngine({
    config: { syncRootDir: archive.syncRoot, autoSync: true, debounceMs: 0, workspaceScanIntervalSec: 0 },
    stateDir,
    services: { sessionQuery: fakeSessionQuery(sessionSnapshot('sess-1'), '取消测试') },
    now: NOW,
  })
  await engine.init()
  try {
    const gate = deferred()
    engine.queue.push({ kind: 'session', key: 'session:blocker' }, () => gate.promise)
    const pendingExport = engine.uploadSession('sess-1')
    await new Promise((resolve) => setImmediate(resolve))
    engine.queue.stop()
    await assert.rejects(() => pendingExport, /同步已停止/)
    gate.resolve()
    await engine.queue.idle()
    assert.equal(await archive.sink.exists('conversations'), false, 'no partial archive may be written')
  } finally {
    await engine.stop()
  }
})