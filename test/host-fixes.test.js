'use strict'

/**
 * Regression tests for the review round: content-stable hashes, real Host
 * observation shapes, the auto default, the fetch contract, remote manifest
 * hardening, link escapes and state durability.
 *
 * Every test runs offline against temp directories — no real session log, no
 * scheduler and no WPS folder is touched.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')

const { SyncEngine } = require('../lib/engine')
const { StateStore } = require('../lib/store')
const { LocalDirSink } = require('../lib/sink')
const { createBridge } = require('../lib/bridge')
const { renderTranscript } = require('../lib/transcript')
const { exportSession } = require('../lib/export-session')
const { exportTasks } = require('../lib/export-tasks')
const { exportWorkspace, walkSource } = require('../lib/export-workspace')
const { pullRemote, listRemote } = require('../lib/remote')
const { restoreWorkspace } = require('../lib/restore')
const { readJsonStrict, writeJsonAtomic, ensureDir } = require('../lib/json-file')
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

const NOW = () => Date.parse('2026-03-04T05:06:07.000Z')
const LATER = () => Date.parse('2026-09-09T09:09:09.000Z')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* --------------------------------------------------------------- transcript */

test("a 'completed' turn is a success and adds no warning", () => {
  const snapshot = sessionSnapshot('sess-ok')
  snapshot.events[2].data.reason = { kind: 'completed' }
  const markdown = renderTranscript({ header: snapshot.session, events: snapshot.events, title: 'ok' })
  assert.equal(markdown.includes('⚠️'), false)

  const failed = sessionSnapshot('sess-bad')
  failed.events[2].data.reason = { kind: 'error', error: { message: 'boom' } }
  const failedMarkdown = renderTranscript({ header: failed.session, events: failed.events, title: 'bad' })
  assert.equal(failedMarkdown.includes('⚠️ 回合 1 结束：error — boom'), true)
})

/* ------------------------------------------------------------ content hashes */

test('session and tasks exports are unchanged across clock changes', async () => {
  const archive = await makeArchive()
  const store = await makeStore(path.join(archive.base, 'state'))
  const sessionQuery = fakeSessionQuery(sessionSnapshot('sess-1'), '季度报告')
  const schedule = {
    async catalog() {
      return [{ id: 'task-1', title: '每夜任务', kind: 'daily', scheduledAt: '2026-03-05T01:00:00.000Z' }]
    },
    async history() {
      return [{ id: 'delivery-1', status: 'delivered' }]
    },
  }
  const config = makeConfig()

  const session1 = await exportSession({ sink: archive.sink, store, device: store.device, sessionQuery, sessionId: 'sess-1', now: NOW })
  const tasks1 = await exportTasks({ sink: archive.sink, store, device: store.device, schedule, config, now: NOW })
  assert.equal(session1.status, 'uploaded')
  assert.equal(tasks1.status, 'uploaded')

  // Hours later, with unchanged content, nothing is re-uploaded and the hash
  // (which is also the advertised version) is identical.
  const session2 = await exportSession({ sink: archive.sink, store, device: store.device, sessionQuery, sessionId: 'sess-1', now: LATER })
  const tasks2 = await exportTasks({ sink: archive.sink, store, device: store.device, schedule, config, now: LATER })
  assert.equal(session2.status, 'unchanged')
  assert.equal(tasks2.status, 'unchanged')
  assert.equal(session2.hash, session1.hash)
  assert.equal(tasks2.hash, tasks1.hash)

  // The archive document itself must not carry the export timestamp.
  const tasksDoc = JSON.parse(await fs.readFile(path.join(archive.sink.rootDir, tasks1.dir, 'scheduled-tasks.json'), 'utf8'))
  assert.equal(Object.prototype.hasOwnProperty.call(tasksDoc, 'exportedAt'), false)
  const transcript = await fs.readFile(path.join(archive.sink.rootDir, session1.dir, 'transcript.md'), 'utf8')
  assert.equal(transcript.includes('导出时间'), false)

  // meta.json still records when the export happened.
  const meta = JSON.parse(await fs.readFile(path.join(archive.sink.rootDir, session1.dir, 'meta.json'), 'utf8'))
  assert.equal(meta.exportedAt, new Date(NOW()).toISOString())
})

test('every exporter advertises the content hash as its version', async () => {
  const archive = await makeArchive()
  const store = await makeStore(path.join(archive.base, 'state'))
  const workspaceRoot = await tempDir('wps-version-ws-')
  await writeFile(path.join(workspaceRoot, 'a.txt'), 'a')
  const config = makeConfig()

  const session = await exportSession({
    sink: archive.sink,
    store,
    device: store.device,
    sessionQuery: fakeSessionQuery(sessionSnapshot('sess-v'), 'v'),
    sessionId: 'sess-v',
    now: NOW,
  })
  const tasks = await exportTasks({
    sink: archive.sink,
    store,
    device: store.device,
    schedule: { async catalog() { return [] } },
    config,
    now: NOW,
  })
  const workspace = await exportWorkspace({
    sink: archive.sink,
    store,
    device: store.device,
    workspace: { id: 'ws-v', title: '版本工作区', path: workspaceRoot },
    config,
    syncRoot: archive.syncRoot,
    now: NOW,
  })

  const deviceManifest = JSON.parse(
    await fs.readFile(path.join(archive.sink.rootDir, 'devices', store.device.id, 'manifest.json'), 'utf8'),
  )
  assert.equal(deviceManifest.items['session/sess-v'].version, session.hash)
  assert.equal(deviceManifest.items['tasks/global'].version, tasks.hash)
  assert.equal(deviceManifest.items['workspace/ws-v'].version, workspace.hash)
})

/* --------------------------------------------------------- observation shape */

test('sessions titles come from the real fulfilled observation shape', async () => {
  const archive = await makeArchive()
  const stateDir = path.join(archive.base, 'state')
  const workspaceRoot = await tempDir('wps-title-ws-')
  const snapshot = sessionSnapshot('sess-real')
  const engine = new SyncEngine({
    config: { syncRootDir: archive.syncRoot, workspaceScanIntervalSec: 0, debounceMs: 0 },
    stateDir,
    services: {
      sessionQuery: {
        async readSession(id) {
          return { ...snapshot, session: { ...snapshot.session, id } }
        },
        async listSessions() {
          return [{ header: snapshot.session, live: true }]
        },
        async readTitleSnapshots(ids) {
          return ids.map((id) => ({
            sessionId: id,
            status: 'fulfilled',
            value: { session: snapshot.session, title: { title: '真实标题' } },
          }))
        },
        async readTitle() {
          return null
        },
      },
      workspaceRegistry: { list: () => [{ id: 'ws-1', title: 'w', path: workspaceRoot }] },
    },
    now: NOW,
  })
  await engine.init()
  await engine.start()
  try {
    const sessions = await engine.localSessions()
    assert.equal(sessions[0].title, '真实标题')

    const result = await engine.upload('session', 'sess-real')
    assert.equal(result.status, 'uploaded')
    assert.equal(result.title, '真实标题')
  } finally {
    await engine.stop()
  }
})

test('a rejected title observation never becomes a title', async () => {
  const archive = await makeArchive()
  const snapshot = sessionSnapshot('sess-rej')
  const engine = new SyncEngine({
    config: { syncRootDir: archive.syncRoot, workspaceScanIntervalSec: 0 },
    stateDir: path.join(archive.base, 'state'),
    services: {
      sessionQuery: {
        async readSession() {
          return snapshot
        },
        async listSessions() {
          return [{ header: snapshot.session, live: false }]
        },
        async readTitleSnapshots(ids) {
          return ids.map((id) => ({ sessionId: id, status: 'rejected', reason: 'nope' }))
        },
        async readTitle() {
          return null
        },
      },
      workspaceRegistry: { list: () => [] },
    },
    now: NOW,
  })
  await engine.init()
  await engine.start()
  try {
    const sessions = await engine.localSessions()
    assert.equal(sessions[0].title, '会话 sess-rej')
  } finally {
    await engine.stop()
  }
})

test('a snapshot that exposes `header` instead of `session` still works', async () => {
  const archive = await makeArchive()
  const store = await makeStore(path.join(archive.base, 'state'))
  const snapshot = sessionSnapshot('sess-hdr')
  const sessionQuery = {
    async readSession() {
      return { header: snapshot.session, events: snapshot.events }
    },
    async readTitle() {
      return null
    },
  }
  const result = await exportSession({
    sink: archive.sink,
    store,
    device: store.device,
    sessionQuery,
    sessionId: 'sess-hdr',
    now: NOW,
  })
  const lines = (await fs.readFile(path.join(archive.sink.rootDir, result.dir, 'session.jsonl'), 'utf8')).trim().split('\n')
  assert.equal(JSON.parse(lines[0]).id, 'sess-hdr')
  const meta = JSON.parse(await fs.readFile(path.join(archive.sink.rootDir, result.dir, 'meta.json'), 'utf8'))
  assert.equal(meta.session.cwd, 'C:/work/demo')
})

test('task history limit is clamped to the service maximum of 100', async () => {
  const archive = await makeArchive()
  const store = await makeStore(path.join(archive.base, 'state'))
  const seen = []
  const schedule = {
    async catalog() {
      return [{ id: 'task-1', title: 't', kind: 'daily' }]
    },
    async history(request) {
      seen.push(request.limit)
      return []
    },
  }
  await exportTasks({
    sink: archive.sink,
    store,
    device: store.device,
    schedule,
    config: makeConfig({ taskHistoryLimit: 500 }),
    now: NOW,
  })
  assert.deepEqual(seen, [100])
})

/* ------------------------------------------------------------------ autoSync */

test('autoSync:false stops every automatic export but keeps manual upload', async () => {
  const archive = await makeArchive()
  const workspaceRoot = await tempDir('wps-auto-ws-')
  await writeFile(path.join(workspaceRoot, 'a.txt'), 'a')
  let timers = 0
  const engine = new SyncEngine({
    config: { syncRootDir: archive.syncRoot, autoSync: false, debounceMs: 0, workspaceScanIntervalSec: 30 },
    stateDir: path.join(archive.base, 'state'),
    services: {
      sessionQuery: fakeSessionQuery(sessionSnapshot('sess-auto'), 'auto'),
      workspaceRegistry: { list: () => [{ id: 'ws-auto', title: 'w', path: workspaceRoot }] },
      schedule: { async catalog() { return [] } },
      // `workspaceScanIntervalSec: 30` would normally install a timer; with
      // autoSync off we still expect the timer (scan) but no automatic upload.
      setInterval: (callback, delay) => {
        timers += 1
        return () => {}
      },
    },
    now: NOW,
  })
  await engine.init()
  await engine.start()
  try {
    assert.equal(engine.store.data.defaults.auto, false)
    assert.equal(engine.isAuto('session', 'sess-auto'), false)
    assert.equal(engine.isAuto('tasks', 'tasks:global'), false)

    engine.handleTurnEnd('sess-auto')
    engine.handleScheduleChanged()
    engine.scanWorkspaces()
    await wait(40)
    assert.equal(engine.queue.pending, 0, 'no automatic job may be queued')

    // A manual upload still works.
    const manual = await engine.upload('session', 'sess-auto')
    assert.equal(manual.status, 'uploaded')
  } finally {
    await engine.stop()
  }
})

test('workspaceScanIntervalSec: 0 installs no timer at all', async () => {
  const archive = await makeArchive()
  let timers = 0
  const engine = new SyncEngine({
    config: { syncRootDir: archive.syncRoot, workspaceScanIntervalSec: 0 },
    stateDir: path.join(archive.base, 'state'),
    services: {
      sessionQuery: fakeSessionQuery(sessionSnapshot('sess-t'), 't'),
      workspaceRegistry: { list: () => [] },
      setInterval: () => {
        timers += 1
        return () => {}
      },
    },
    now: NOW,
  })
  await engine.init()
  await engine.start()
  try {
    assert.equal(timers, 0)
    assert.equal(engine.scanTimer, null)
  } finally {
    await engine.stop()
  }
})

/* ---------------------------------------------------------------- durability */

test('a corrupt state file is quarantined, not silently replaced', async () => {
  const dir = await tempDir('wps-state-')
  await ensureDir(dir)
  const file = path.join(dir, 'state.json')
  await fs.writeFile(file, '{ this is not json', 'utf8')
  const store = new StateStore({ dir, deviceName: 'broken' })
  const data = await store.load()
  // Recovery is explicit: the original bytes move aside and stay readable.
  assert.ok(data.stateRecovered, 'load must report the recovery')
  const backup = data.stateRecovered.from
  assert.equal(await fs.readFile(backup, 'utf8'), '{ this is not json')
  assert.equal(data.stateRecovered.code, 'wps-sync/json-invalid')
  // A fresh, valid document now exists in the original location.
  const replaced = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(replaced.version, 1)
  assert.ok(replaced.device.id)
})

test('one failed save does not poison later saves', async () => {
  const dir = await tempDir('wps-state-chain-')
  const store = new StateStore({ dir, deviceName: 'chain' })
  await store.load()
  // Make the target unwritable by replacing the directory with a file path
  // component that cannot be created.
  const blocker = path.join(dir, 'blocked')
  await fs.writeFile(blocker, 'x', 'utf8')
  store.dir = path.join(blocker, 'nested')

  await assert.rejects(() => store.save())
  store.dir = dir
  await store.save()
  const doc = await readJsonStrict(path.join(dir, 'state.json'), 'state')
  assert.equal(doc.device.id, store.device.id)
})

/* -------------------------------------------------------------------- remote */

async function publishSession(sink, store, sessionId = 'sess-r', title = '远端会话') {
  return exportSession({
    sink,
    store,
    device: store.device,
    sessionQuery: fakeSessionQuery(sessionSnapshot(sessionId), title),
    sessionId,
    now: NOW,
  })
}

test('pull refuses a missing hash, a foreign schema and a mismatched item', async () => {
  const archive = await makeArchive()
  const remote = await makeStore(path.join(archive.base, 'remote'), 'remote-device')
  const local = await makeStore(path.join(archive.base, 'local'), 'local-device')
  const published = await publishSession(archive.sink, remote)

  const manifestPath = path.join(archive.sink.rootDir, 'devices', remote.device.id, 'manifest.json')
  const original = JSON.parse(await fs.readFile(manifestPath, 'utf8'))

  const tampered = JSON.parse(JSON.stringify(original))
  delete tampered.items['session/sess-r'].hash
  await writeJsonAtomic(manifestPath, tampered)
  await assert.rejects(
    () => pullRemote({ sink: archive.sink, store: local, deviceId: remote.device.id, kind: 'session', id: 'sess-r', now: NOW }),
    (error) => error.code === 'wps-sync/manifest-invalid',
  )

  const wrongSchema = JSON.parse(JSON.stringify(original))
  wrongSchema.schemaVersion = 99
  await writeJsonAtomic(manifestPath, wrongSchema)
  await assert.rejects(
    () => pullRemote({ sink: archive.sink, store: local, deviceId: remote.device.id, kind: 'session', id: 'sess-r', now: NOW }),
    (error) => error.code === 'wps-sync/schema-mismatch',
  )

  const wrongKind = JSON.parse(JSON.stringify(original))
  wrongKind.items['session/sess-r'].kind = 'workspace'
  await writeJsonAtomic(manifestPath, wrongKind)
  await assert.rejects(
    () => pullRemote({ sink: archive.sink, store: local, deviceId: remote.device.id, kind: 'session', id: 'sess-r', now: NOW }),
    (error) => error.code === 'wps-sync/manifest-mismatch',
  )

  await writeJsonAtomic(manifestPath, original)
  const ok = await pullRemote({
    sink: archive.sink,
    store: local,
    deviceId: remote.device.id,
    kind: 'session',
    id: 'sess-r',
    now: NOW,
  })
  assert.equal(ok.hash, published.hash)

  // Pulling the very same content again is idempotent: no second staging dir.
  const again = await pullRemote({
    sink: archive.sink,
    store: local,
    deviceId: remote.device.id,
    kind: 'session',
    id: 'sess-r',
    now: LATER,
  })
  assert.equal(again.alreadyImported, true)
  assert.equal(again.importId, ok.importId)
  assert.equal(local.data.imports.filter((entry) => entry.importId === ok.importId).length, 1)
  const staged = await fs.readdir(path.join(archive.sink.rootDir, 'imports'))
  assert.equal(staged.length, 1)
})

test('a corrupt device manifest is reported and still blocks a pull', async () => {
  const archive = await makeArchive()
  const remote = await makeStore(path.join(archive.base, 'remote'), 'remote-device')
  const local = await makeStore(path.join(archive.base, 'local'), 'local-device')
  await publishSession(archive.sink, remote, 'sess-c', '坏设备')

  const manifestPath = path.join(archive.sink.rootDir, 'devices', remote.device.id, 'manifest.json')
  await fs.writeFile(manifestPath, '{ broken', 'utf8')

  const listed = await listRemote({ sink: archive.sink, selfDeviceId: local.device.id })
  const row = listed.devices.find((device) => device.id === remote.device.id)
  assert.ok(row, 'the corrupt device must still be listed')
  assert.equal(row.corrupt, true)
  assert.ok(row.error)
  assert.deepEqual(listed.corruptDevices, [remote.device.id])

  await assert.rejects(
    () => pullRemote({ sink: archive.sink, store: local, deviceId: remote.device.id, kind: 'session', id: 'sess-c', now: NOW }),
    (error) => error.code === 'wps-sync/json-invalid',
  )
})

/* ---------------------------------------------------------------- link guards */

test('a symlinked or junctioned archive directory is refused before writing', async (t) => {
  const archive = await makeArchive()
  const outside = await tempDir('wps-outside-')
  const sentinel = path.join(outside, 'sentinel.txt')
  await fs.writeFile(sentinel, 'untouched', 'utf8')

  const linkPath = path.join(archive.sink.rootDir, 'conversations')
  try {
    await fs.symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`symlink not permitted here: ${error.code}`)
    return
  }

  const store = await makeStore(path.join(archive.base, 'state'))
  await assert.rejects(
    () =>
      exportSession({
        sink: archive.sink,
        store,
        device: store.device,
        sessionQuery: fakeSessionQuery(sessionSnapshot('sess-link'), '链接'),
        sessionId: 'sess-link',
        now: NOW,
      }),
    (error) => error.code === 'wps-sync/link-detected',
  )
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'untouched')
  assert.equal(await fs.readdir(outside).then((list) => list.length), 1)
})

test('restore refuses a link under the target directory', async (t) => {
  const archive = await makeArchive()
  const remote = await makeStore(path.join(archive.base, 'remote'), 'remote-device')
  const local = await makeStore(path.join(archive.base, 'local'), 'local-device')

  const workspaceRoot = await tempDir('wps-restore-src-')
  await writeFile(path.join(workspaceRoot, 'a.txt'), 'payload')
  await exportWorkspace({
    sink: archive.sink,
    store: remote,
    device: remote.device,
    workspace: { id: 'ws-link', title: '链接工作区', path: workspaceRoot },
    config: makeConfig(),
    syncRoot: archive.syncRoot,
    now: NOW,
  })
  const pulled = await pullRemote({
    sink: archive.sink,
    store: local,
    deviceId: remote.device.id,
    kind: 'workspace',
    id: 'ws-link',
    now: NOW,
  })

  const target = await tempDir('wps-restore-target-')
  const outside = await tempDir('wps-restore-outside-')
  const sentinel = path.join(outside, 'sentinel.txt')
  await fs.writeFile(sentinel, 'untouched', 'utf8')
  const link = path.join(target, 'linked')
  try {
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`symlink not permitted here: ${error.code}`)
    return
  }

  // A link that is not on the restored path is fine; a link that is refused.
  await assert.rejects(
    () =>
      restoreWorkspace({
        sink: archive.sink,
        store: local,
        importId: pulled.importId,
        targetDir: link,
        syncRoot: archive.syncRoot,
        conflict: 'skip',
      }),
    (error) => error.code === 'wps-sync/link-detected' || error.code === 'wps-sync/target-not-directory',
  )
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'untouched')
})

/* ------------------------------------------------------------- self-healing */

test('a deleted mirror file is re-uploaded instead of trusted from the state', async () => {
  const archive = await makeArchive()
  const store = await makeStore(path.join(archive.base, 'state'))
  const workspaceRoot = await tempDir('wps-heal-ws-')
  await writeFile(path.join(workspaceRoot, 'a.txt'), 'a')
  const config = makeConfig()
  const workspace = { id: 'ws-heal', title: '自愈', path: workspaceRoot }

  const first = await exportWorkspace({ sink: archive.sink, store, device: store.device, workspace, config, syncRoot: archive.syncRoot, now: NOW })
  assert.equal(first.status, 'uploaded')

  // The cloud client (or a user) removes the mirrored file; mtime/size still
  // match, so only a real existence check can notice.
  await fs.rm(path.join(archive.sink.rootDir, first.dir, 'files', 'a.txt'))
  const second = await exportWorkspace({ sink: archive.sink, store, device: store.device, workspace, config, syncRoot: archive.syncRoot, now: NOW })
  assert.equal(second.hash, first.hash)
  assert.equal(await fs.readFile(path.join(archive.sink.rootDir, first.dir, 'files', 'a.txt'), 'utf8'), 'a')

  // Same for a session archive.
  const sessionQuery = fakeSessionQuery(sessionSnapshot('sess-heal'), 'heal')
  const session1 = await exportSession({ sink: archive.sink, store, device: store.device, sessionQuery, sessionId: 'sess-heal', now: NOW })
  await fs.rm(path.join(archive.sink.rootDir, session1.dir, 'session.jsonl'))
  const session2 = await exportSession({ sink: archive.sink, store, device: store.device, sessionQuery, sessionId: 'sess-heal', now: LATER })
  assert.equal(session2.status, 'uploaded')
})

test('a junction inside a workspace is neither mirrored nor walked', async (t) => {
  const archive = await makeArchive()
  const store = await makeStore(path.join(archive.base, 'state'))
  const workspaceRoot = await tempDir('wps-junction-ws-')
  await writeFile(path.join(workspaceRoot, 'a.txt'), 'inside')
  const outside = await tempDir('wps-junction-out-')
  await writeFile(path.join(outside, 'secret.txt'), 'outside-only')

  try {
    await fs.symlink(outside, path.join(workspaceRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`symlink not permitted here: ${error.code}`)
    return
  }

  const result = await exportWorkspace({
    sink: archive.sink,
    store,
    device: store.device,
    workspace: { id: 'ws-junction', title: '目录联接', path: workspaceRoot },
    config: makeConfig(),
    syncRoot: archive.syncRoot,
    now: NOW,
  })
  assert.equal(result.status, 'uploaded')
  const mirrored = await fs.readdir(path.join(archive.sink.rootDir, result.dir, 'files'))
  assert.deepEqual(mirrored, ['a.txt'])

  const scanned = await walkSource(workspaceRoot)
  assert.deepEqual(
    scanned.files.map((entry) => entry.path),
    ['a.txt'],
  )
  assert.ok(
    scanned.skipped.some((entry) => entry.path === 'linked'),
    'the junction must be reported as skipped',
  )

  // The same guard protects an archive walk (used by imports/restore listings).
  const importRoot = 'imports/probe/files'
  await archive.sink.ensure()
  await ensureDir(path.join(archive.sink.rootDir, importRoot))
  await fs.symlink(outside, path.join(archive.sink.rootDir, importRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await archive.sink.write(`${importRoot}/kept.json`, Buffer.from('{}'))
  const walked = await archive.sink.walk('imports')
  const paths = walked.map((entry) => entry.path)
  assert.ok(
    paths.includes('imports/probe/files/kept.json'),
    `walk must still list regular archive files, got ${JSON.stringify(paths)}`,
  )
  assert.equal(
    paths.some((entry) => entry.endsWith('secret.txt')),
    false,
  )
})

/* -------------------------------------------------------------------- bridge */

/** Minimal IncomingMessage stand-in for the webServer route. */
function nodeRequest({ method = 'GET', url = '/api/wps-sync/state', headers = {}, body = null } = {}) {
  const listeners = new Map()
  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return req
    },
    destroy() {},
  }
  if (body !== null) {
    const buffer = Buffer.from(body, 'utf8')
    req.headers = { 'content-length': String(buffer.length), ...headers }
    queueMicrotask(() => {
      for (const listener of listeners.get('data') ?? []) listener(buffer)
      for (const listener of listeners.get('end') ?? []) listener()
    })
  }
  return req
}

/** Minimal ServerResponse stand-in that records status and parsed body. */
function nodeResponse() {
  const res = { status: 0, body: null, headersSent: false, writableEnded: false, headers: null }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
    res.headersSent = true
    return res
  }
  res.end = (payload) => {
    res.writableEnded = true
    res.body = payload ? JSON.parse(payload) : null
    return res
  }
  return res
}

function fakeEngine(status = {}) {
  const calls = []
  return {
    calls,
    services: {},
    async status() {
      return { ok: true, marker: 'state', ...status }
    },
    async upload(kind, id) {
      calls.push(['upload', kind, id])
      return { status: 'uploaded', kind, id }
    },
    async remoteList() {
      calls.push(['remoteList'])
      return { devices: [], deviceCount: 0, itemCount: 0 }
    },
  }
}

test('connection.fetch handlers use the real {path, methods, requestBody, fetch} contract', () => {
  const bridge = createBridge({ engine: fakeEngine() })
  const state = bridge.fetchHandlers.find((entry) => entry.path === '/api/wps-sync/state')
  assert.ok(state, 'GET /state must be exposed through connection.fetch')
  assert.deepEqual(state.methods, ['GET'])
  assert.equal(state.requestBody, 'buffered')
  assert.equal(typeof state.fetch, 'function')
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'handler'), false)

  const upload = bridge.fetchHandlers.find((entry) => entry.path === '/api/wps-sync/upload')
  assert.deepEqual(upload.methods, ['POST'])
  assert.equal(upload.requestBody, 'buffered')
})

test('HTTP remote/list resolves to the remoteList action', async () => {
  const engine = fakeEngine()
  const bridge = createBridge({ engine })
  const payload = JSON.stringify({})
  const response = await bridge.handleFetch(
    new Request('http://127.0.0.1:51287/api/wps-sync/remote/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wps-sync-token': bridge.token },
      body: payload,
    }),
  )
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.deepEqual(engine.calls[0], ['remoteList'])
})

test('origin rules: desktop scheme allowed, foreign origin refused, missing host refused', async () => {
  const bridge = createBridge({ engine: fakeEngine() })

  const desktop = await bridge.handleFetch(
    new Request('http://127.0.0.1:51287/api/wps-sync/state', {
      headers: { origin: 'dsh-app://app' },
    }),
  )
  assert.equal(desktop.status, 200)

  const https = await bridge.handleFetch(
    new Request('http://127.0.0.1:51287/api/wps-sync/state', {
      headers: { origin: 'https://127.0.0.1:51287' },
    }),
  )
  assert.equal(https.status, 200)

  const foreign = await bridge.handleFetch(
    new Request('http://127.0.0.1:51287/api/wps-sync/state', {
      headers: { origin: 'https://evil.example' },
    }),
  )
  assert.equal(foreign.status, 403)

  // A `Request` cannot carry a `host` header, so the URL authority is what the
  // loopback check sees; a LAN address must be refused just the same.
  const foreignAuthority = await bridge.handleFetch(
    new Request('http://198.51.100.7:51287/api/wps-sync/state'),
  )
  assert.equal(foreignAuthority.status, 403)

  // The raw Node route has no URL authority to fall back on: no Host = refused.
  const req = nodeRequest({ url: '/api/wps-sync/state' })
  const res = nodeResponse()
  await bridge.httpRoute.handler(req, res)
  assert.equal(res.status, 403)
})

test('the HTTP face works without any Connection service (webServer-only hosts)', async () => {
  const bridge = createBridge({ engine: fakeEngine() })
  const stateRes = nodeResponse()
  await bridge.httpRoute.handler(
    nodeRequest({ url: '/api/wps-sync/state', headers: { host: '127.0.0.1:51287' } }),
    stateRes,
  )
  assert.equal(stateRes.status, 200)
  assert.equal(stateRes.body.ok, true)
  assert.ok(stateRes.body.token)

  const uploadRes = nodeResponse()
  await bridge.httpRoute.handler(
    nodeRequest({
      method: 'POST',
      url: '/api/wps-sync/upload',
      headers: { host: '127.0.0.1:51287', 'content-type': 'application/json', 'x-wps-sync-token': bridge.token },
      body: JSON.stringify({ kind: 'tasks' }),
    }),
    uploadRes,
  )
  assert.equal(uploadRes.status, 200, JSON.stringify(uploadRes.body))
  assert.equal(uploadRes.body.ok, true)
})

test('the HTTP face never consults connection admission', async () => {
  let called = 0
  const bridge = createBridge({
    engine: fakeEngine(),
    admit() {
      called += 1
      throw new Error('admission exploded')
    },
  })
  const res = nodeResponse()
  await bridge.httpRoute.handler(
    nodeRequest({ url: '/api/wps-sync/state', headers: { host: '127.0.0.1:51287' } }),
    res,
  )
  assert.equal(res.status, 200)
  assert.equal(called, 0)
})

test('the RPC channel still fails closed when admission explodes', async () => {
  const bridge = createBridge({
    engine: fakeEngine(),
    admit() {
      throw new Error('admission exploded')
    },
  })
  const req = nodeRequest({
    method: 'POST',
    url: '/wps-sync/request',
    headers: { host: '127.0.0.1:51287', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', method: 'request', rpcId: 'r1', payload: { action: 'status', args: {} } }),
  })
  const res = nodeResponse()
  await bridge.rpcRoute.handler(req, res)
  assert.equal(res.status, 403)
  assert.equal(res.body.result.ok, false)
  assert.equal(res.body.result.error.code, 'wps-sync/forbidden-connection')
})

test('rpcHandler answers the installed ConnectionRpcHandlerResult shape', async () => {
  const bridge = createBridge({ engine: fakeEngine() })
  const ok = await bridge.rpcHandler('request', { action: 'status', args: {} })
  assert.equal(ok.ok, true)
  assert.equal(ok.value.marker, 'state')

  const unknownEndpoint = await bridge.rpcHandler('nope', {})
  assert.equal(unknownEndpoint.ok, false)
  assert.equal(unknownEndpoint.error.code, 'wps-sync/rpc-endpoint')
  assert.equal(typeof unknownEndpoint.error.details, 'object')

  const unknownAction = await bridge.rpcHandler('request', { action: 'nope', args: {} })
  assert.equal(unknownAction.ok, false)
  assert.equal(unknownAction.error.code, 'wps-sync/unknown-action')
})

test('registered fetch routes use the installed {requestBody, fetch} contract', async () => {
  const bridge = createBridge({ engine: fakeEngine() })
  for (const route of bridge.fetchHandlers) {
    assert.equal(typeof route.path, 'string')
    assert.ok(Array.isArray(route.methods) && route.methods.length > 0)
    // `rpc-host.ts:239-243` copies only methods/requestBody/fetch; a legacy
    // `{requestBody:'buffer', handler}` route would register but never run.
    assert.equal(route.requestBody, 'buffered')
    assert.equal(typeof route.fetch, 'function')
    assert.equal('handler' in route, false)
  }
})