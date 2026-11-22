'use strict'

/** Shared helpers for the WPS sync tests (no real sessions, no WPS folder). */

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs/promises')

const { StateStore } = require('../lib/store')
const { LocalDirSink } = require('../lib/sink')
const { normalizeConfig } = require('../lib/config')

async function tempDir(prefix = 'wps-sync-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function makeStore(dir, deviceName = 'test-device') {
  const store = new StateStore({ dir, deviceName })
  await store.load()
  return store
}

/** One archive root shared by several simulated devices. */
async function makeArchive() {
  const base = await tempDir()
  const syncRoot = path.join(base, 'WPS Cloud Files')
  await fs.mkdir(syncRoot, { recursive: true })
  const sink = new LocalDirSink({ rootDir: path.join(syncRoot, 'DSH-Sync') })
  await sink.ensure()
  return { base, syncRoot, sink }
}

function makeConfig(overrides = {}) {
  return normalizeConfig(overrides)
}

async function writeFile(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text, 'utf8')
}

/**
 * A fake `ctx.sessionQuery` with one snapshot.
 *
 * `readTitleSnapshots` answers with the REAL Host observation shape
 * `{sessionId, status:'fulfilled', value:{session, title?:{title}}}` — tests
 * that accept a bare `{sessionId, title}` string would hide a wiring bug.
 */
function fakeSessionQuery(snapshot, title) {
  return {
    async readSession(sessionId) {
      if (snapshot.session.id !== sessionId) throw new Error(`unknown session ${sessionId}`)
      return snapshot
    },
    async readTitle() {
      return null
    },
    async listSessions() {
      return [{ header: snapshot.session, live: false, persisted: true }]
    },
    async readTitleSnapshots(ids) {
      return ids.map((id) => ({
        sessionId: id,
        status: 'fulfilled',
        value: { session: snapshot.session, title: title ? { title } : undefined },
      }))
    },
  }
}

function sessionSnapshot(sessionId = 'sess-abc123') {
  const events = [
    {
      type: 'user/message',
      seq: 1,
      time: 1_700_000_000_000,
      data: { id: 'm1', role: 'user', content: [{ type: 'text', text: '把这份报告同步到 WPS。' }] },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: 1_700_000_001_000,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: '已经写入 DSH-Sync。' }] },
      },
    },
    { type: 'turn/end', seq: 3, time: 1_700_000_002_000, data: { turn: 1, reason: { kind: 'complete' } } },
  ]
  return {
    session: { version: 4, id: sessionId, createdAt: 1_700_000_000_000, cwd: 'C:/work/demo', isSeeded: false },
    inheritedEventCount: 0,
    events,
  }
}

module.exports = {
  tempDir,
  makeStore,
  makeArchive,
  makeConfig,
  writeFile,
  fakeSessionQuery,
  sessionSnapshot,
}