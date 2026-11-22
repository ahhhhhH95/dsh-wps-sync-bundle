'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { hashText, hashBuffer, hashFiles, sha256Hex } = require('../lib/hash')
const {
  emptyRoot,
  emptyDevice,
  mergeDeviceIntoRoot,
  normalizeRoot,
  normalizeItem,
  publishItem,
  publishManifests,
  readRootManifest,
  readDeviceManifest,
  publishManifests: publish,
} = require('../lib/manifest')
const { makeArchive } = require('./helpers')

test('sha256 helpers are stable and content sensitive', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(hashText('abc'), sha256Hex('abc'))
  assert.equal(hashBuffer(Buffer.from('abc', 'utf8')), sha256Hex('abc'))
  assert.notEqual(hashText('abc'), hashText('abd'))
})

test('hashFiles is independent of input order and path separators', () => {
  const one = hashFiles([
    { path: 'a/one.txt', hash: 'h1' },
    { path: 'b\\two.txt', hash: 'h2' },
  ])
  const two = hashFiles([
    { path: 'b/two.txt', hash: 'h2' },
    { path: 'a/one.txt', hash: 'h1' },
  ])
  assert.equal(one, two)
  assert.notEqual(one, hashFiles([{ path: 'a/one.txt', hash: 'h1' }]))
})

test('normalizeRoot tolerates junk and keeps well-formed entries', () => {
  const root = normalizeRoot({
    schemaVersion: 99,
    devices: { d1: { id: 'd1', name: 'A' }, bad: null },
    items: {
      'd1/session/s1': { deviceId: 'd1', kind: 'session', id: 's1' },
      'nokey': null,
      'd1/session/s2': { id: 's2' },
    },
  })
  assert.equal(root.devices.d1.name, 'A')
  assert.equal(Object.keys(root.devices).length, 2) // 'bad' is normalized, not dropped
  assert.ok(root.items['d1/session/s1'])
  assert.equal(root.items['d1/session/s1'].kind, 'session')
})

test('normalizeItem fills required fields', () => {
  const item = normalizeItem({ id: 'x', kind: 'session' }, 'd')
  assert.equal(item.id, 'x')
  assert.equal(item.deviceId, 'd')
  assert.equal(item.kind, 'session')
  assert.equal(item.fileCount, null)
  assert.equal(normalizeItem({ id: 'x' }, 'd'), null, 'an item without kind is dropped')
})

test('mergeDeviceIntoRoot never touches another device and drops vanished own items', () => {
  const deviceA = { id: 'devA', name: 'A', platform: 'win32' }
  const deviceB = { id: 'devB', name: 'B', platform: 'linux' }

  const aItem = { deviceId: 'devA', kind: 'session', id: 'sA', dir: 'conversations/devA/x-sA', hash: 'hA' }
  const bItem = { deviceId: 'devB', kind: 'session', id: 'sB', dir: 'conversations/devB/x-sB', hash: 'hB' }

  let root = emptyRoot()
  root = mergeDeviceIntoRoot(root, deviceA, { 'session/sA': aItem }, '2026-01-01T00:00:00.000Z')
  root = mergeDeviceIntoRoot(root, deviceB, { 'session/sB': bItem }, '2026-01-01T00:00:00.000Z')
  assert.ok(root.items['devA/session/sA'])
  assert.ok(root.items['devB/session/sB'])

  // device B republishes an empty item set: only B's key disappears
  const merged = mergeDeviceIntoRoot(root, deviceB, {}, '2026-01-02T00:00:00.000Z')
  assert.ok(merged.items['devA/session/sA'], 'device A item must survive')
  assert.equal(merged.items['devB/session/sB'], undefined)
  assert.equal(merged.devices.devA.itemCount, 1)
  assert.equal(merged.devices.devB.itemCount, 0)
})

test('publishItem writes only its own key into the device manifest and the root', async () => {
  const { sink } = await makeArchive()
  const device = { id: 'devA', name: 'A', platform: 'win32' }
  const now = () => Date.parse('2026-01-01T00:00:00.000Z')

  await publishItem(sink, device, 'session/s1', { deviceId: 'devA', kind: 'session', id: 's1', dir: 'conversations/devA/s1', hash: 'h1' }, now)
  await publishItem(sink, device, 'session/s2', { deviceId: 'devA', kind: 'session', id: 's2', dir: 'conversations/devA/s2', hash: 'h2' }, now)

  const deviceDoc = await readDeviceManifest(sink, device)
  assert.deepEqual(Object.keys(deviceDoc.items).sort(), ['session/s1', 'session/s2'])

  const rootDoc = await readRootManifest(sink)
  assert.deepEqual(Object.keys(rootDoc.items).sort(), ['devA/session/s1', 'devA/session/s2'])
  assert.equal(rootDoc.devices.devA.itemCount, 2)
})

test('a corrupt root manifest is an error, never silently rewritten', async () => {
  const { sink } = await makeArchive()
  await sink.writeText('manifest.json', '{ this is not json')
  await assert.rejects(() => readRootManifest(sink), (error) => error.code === 'wps-sync/json-invalid')
})

test('publishManifests keeps a second device visible', async () => {
  const { sink } = await makeArchive()
  const deviceA = { id: 'devA', name: 'A', platform: 'win32' }
  const deviceB = { id: 'devB', name: 'B', platform: 'linux' }
  const now = () => Date.parse('2026-01-01T00:00:00.000Z')

  const aItems = { 'session/sA': { deviceId: 'devA', kind: 'session', id: 'sA', dir: 'conversations/devA/sA', hash: 'hA' } }
  await publish(sink, deviceA, aItems, now)
  const bItems = { 'session/sB': { deviceId: 'devB', kind: 'session', id: 'sB', dir: 'conversations/devB/sB', hash: 'hB' } }
  await publish(sink, deviceB, bItems, now)

  const root = await readRootManifest(sink)
  assert.ok(root.items['devA/session/sA'])
  assert.ok(root.items['devB/session/sB'])
  assert.equal(Object.keys(root.devices).length, 2)
  assert.equal(emptyDevice(deviceA).device.id, 'devA')
})