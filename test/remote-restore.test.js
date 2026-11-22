'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')

const { exportSession } = require('../lib/export-session')
const { exportWorkspace } = require('../lib/export-workspace')
const { listRemote, pullRemote } = require('../lib/remote')
const { restoreWorkspace } = require('../lib/restore')
const { describeImport, readImportFile } = require('../lib/archive')
const { readRootManifest } = require('../lib/manifest')
const {
  makeArchive,
  makeStore,
  makeConfig,
  tempDir,
  writeFile,
  fakeSessionQuery,
  sessionSnapshot,
} = require('./helpers')

const NOW = () => Date.parse('2026-02-03T04:05:06.000Z')

async function exists(file) {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

/** Two simulated devices sharing one archive. */
async function twoDevices() {
  const archive = await makeArchive()
  const storeA = await makeStore(path.join(archive.base, 'state-a'), 'device-a')
  const storeB = await makeStore(path.join(archive.base, 'state-b'), 'device-b')
  return { ...archive, storeA, storeB }
}

test('listRemote shows another device and never lists the local device twice', async () => {
  const { sink, storeA, storeB } = await twoDevices()
  await exportSession({
    sink,
    store: storeA,
    device: storeA.device,
    sessionQuery: fakeSessionQuery(sessionSnapshot('sess-1'), '示例会话'),
    sessionId: 'sess-1',
    now: NOW,
  })

  const fromB = await listRemote({ sink, selfDeviceId: storeB.device.id })
  assert.equal(fromB.deviceCount, 1)
  assert.equal(fromB.devices[0].id, storeA.device.id)
  assert.equal(fromB.devices[0].self, false)
  assert.equal(fromB.devices[0].items.length, 1)
  assert.equal(fromB.devices[0].items[0].id, 'sess-1')

  const fromA = await listRemote({ sink, selfDeviceId: storeA.device.id })
  assert.equal(fromA.devices[0].self, true)
})

test('pull stages a copy without touching the source and is refused for the local device', async () => {
  const { sink, storeA, storeB } = await twoDevices()
  const exported = await exportSession({
    sink,
    store: storeA,
    device: storeA.device,
    sessionQuery: fakeSessionQuery(sessionSnapshot('sess-1'), '示例会话'),
    sessionId: 'sess-1',
    now: NOW,
  })

  const pulled = await pullRemote({
    sink,
    store: storeB,
    deviceId: storeA.device.id,
    kind: 'session',
    id: 'sess-1',
    version: exported.hash ? undefined : undefined,
    now: NOW,
  })
  assert.ok(pulled.importId)
  assert.equal(pulled.runtimeImportSupported, false)
  assert.equal(pulled.fileCount, 2)
  assert.ok(await sink.exists(`${pulled.stagedDir}/files/session.jsonl`))
  assert.ok(await sink.exists(`${pulled.stagedDir}/files/transcript.md`))
  // the source archive of device A is untouched
  assert.ok(await sink.exists(`${exported.dir}/session.jsonl`))

  await assert.rejects(
    () => pullRemote({ sink, store: storeB, deviceId: storeB.device.id, kind: 'session', id: 'sess-1', now: NOW }),
    (error) => error.code === 'wps-sync/self-pull',
  )
  await assert.rejects(
    () => pullRemote({ sink, store: storeB, deviceId: storeA.device.id, kind: 'session', id: 'nope', now: NOW }),
    (error) => error.code === 'wps-sync/item-not-found',
  )
})

test('a pulled session is a readable archive, not an importable session', async () => {
  const { sink, storeA, storeB } = await twoDevices()
  await exportSession({
    sink,
    store: storeA,
    device: storeA.device,
    sessionQuery: fakeSessionQuery(sessionSnapshot('sess-9'), '归档会话'),
    sessionId: 'sess-9',
    now: NOW,
  })
  const pulled = await pullRemote({
    sink,
    store: storeB,
    deviceId: storeA.device.id,
    kind: 'session',
    id: 'sess-9',
    now: NOW,
  })

  const described = await describeImport({ sink, store: storeB, importId: pulled.importId })
  assert.equal(described.importId, pulled.importId)
  assert.ok(described.files.some((file) => file.path.endsWith('session.jsonl')))

  const text = await readImportFile({
    sink,
    store: storeB,
    importId: pulled.importId,
    path: 'transcript.md',
  })
  assert.match(text.text, /归档会话/)
  assert.equal(text.binary, undefined)

  const record = storeB.findImport(pulled.importId)
  assert.equal(record.kind, 'session')
})

test('workspace restore skips existing files and can rename instead', async () => {
  const { sink, storeA, storeB, syncRoot } = await twoDevices()
  const source = await tempDir('wps-ws-src-')
  await writeFile(path.join(source, 'a.txt'), 'alpha')
  await writeFile(path.join(source, 'sub', 'b.txt'), 'beta')
  const exported = await exportWorkspace({
    sink,
    store: storeA,
    device: storeA.device,
    workspace: { id: 'ws-9', title: '演示 工作区', path: source },
    config: makeConfig(),
    syncRoot,
    now: NOW,
  })

  const pulled = await pullRemote({
    sink,
    store: storeB,
    deviceId: storeA.device.id,
    kind: 'workspace',
    id: 'ws-9',
    version: exported.hash ? undefined : undefined,
    now: NOW,
  })

  const target = path.join(await tempDir('wps-restore-'), 'out')
  const first = await restoreWorkspace({ sink, store: storeB, importId: pulled.importId, targetDir: target, conflict: 'skip', syncRoot })
  assert.equal(first.restored, 2)
  assert.equal(first.skipped, 0)
  assert.equal(await fs.readFile(path.join(target, 'a.txt'), 'utf8'), 'alpha')
  assert.equal(await fs.readFile(path.join(target, 'sub', 'b.txt'), 'utf8'), 'beta')

  // a second restore never overwrites: everything is skipped
  await fs.writeFile(path.join(target, 'a.txt'), 'locally edited', 'utf8')
  const second = await restoreWorkspace({ sink, store: storeB, importId: pulled.importId, targetDir: target, conflict: 'skip', syncRoot })
  assert.equal(second.restored, 0)
  assert.equal(second.skipped, 2)
  assert.equal(await fs.readFile(path.join(target, 'a.txt'), 'utf8'), 'locally edited')

  const third = await restoreWorkspace({ sink, store: storeB, importId: pulled.importId, targetDir: target, conflict: 'rename', syncRoot })
  assert.equal(third.renamed, 2)
  assert.ok(await exists(path.join(target, 'a (2).txt')))
  assert.equal(await fs.readFile(path.join(target, 'a (2).txt'), 'utf8'), 'alpha')
})

test('restore refuses a target inside the sync root and non-workspace imports', async () => {
  const { sink, storeA, storeB, syncRoot } = await twoDevices()
  const source = await tempDir('wps-ws-src2-')
  await writeFile(path.join(source, 'x.txt'), 'x')
  await exportWorkspace({
    sink,
    store: storeA,
    device: storeA.device,
    workspace: { id: 'ws-10', title: 'x', path: source },
    config: makeConfig(),
    syncRoot,
    now: NOW,
  })
  const workspaceImport = await pullRemote({
    sink,
    store: storeB,
    deviceId: storeA.device.id,
    kind: 'workspace',
    id: 'ws-10',
    now: NOW,
  })

  await assert.rejects(
    () =>
      restoreWorkspace({
        sink,
        store: storeB,
        importId: workspaceImport.importId,
        targetDir: path.join(syncRoot, 'inside'),
        syncRoot,
      }),
    (error) => error.code === 'wps-sync/target-in-sync-root',
  )

  await exportSession({
    sink,
    store: storeA,
    device: storeA.device,
    sessionQuery: fakeSessionQuery(sessionSnapshot('sess-11'), '不可导入'),
    sessionId: 'sess-11',
    now: NOW,
  })
  const sessionImport = await pullRemote({
    sink,
    store: storeB,
    deviceId: storeA.device.id,
    kind: 'session',
    id: 'sess-11',
    now: NOW,
  })
  const neverTarget = await tempDir('wps-never-')
  const neverTarget2 = await tempDir('wps-never2-')
  await assert.rejects(
    () =>
      restoreWorkspace({
        sink,
        store: storeB,
        importId: sessionImport.importId,
        targetDir: neverTarget,
        syncRoot,
      }),
    (error) => error.code === 'wps-sync/kind-not-restorable',
  )
  await assert.rejects(
    () =>
      restoreWorkspace({
        sink,
        store: storeB,
        importId: workspaceImport.importId,
        targetDir: neverTarget2,
        conflict: 'overwrite',
        syncRoot,
      }),
    (error) => error.code === 'wps-sync/conflict-invalid',
  )
})

test('pulling never re-uploads the staged import and the root manifest stays shared', async () => {
  const { sink, storeA, storeB } = await twoDevices()
  await exportSession({
    sink,
    store: storeA,
    device: storeA.device,
    sessionQuery: fakeSessionQuery(sessionSnapshot('sess-1'), '列表演示'),
    sessionId: 'sess-1',
    now: NOW,
  })
  const before = await readRootManifest(sink)
  const pulled = await pullRemote({
    sink,
    store: storeB,
    deviceId: storeA.device.id,
    kind: 'session',
    id: 'sess-1',
    now: NOW,
  })
  assert.ok(pulled.importId)

  const after = await readRootManifest(sink)
  assert.deepEqual(Object.keys(after.items).sort(), Object.keys(before.items).sort())
  assert.equal(Object.keys(after.devices).length, 1, 'imports are not a device')

  // a second pull still only lists the one device item, not the staged import
  const remote = await listRemote({ sink, selfDeviceId: storeB.device.id })
  assert.equal(remote.deviceCount, 1)
  assert.equal(remote.devices[0].items.length, 1)

  // and device B pushing its own item does not drop device A's
  await exportSession({
    sink,
    store: storeB,
    device: storeB.device,
    sessionQuery: fakeSessionQuery(sessionSnapshot('sess-2'), 'B 的会话'),
    sessionId: 'sess-2',
    now: NOW,
  })
  const merged = await readRootManifest(sink)
  assert.ok(merged.items[`${storeA.device.id}/session/sess-1`])
  assert.ok(merged.items[`${storeB.device.id}/session/sess-2`])
  assert.equal(Object.keys(merged.devices).length, 2)
})