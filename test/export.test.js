'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')

const { exportSession } = require('../lib/export-session')
const { exportTasks } = require('../lib/export-tasks')
const { exportWorkspace } = require('../lib/export-workspace')
const { readDeviceManifest } = require('../lib/manifest')
const { itemKey } = require('../lib/store')
const {
  makeArchive,
  makeStore,
  makeConfig,
  tempDir,
  writeFile,
  fakeSessionQuery,
  sessionSnapshot,
} = require('./helpers')

const NOW = () => Date.parse('2026-01-02T03:04:05.000Z')

test('session export writes session.jsonl, transcript.md and meta.json, then skips when unchanged', async () => {
  const { sink, syncRoot } = await makeArchive()
  const store = await makeStore(path.join(syncRoot, 'state'))
  const snapshot = sessionSnapshot('sess-1')
  const sessionQuery = fakeSessionQuery(snapshot, '季度报告')

  const first = await exportSession({
    sink,
    store,
    device: store.device,
    sessionQuery,
    sessionId: 'sess-1',
    now: NOW,
  })

  assert.equal(first.status, 'uploaded')
  assert.equal(first.eventCount, 3)
  assert.ok(first.dir.startsWith(`conversations/${store.device.id}/`), first.dir)
  assert.ok(first.dir.endsWith('-sess-1'), first.dir)

  const jsonl = await sink.read(`${first.dir}/session.jsonl`)
  const lines = jsonl.toString('utf8').trimEnd().split('\n')
  assert.equal(lines.length, 4, 'header line plus three events')
  const header = JSON.parse(lines[0])
  assert.equal(header.type, 'session')
  assert.equal(header.id, 'sess-1')
  assert.equal(JSON.parse(lines[1]).type, 'user/message')

  const transcript = (await sink.read(`${first.dir}/transcript.md`)).toString('utf8')
  assert.match(transcript, /# 季度报告/)
  assert.match(transcript, /把这份报告同步到 WPS。/)
  assert.match(transcript, /已经写入 DSH-Sync。/)
  assert.ok(transcript.endsWith('\n') && !transcript.endsWith('\n\n'), 'exactly one trailing newline')

  const meta = JSON.parse((await sink.read(`${first.dir}/meta.json`)).toString('utf8'))
  assert.equal(meta.kind, 'session')
  assert.equal(meta.eventCount, 3)
  assert.equal(meta.files.length, 2)

  const deviceDoc = await readDeviceManifest(sink, store.device)
  assert.ok(deviceDoc.items['session/sess-1'])
  assert.equal(deviceDoc.items['session/sess-1'].hash, first.hash)

  const second = await exportSession({
    sink,
    store,
    device: store.device,
    sessionQuery,
    sessionId: 'sess-1',
    now: NOW,
  })
  assert.equal(second.status, 'unchanged')

  const forced = await exportSession({
    sink,
    store,
    device: store.device,
    sessionQuery,
    sessionId: 'sess-1',
    force: true,
    now: NOW,
  })
  assert.equal(forced.status, 'uploaded')
})

test('session export refuses to run without a session query service', async () => {
  const { sink, syncRoot } = await makeArchive()
  const store = await makeStore(path.join(syncRoot, 'state'))
  await assert.rejects(
    () => exportSession({ sink, store, device: store.device, sessionQuery: null, sessionId: 'x', now: NOW }),
    (error) => error.code === 'wps-sync/no-session-query',
  )
})

test('tasks export writes scheduled-tasks.json with the catalog payload', async () => {
  const { sink, syncRoot } = await makeArchive()
  const store = await makeStore(path.join(syncRoot, 'state'))
  const schedule = {
    async catalog() {
      return [
        { id: 'task-1', title: '每日报告', kind: 'daily', scheduledAt: '2026-01-03T01:00:00.000Z', status: 'active', target: 'new_once' },
        { id: 'task-2', title: '周报', kind: 'weekly', scheduledAt: '2026-01-05T01:00:00.000Z', status: 'paused' },
      ]
    },
    async history({ id, limit }) {
      assert.equal(limit, 50)
      return id === 'task-1' ? [{ at: '2026-01-01T01:00:00.000Z', sessionId: 'sess-1' }] : []
    },
  }

  const result = await exportTasks({
    sink,
    store,
    device: store.device,
    schedule,
    config: makeConfig(),
    now: NOW,
  })
  assert.equal(result.status, 'uploaded')
  assert.equal(result.taskCount, 2)
  assert.equal(result.dir, `tasks/${store.device.id}`)

  const doc = JSON.parse((await sink.read(`${result.dir}/scheduled-tasks.json`)).toString('utf8'))
  assert.equal(doc.schemaVersion, 1)
  assert.equal(doc.taskCount, 2)
  assert.equal(doc.tasks[0].id, 'task-1')
  assert.equal(doc.tasks[0].history.length, 1)
  assert.equal(doc.device.id, store.device.id)

  const again = await exportTasks({ sink, store, device: store.device, schedule, config: makeConfig(), now: NOW })
  assert.equal(again.status, 'unchanged')

  const changed = await exportTasks({
    sink,
    store,
    device: store.device,
    config: makeConfig(),
    now: NOW,
    schedule: {
      async catalog() {
        return [{ id: 'task-3', title: '新任务', kind: 'every', scheduledAt: '2026-01-03T01:00:00.000Z' }]
      },
    },
  })
  assert.equal(changed.status, 'uploaded')
  assert.equal(changed.taskCount, 1)

  const deviceDoc = await readDeviceManifest(sink, store.device)
  assert.ok(deviceDoc.items['tasks/global'])
  assert.equal(store.getItem(itemKey('tasks', 'global')).lastResult, 'uploaded')
})

test('workspace export mirrors files, honours excludes, skips big files and is incremental', async () => {
  const { sink, syncRoot } = await makeArchive()
  const store = await makeStore(path.join(syncRoot, 'state'))
  const root = await tempDir('wps-ws-')
  await writeFile(path.join(root, 'a.txt'), 'alpha')
  await writeFile(path.join(root, 'sub', 'b.txt'), 'beta')
  await writeFile(path.join(root, 'node_modules', 'x.js'), 'ignored')
  await writeFile(path.join(root, 'debug.log'), 'ignored')
  await fs.writeFile(path.join(root, 'big.bin'), Buffer.alloc(1024 * 1024 + 10))

  const workspace = { id: 'ws-1', title: '演示 工作区', path: root }
  const config = makeConfig({ maxFileSizeMB: 1 })

  const first = await exportWorkspace({ sink, store, device: store.device, workspace, config, syncRoot, now: NOW })
  assert.equal(first.status, 'uploaded')
  assert.equal(first.fileCount, 2, 'only a.txt and sub/b.txt are mirrored')
  assert.ok(first.dir.startsWith(`workspaces/${store.device.id}/`))
  assert.ok(first.dir.endsWith('-ws-1'))

  assert.ok(await sink.exists(`${first.dir}/files/a.txt`))
  assert.ok(await sink.exists(`${first.dir}/files/sub/b.txt`))
  assert.equal(await sink.exists(`${first.dir}/files/node_modules/x.js`), false)
  assert.equal(await sink.exists(`${first.dir}/files/debug.log`), false)
  assert.equal(await sink.exists(`${first.dir}/files/big.bin`), false)

  const second = await exportWorkspace({ sink, store, device: store.device, workspace, config, syncRoot, now: NOW })
  assert.equal(second.status, 'unchanged')
  assert.equal(second.fileCount, 2)

  await writeFile(path.join(root, 'a.txt'), 'alpha changed')
  const third = await exportWorkspace({ sink, store, device: store.device, workspace, config, syncRoot, now: NOW })
  assert.equal(third.status, 'uploaded')
  assert.equal(third.copied, 1)
  assert.equal((await sink.read(`${first.dir}/files/a.txt`)).toString('utf8'), 'alpha changed')

  // a file removed at the source is pruned from the mirror
  await fs.rm(path.join(root, 'sub', 'b.txt'))
  const fourth = await exportWorkspace({ sink, store, device: store.device, workspace, config, syncRoot, now: NOW })
  assert.equal(fourth.status, 'uploaded')
  assert.equal(await sink.exists(`${first.dir}/files/sub/b.txt`), false)
})

test('a workspace inside the sync root is refused to prevent recursive mirroring', async () => {
  const { sink, syncRoot } = await makeArchive()
  const store = await makeStore(path.join(syncRoot, 'state'))
  const inside = path.join(syncRoot, 'project')
  await writeFile(path.join(inside, 'x.txt'), 'x')
  await assert.rejects(
    () =>
      exportWorkspace({
        sink,
        store,
        device: store.device,
        workspace: { id: 'ws-2', title: 'inside', path: inside },
        config: makeConfig(),
        syncRoot,
        now: NOW,
      }),
    (error) => error.code === 'wps-sync/workspace-inside-sync-root',
  )
})