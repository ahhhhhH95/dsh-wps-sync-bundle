'use strict'

/**
 * The two manifests.
 *
 * - `devices/<deviceId>/manifest.json` is authoritative for that device's items.
 * - `manifest.json` at the archive root is a merged view: it keeps the newest
 *   item record per key and is always read before it is written, so a second
 *   device's entries are never dropped by a blind overwrite.
 */

const path = require('node:path')
const { SCHEMA_VERSION } = require('./constants')
const { corrupt } = require('./errors')
const { readJsonStrict, writeJsonAtomic, ensureDir } = require('./json-file')

const ROOT_MANIFEST = 'manifest.json'

function deviceManifestPath(deviceId) {
  return `devices/${deviceId}/manifest.json`
}

function rootItemKey(deviceId, kind, id) {
  return `${deviceId}/${kind}/${id}`
}

function emptyRoot() {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: null, devices: {}, items: {} }
}

function emptyDevice(device) {
  return {
    schemaVersion: SCHEMA_VERSION,
    device: { id: device.id, name: device.name, platform: device.platform },
    updatedAt: null,
    items: {},
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Normalize one item record read from disk (defensive: archives are shared). */
function normalizeItem(raw, deviceId) {
  const item = asObject(raw)
  if (typeof item.kind !== 'string' || typeof item.id !== 'string') return null
  return {
    deviceId: typeof item.deviceId === 'string' ? item.deviceId : deviceId,
    kind: item.kind,
    id: item.id,
    title: typeof item.title === 'string' ? item.title : '',
    dir: typeof item.dir === 'string' ? item.dir : '',
    version: typeof item.version === 'string' ? item.version : '',
    hash: typeof item.hash === 'string' ? item.hash : '',
    eventCount: Number.isFinite(item.eventCount) ? item.eventCount : null,
    fileCount: Number.isFinite(item.fileCount) ? item.fileCount : null,
    sizeBytes: Number.isFinite(item.sizeBytes) ? item.sizeBytes : null,
    platform: typeof item.platform === 'string' ? item.platform : '',
    exportedAt: typeof item.exportedAt === 'string' ? item.exportedAt : '',
  }
}

function normalizeRoot(raw) {
  const source = asObject(raw)
  const devices = {}
  for (const [id, value] of Object.entries(asObject(source.devices))) {
    const entry = asObject(value)
    devices[id] = {
      id,
      name: typeof entry.name === 'string' ? entry.name : id,
      platform: typeof entry.platform === 'string' ? entry.platform : '',
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
      itemCount: Number.isFinite(entry.itemCount) ? entry.itemCount : 0,
    }
  }
  const items = {}
  for (const [key, value] of Object.entries(asObject(source.items))) {
    const item = normalizeItem(value, key.split('/')[0])
    if (item) items[key] = item
  }
  return {
    schemaVersion: Number.isFinite(source.schemaVersion) ? source.schemaVersion : SCHEMA_VERSION,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    devices,
    items,
  }
}

function normalizeDevice(raw, device) {
  const source = asObject(raw)
  const deviceSource = asObject(source.device)
  const items = {}
  for (const [key, value] of Object.entries(asObject(source.items))) {
    const item = normalizeItem(value, device.id)
    if (item) items[key] = item
  }
  return {
    schemaVersion: Number.isFinite(source.schemaVersion) ? source.schemaVersion : SCHEMA_VERSION,
    device: {
      id: device.id,
      name: typeof deviceSource.name === 'string' ? deviceSource.name : device.name,
      platform: typeof deviceSource.platform === 'string' ? deviceSource.platform : device.platform,
    },
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    items,
  }
}

/**
 * Read the root manifest. A present-but-unparsable manifest is an error: writing
 * over it would erase the other devices' entries.
 */
async function readRootManifest(sink) {
  const raw = await readJsonStrict(sink.resolve(ROOT_MANIFEST), '根 manifest')
  return raw === null ? emptyRoot() : normalizeRoot(raw)
}

async function readDeviceManifest(sink, device) {
  const raw = await readJsonStrict(sink.resolve(deviceManifestPath(device.id)), '设备 manifest')
  return raw === null ? emptyDevice(device) : normalizeDevice(raw, device)
}

/**
 * Fold one device's authoritative item set into the shared root manifest.
 * Pure function so the merge rules are unit-testable.
 *
 * Rules:
 *  - every root item owned by `deviceId` but absent from `items` is removed
 *    (the device deleted it);
 *  - every item in `items` is written under `<deviceId>/<kind>/<id>`;
 *  - items owned by other devices are never touched.
 */
function mergeDeviceIntoRoot(root, device, items, updatedAt) {
  const merged = normalizeRoot(root)
  merged.schemaVersion = SCHEMA_VERSION
  merged.updatedAt = updatedAt

  const prefix = `${device.id}/`
  for (const key of Object.keys(merged.items)) {
    if (!key.startsWith(prefix)) continue
    const suffix = key.slice(prefix.length)
    if (!Object.prototype.hasOwnProperty.call(items, suffix)) delete merged.items[key]
  }

  for (const [suffix, item] of Object.entries(items)) {
    const normalized = normalizeItem(item, device.id)
    if (!normalized) continue
    merged.items[`${prefix}${suffix}`] = { ...normalized, deviceId: device.id }
  }

  merged.devices[device.id] = {
    id: device.id,
    name: device.name,
    platform: device.platform,
    updatedAt,
    itemCount: Object.keys(items).length,
  }
  return merged
}

/**
 * Rebuild the shared index from the authoritative per-device manifests.
 *
 * The root manifest is a convenience index; `devices/<id>/manifest.json` is what
 * each device owns. When the root is unparsable this reconstructs an equivalent
 * document in memory so a single damaged shared file cannot hide every device or
 * block every upload.
 */
async function rebuildRootFromDevices(sink) {
  let root = emptyRoot()
  let entries = []
  try {
    entries = await sink.list('devices')
  } catch {
    return root
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const deviceId = entry.name
    try {
      const doc = await readJsonStrict(sink.resolve(deviceManifestPath(deviceId)), '设备 manifest')
      if (!doc) continue
      const normalized = normalizeDevice(doc, { id: deviceId, name: deviceId, platform: '' })
      root = mergeDeviceIntoRoot(
        root,
        normalized.device,
        normalized.items,
        normalized.updatedAt ?? root.updatedAt ?? new Date(0).toISOString(),
      )
    } catch {
      // A broken device manifest is reported on its own row, never fatal here.
    }
  }
  return root
}

/** Write the device manifest, then merge it into the root manifest. */
async function publishManifests(sink, device, items, now = () => Date.now()) {
  const updatedAt = new Date(now()).toISOString()
  const deviceDoc = {
    schemaVersion: SCHEMA_VERSION,
    device: { id: device.id, name: device.name, platform: device.platform },
    updatedAt,
    items,
  }
  await ensureDir(sink.resolve(`devices/${device.id}`))
  await writeJsonAtomic(sink.resolve(deviceManifestPath(device.id)), deviceDoc)

  // Own device manifest is already durable at this point, so a corrupt root can
  // be rebuilt from the device copies and rewritten instead of blocking uploads
  // forever.
  let root
  try {
    root = await readRootManifest(sink)
  } catch {
    root = await rebuildRootFromDevices(sink)
  }
  const merged = mergeDeviceIntoRoot(root, device, items, updatedAt)
  await writeJsonAtomic(sink.resolve(ROOT_MANIFEST), merged)
  return { device: deviceDoc, root: merged }
}

/**
 * Publish a single item without dropping the other items this device already
 * published. Exports run one at a time, but a session export must still not
 * erase the workspace entries written a moment earlier.
 */
async function publishItem(sink, device, key, item, now = () => Date.now()) {
  const current = await readDeviceManifest(sink, device)
  const items = { ...current.items, [key]: item }
  return publishManifests(sink, device, items, now)
}

/** Remove one item from this device's manifest and from the merged root. */
async function unpublishItem(sink, device, key, now = () => Date.now()) {
  const current = await readDeviceManifest(sink, device)
  if (!Object.prototype.hasOwnProperty.call(current.items, key)) {
    return { removed: false }
  }
  const items = { ...current.items }
  delete items[key]
  const published = await publishManifests(sink, device, items, now)
  return { removed: true, ...published }
}

/** Read every device manifest found on disk (plus the root view). */
async function readAllDevices(sink) {
  // The root is a shared index and can be damaged by an unrelated writer; the
  // per-device manifests are authoritative, so rebuild instead of failing the
  // whole listing.
  let root = emptyRoot()
  let rootCorrupt = false
  let rootError = null
  try {
    root = await readRootManifest(sink)
  } catch (error) {
    rootCorrupt = true
    rootError = error && error.message ? error.message : String(error)
    root = await rebuildRootFromDevices(sink)
  }
  const devices = new Map()
  for (const entry of await sink.list('devices')) {
    if (!entry.isDirectory()) continue
    const deviceId = entry.name
    // One unreadable device manifest must not hide every other device.
    let doc = null
    try {
      doc = await readJsonStrict(sink.resolve(deviceManifestPath(deviceId)), '设备 manifest')
    } catch (error) {
      devices.set(deviceId, {
        schemaVersion: SCHEMA_VERSION,
        device: { id: deviceId, name: deviceId, platform: '' },
        updatedAt: null,
        items: {},
        corrupt: true,
        error: error && error.message ? error.message : String(error),
        errorCode: error && error.code ? error.code : 'wps-sync/json-invalid',
      })
      continue
    }
    if (!doc) continue
    const normalized = normalizeDevice(doc, { id: deviceId, name: deviceId, platform: '' })
    devices.set(deviceId, normalized)
  }
  // Root entries for devices whose directory is missing still show up.
  for (const [key, item] of Object.entries(root.items)) {
    const deviceId = key.split('/')[0]
    if (devices.has(deviceId)) continue
    const device = root.devices[deviceId]
    devices.set(deviceId, {
      schemaVersion: SCHEMA_VERSION,
      device: { id: deviceId, name: device ? device.name : deviceId, platform: device ? device.platform : '' },
      updatedAt: device ? device.updatedAt : null,
      items: {},
    })
  }
  return { root, devices, rootCorrupt, rootError }
}

/** Item dir of one record, re-validated before use. */
function itemDirOf(record) {
  if (!record || typeof record.dir !== 'string' || !record.dir) {
    throw corrupt('清单条目缺少归档目录', 'wps-sync/manifest-incomplete')
  }
  return record.dir
}

module.exports = {
  ROOT_MANIFEST,
  deviceManifestPath,
  rootItemKey,
  emptyRoot,
  emptyDevice,
  normalizeRoot,
  normalizeDevice,
  normalizeItem,
  readRootManifest,
  readDeviceManifest,
  mergeDeviceIntoRoot,
  rebuildRootFromDevices,
  publishManifests,
  publishItem,
  unpublishItem,
  readAllDevices,
  itemDirOf,
  relative: path.posix,
}