'use strict'

/**
 * The three behaviours that must survive a damaged cloud folder:
 *  - a corrupt `state.json` is quarantined, never overwritten;
 *  - a staged pull is only "already imported" while its files are still there;
 *  - a corrupt root `manifest.json` is rebuilt from the per-device copies.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')

const { StateStore } = require('../lib/store')
const { SyncEngine } = require('../lib/engine')
const { exportSession } = require('../lib/export-session')
const { listRemote, pullRemote, buildImportId } = require('../lib/remote')
const { readRootManifest, ROOT_MANIFEST, deviceManifestPath } = require('../lib/manifest')
const {
  makeArchive,
  makeConfig,
  tempDir,
  writeFile,
  fakeSessionQuery,
  sessionSnapshot,
} = require('./helpers')

const NOW = () => Date.parse('2026-03-04T05:06:07.000Z')
const CORRUPT = '{ this is not json'

async function listFiles(dir) {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

async function exists(file) {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

function buildEngine(stateDir, syncRoot, overrides = {}) {
  const services = {
    sessionQuery: fakeSessionQuery(sessionSnapshot('sess-1'), '示例会话'),
    workspaceRegistry: { list: () => [] },
    schedule: { async catalog() { return [] }, async history() { return { messages: [] } } },
  }
  return new SyncEngine({
    config: makeConfig({
      syncRootDir: syncRoot,
      debounceMs: 0,
      workspaceScanIntervalSec: 0,
      ...overrides,
    }),
    stateDir,
    services,
    now: NOW,
  })
}

test('a corrupt state file is quarantined before anything can overwrite it', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'state.json')
  await writeFile(file, CORRUPT)

  const engine = buildEngine(dir, await fs.mkdtemp(path.join(await tempDir(), 'root-')))
  await engine.init()
  // A background write after the load must not touch the damaged bytes.
  await engine.refreshRoot()
  await engine.store.save()

  const names = await listFiles(dir)
  const backups = names.filter((name) => name.startsWith('state.json.corrupt-'))
  assert.equal(backups.length, 1, `expected exactly one backup, got ${JSON.stringify(names)}`)
  const backupPath = path.join(dir, backups[0])
  assert.equal(await fs.readFile(backupPath, 'utf8'), CORRUPT)

  const state = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(state.version, 1)
  assert.ok(state.device && typeof state.device.id === 'string')
  assert.equal(state.stateRecovered.from, backupPath)
  assert.equal(state.stateRecovered.code, 'wps-sync/json-invalid')
})

test('recovery is reported in status without growing the durable error ring', async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, 'state.json'), CORRUPT)
  const root = await fs.mkdtemp(path.join(await tempDir(), 'root-'))
  const engine = buildEngine(dir, root)
  await engine.init()
  const durableBefore = engine.store.data.errors.length

  const status = await engine.status({ fresh: true })
  assert.ok(status.stateRecovered)
  assert.match(status.stateRecovered.from, /state\.json\.corrupt-/)
  const warning = status.errors.find((entry) => entry.code === 'wps-sync/state-recovered')
  assert.ok(warning, 'status.errors must explain the recovery')
  assert.match(warning.message, /state\.json\.corrupt-/)

  // Polling again must not append anything durable.
  await engine.status({ fresh: true })
  assert.equal(engine.store.data.errors.length, durableBefore)
  const reloaded = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(reloaded.errors.length, durableBefore)
})

test('a first run in an empty directory creates no quarantine file', async () => {
  const dir = await tempDir()
  const store = new StateStore({ dir, deviceName: 'fresh', now: NOW })
  const data = await store.load()
  assert.equal(data.stateRecovered, null)
  assert.equal((await listFiles(dir)).filter((name) => name.includes('corrupt')).length, 0)
  assert.ok(await exists(path.join(dir, 'state.json')))
})

test('an unreadable state file locks writes instead of overwriting it', async () => {
  const dir = await tempDir()
  // A directory where the file belongs makes every read fail with EISDIR.
  await fs.mkdir(path.join(dir, 'state.json'), { recursive: true })
  const store = new StateStore({ dir, deviceName: 'locked', now: NOW })
  await assert.rejects(() => store.load())
  await assert.rejects(() => store.save(), (error) => error.code === 'wps-sync/state-locked')
})

test('import ids keep the full content hash so different contents never collide', () => {
  const version = 'a'.repeat(50) + 'b'.repeat(14)
  const id = buildImportId('device-1234567890', 'session', 'sess-1', version)
  assert.ok(id.endsWith(version), `import id must keep the whole hash, got ${id}`)
  assert.ok(id.length < 180)
})

test('a pruned staging directory is re-copied instead of reported as already imported', async () => {
  const archive = await makeArchive()
  const storeA = new StateStore({ dir: path.join(archive.base, 'a'), deviceName: 'device-a', now: NOW })
  await storeA.load()
  const storeB = new StateStore({ dir: path.join(archive.base, 'b'), deviceName: 'device-b', now: NOW })
  await storeB.load()

  const exported = await exportSession({
    sink: archive.sink,
    store: storeA,
    device: storeA.device,
    sessionQuery: fakeSessionQuery(sessionSnapshot('sess-1'), '示例会话'),
    sessionId: 'sess-1',
    now: NOW,
  })

  const first = await pullRemote({
    sink: archive.sink,
    store: storeB,
    deviceId: storeA.device.id,
    kind: 'session',
    id: 'sess-1',
    now: NOW,
  })
  assert.equal(first.alreadyImported, undefined)
  assert.ok(await archive.sink.exists(`${first.stagedDir}/files/session.jsonl`))

  const second = await pullRemote({
    sink: archive.sink,
    store: storeB,
    deviceId: storeA.device.id,
    kind: 'session',
    id: 'sess-1',
    now: NOW,
  })
  assert.equal(second.alreadyImported, true)

  // The user (or the cloud client) prunes the staging folder.
  await archive.sink.removeTree(`imports/${first.importId}`)
  assert.equal(await archive.sink.exists(`${first.stagedDir}/files/session.jsonl`), false)

  const third = await pullRemote({
    sink: archive.sink,
    store: storeB,
    deviceId: storeA.device.id,
    kind: 'session',
    id: 'sess-1',
    now: NOW,
  })
  assert.equal(third.alreadyImported, undefined, 'a vanished staging dir must be re-created')
  assert.equal(third.fileCount, first.fileCount)
  assert.ok(await archive.sink.exists(`${third.stagedDir}/files/session.jsonl`))
  assert.ok(await archive.sink.exists(`${third.stagedDir}/files/transcript.md`))
  assert.equal(third.hash, exported.hash)
})

test('a half-pruned staging directory is re-copied instead of silently truncated', async () => {
  const archive = await makeArchive()
  const storeA = new StateStore({ dir: path.join(archive.base, 'a'), deviceName: 'device-a', now: NOW })
  await storeA.load()
  const storeB = new StateStore({ dir: path.join(archive.base, 'b'), deviceName: 'device-b', now: NOW })
  await storeB.load()

  await exportSession({
    sink: archive.sink,
    store: storeA,
    device: storeA.device,
    sessionQuery: fakeSessionQuery(sessionSnapshot('sess-2'), '半删除会话'),
    sessionId: 'sess-2',
    now: NOW,
  })

  const first = await pullRemote({
    sink: archive.sink,
    store: storeB,
    deviceId: storeA.device.id,
    kind: 'session',
    id: 'sess-2',
    now: NOW,
  })
  assert.equal(first.fileCount, 2)
  assert.ok(await archive.sink.exists(`${first.stagedDir}/files/transcript.md`))

  // Only one of the two content files survives: the directory still exists, so a
  // presence-only check would keep reporting `alreadyImported` with a truncated
  // archive.
  await fs.rm(path.join(archive.sink.rootDir, first.stagedDir, 'files', 'transcript.md'))
  const partial = await pullRemote({
    sink: archive.sink,
    store: storeB,
    deviceId: storeA.device.id,
    kind: 'session',
    id: 'sess-2',
    now: NOW,
  })
  assert.equal(partial.alreadyImported, undefined, 'an incomplete staging dir must be re-copied')
  assert.ok(await archive.sink.exists(`${partial.stagedDir}/files/transcript.md`))
  assert.ok(await archive.sink.exists(`${partial.stagedDir}/files/session.jsonl`))
  assert.equal(partial.fileCount, first.fileCount)
})

test('a corrupt root manifest is rebuilt from the device copies', async () => {
  const archive = await makeArchive()
  const storeA = new StateStore({ dir: path.join(archive.base, 'a'), deviceName: 'device-a', now: NOW })
  await storeA.load()
  const storeB = new StateStore({ dir: path.join(archive.base, 'b'), deviceName: 'device-b', now: NOW })
  await storeB.load()

  for (const [store, sessionId] of [[storeA, 'sess-a'], [storeB, 'sess-b']]) {
    await exportSession({
      sink: archive.sink,
      store,
      device: store.device,
      sessionQuery: fakeSessionQuery(sessionSnapshot(sessionId), `会话 ${sessionId}`),
      sessionId,
      now: NOW,
    })
  }

  await writeFile(archive.sink.resolve(ROOT_MANIFEST), CORRUPT)

  const listed = await listRemote({ sink: archive.sink, selfDeviceId: storeA.device.id })
  assert.equal(listed.rootCorrupt, true)
  assert.ok(listed.rootError)
  assert.equal(listed.deviceCount, 2)
  assert.equal(listed.itemCount, 2)
  const ids = listed.devices.map((row) => row.id).sort()
  assert.deepEqual(ids, [storeA.device.id, storeB.device.id].sort())

  // Publishing from A repairs the shared index and keeps B's entries.
  await exportSession({
    sink: archive.sink,
    store: storeA,
    device: storeA.device,
    sessionQuery: fakeSessionQuery(sessionSnapshot('sess-a'), '会话 sess-a'),
    sessionId: 'sess-a',
    force: true,
    now: NOW,
  })
  const root = await readRootManifest(archive.sink)
  assert.equal(root.schemaVersion, 1)
  assert.ok(root.items[`${storeA.device.id}/session/sess-a`])
  assert.ok(root.items[`${storeB.device.id}/session/sess-b`])
  const repaired = await listRemote({ sink: archive.sink, selfDeviceId: storeA.device.id })
  assert.equal(repaired.rootCorrupt, false)
  assert.equal(repaired.itemCount, 2)
})

test('a corrupt device manifest is listed separately and still refuses a pull', async () => {
  const archive = await makeArchive()
  const storeA = new StateStore({ dir: path.join(archive.base, 'a'), deviceName: 'device-a', now: NOW })
  await storeA.load()
  const storeB = new StateStore({ dir: path.join(archive.base, 'b'), deviceName: 'device-b', now: NOW })
  await storeB.load()

  for (const [store, sessionId] of [[storeA, 'sess-a'], [storeB, 'sess-b']]) {
    await exportSession({
      sink: archive.sink,
      store,
      device: store.device,
      sessionQuery: fakeSessionQuery(sessionSnapshot(sessionId), `会话 ${sessionId}`),
      sessionId,
      now: NOW,
    })
  }
  await writeFile(archive.sink.resolve(deviceManifestPath(storeB.device.id)), CORRUPT)

  const listed = await listRemote({ sink: archive.sink, selfDeviceId: storeA.device.id })
  assert.equal(listed.deviceCount, 2)
  assert.deepEqual(listed.corruptDevices, [storeB.device.id])
  const broken = listed.devices.find((row) => row.id === storeB.device.id)
  assert.equal(broken.corrupt, true)
  assert.ok(broken.error)
  assert.equal(broken.itemCount, 0)
  // The healthy device is unaffected.
  assert.equal(listed.devices.find((row) => row.id === storeA.device.id).items.length, 1)

  await assert.rejects(
    () => pullRemote({ sink: archive.sink, store: storeA, deviceId: storeB.device.id, kind: 'session', id: 'sess-b', now: NOW }),
    (error) => error.code === 'wps-sync/json-invalid',
  )

  const status = await buildEngine(path.join(archive.base, 'engine'), archive.syncRoot).status({ fresh: true })
  const deviceWarning = status.errors.find((entry) => entry.code === 'wps-sync/device-manifest-corrupt')
  assert.ok(deviceWarning, 'status must show the broken device as a warning')
  assert.match(deviceWarning.message, new RegExp(storeB.device.id))
})

test('status merges root manifest corruption as a warning, not a durable error', async () => {
  const archive = await makeArchive()
  const storeA = new StateStore({ dir: path.join(archive.base, 'a'), deviceName: 'device-a', now: NOW })
  await storeA.load()
  await exportSession({
    sink: archive.sink,
    store: storeA,
    device: storeA.device,
    sessionQuery: fakeSessionQuery(sessionSnapshot('sess-a'), '会话 sess-a'),
    sessionId: 'sess-a',
    now: NOW,
  })
  await writeFile(archive.sink.resolve(ROOT_MANIFEST), CORRUPT)

  const engine = buildEngine(path.join(archive.base, 'engine'), archive.syncRoot)
  await engine.init()
  const status = await engine.status({ fresh: true })
  assert.equal(status.remote.rootCorrupt, true)
  assert.ok(status.remote.rootError)
  assert.ok(status.errors.some((entry) => entry.code === 'wps-sync/root-manifest-corrupt'))
  assert.equal(engine.store.data.errors.length, 0)
  assert.equal(await exists(path.join(archive.base, 'engine', 'state.json')), true)
})