'use strict'

/**
 * Session export: one session becomes
 *
 *   conversations/<deviceId>/<slug>-<sessionId>/
 *     session.jsonl     replayable log (header line + every event)
 *     transcript.md     human readable Markdown
 *     meta.json         what this export is, plus per-file hashes
 *
 * The export is derived from a single `ctx.sessionQuery.readSession` snapshot,
 * so the plugin never writes to a session log and never races a live turn.
 */

const { nameWithId } = require('./paths')
const { hashFiles, hashBuffer } = require('./hash')
const { renderTranscript } = require('./transcript')
const { publishItem } = require('./manifest')
const { itemKey } = require('./store')
const { SCHEMA_VERSION, PLUGIN_NAME } = require('./constants')
const { notReady } = require('./errors')

/** Title out of one `readTitleSnapshots` observation (real Host shape). */
function pickTitle(node) {
  if (!node) return null
  if (typeof node === 'string') return node.trim() || null
  if (typeof node !== 'object') return null
  if (typeof node.title === 'string' && node.title.trim()) return node.title.trim()
  if (node.title && typeof node.title === 'object' && typeof node.title.title === 'string' && node.title.title.trim()) {
    return node.title.title.trim()
  }
  return null
}

/**
 * The Host answers `readTitleSnapshots` with observations shaped like
 * `{sessionId, status:'fulfilled', value:{session, title?:{title}}}` (a
 * rejected observation carries no value at all).
 */
function titleFromObservation(entry) {
  if (!entry || typeof entry !== 'object') return pickTitle(entry)
  if (entry.status === 'rejected') return null
  return pickTitle(entry.value) ?? pickTitle(entry)
}

async function resolveTitle(sessionQuery, sessionId, events) {
  if (sessionQuery && typeof sessionQuery.readTitleSnapshots === 'function') {
    try {
      const observations = await sessionQuery.readTitleSnapshots([sessionId])
      const list = Array.isArray(observations) ? observations : [observations]
      for (const entry of list) {
        if (entry && typeof entry === 'object' && typeof entry.sessionId === 'string' && entry.sessionId !== sessionId) continue
        const title = titleFromObservation(entry)
        if (title) return title
      }
    } catch {
      /* title is best effort */
    }
  }
  try {
    if (typeof sessionQuery.readTitle === 'function') {
      const value = await sessionQuery.readTitle(sessionId)
      const title = pickTitle(value) ?? (value && typeof value.title === 'string' ? value.title.trim() : null)
      if (title) return title
    }
  } catch {
    /* title is best effort */
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && event.type === 'session/title' && event.data && typeof event.data.title === 'string' && event.data.title.trim()) {
      return event.data.title.trim()
    }
  }
  return ''
}

function lastSeqOf(events) {
  let seq = null
  for (const event of events) {
    if (event && Number.isFinite(event.seq) && (seq === null || event.seq > seq)) seq = event.seq
  }
  return seq
}

function serializeLog(header, events) {
  const lines = []
  if (!(events[0] && events[0].type === 'session')) {
    lines.push(JSON.stringify({ type: 'session', ...header }))
  }
  for (const event of events) lines.push(JSON.stringify(event))
  return `${lines.join('\n')}\n`
}

/**
 * @param {{sink: object, store: object, device: object, sessionQuery: object, sessionId: string, force?: boolean, now?: () => number}} options
 */
async function exportSession(options) {
  const { sink, store, device, sessionQuery, sessionId, force = false } = options
  const now = options.now ?? (() => Date.now())
  if (!sessionQuery || typeof sessionQuery.readSession !== 'function') {
    throw notReady('会话查询服务不可用', 'wps-sync/no-session-query')
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw notReady('缺少会话 ID', 'wps-sync/no-session-id')
  }

  const snapshot = await sessionQuery.readSession(sessionId)
  const header = (snapshot && (snapshot.session || snapshot.header)) || {}
  const events = Array.isArray(snapshot && snapshot.events) ? snapshot.events : []
  const title = (await resolveTitle(sessionQuery, sessionId, events)) || `会话 ${String(sessionId).slice(0, 8)}`
  const exportedAt = new Date(now()).toISOString()
  const dir = `conversations/${device.id}/${nameWithId(title, sessionId, 'session')}`

  const logText = serializeLog(header, events)
  const logBuffer = Buffer.from(logText, 'utf8')
  // `exportedAt` is deliberately NOT part of the rendered content: the hash is
  // computed over content only, so two exports of unchanged events hash equal
  // even hours apart. The timestamp lives in meta.json.
  const transcriptText = renderTranscript({ header, events, title, device })
  const transcriptBuffer = Buffer.from(transcriptText, 'utf8')

  const files = [
    { path: 'session.jsonl', bytes: logBuffer.length, hash: hashBuffer(logBuffer) },
    { path: 'transcript.md', bytes: transcriptBuffer.length, hash: hashBuffer(transcriptBuffer) },
  ]
  const hash = hashFiles(files)
  const lastEventSeq = lastSeqOf(events)

  const existing = store.getItem(itemKey('session', sessionId))
  if (!force && existing && existing.lastHash === hash && existing.dir === dir) {
    // Fast path only when the archive is genuinely still there.
    const present = await sink.stat(`${dir}/session.jsonl`)
    if (present && present.isFile) {
      store.recordResult('session', sessionId, { status: 'unchanged', hash, lastEventSeq, dir, title })
      await store.save()
      return { status: 'unchanged', kind: 'session', id: sessionId, title, dir, hash, eventCount: events.length }
    }
  }

  await sink.ensure()
  await sink.write(`${dir}/session.jsonl`, logBuffer)
  await sink.write(`${dir}/transcript.md`, transcriptBuffer)

  const sizeBytes = files.reduce((total, file) => total + file.bytes, 0)
  const meta = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'session',
    id: sessionId,
    title,
    dir,
    device: { id: device.id, name: device.name, platform: device.platform },
    exportedAt,
    hash,
    eventCount: events.length,
    lastEventSeq,
    sizeBytes,
    files,
    session: {
      version: header.version ?? null,
      createdAt: header.createdAt ?? null,
      cwd: header.cwd ?? null,
      parentSession: header.parentSession ?? null,
      agentPreset: header.agentPreset ?? null,
      isSeeded: header.isSeeded ?? null,
    },
    source: { plugin: PLUGIN_NAME, schema: 'session/v1' },
  }
  await sink.writeJson(`${dir}/meta.json`, meta)

  const item = {
    deviceId: device.id,
    kind: 'session',
    id: sessionId,
    title,
    dir,
    // Content-addressed: identical content always advertises the same version,
    // so a pull of unchanged bytes stays idempotent across devices/时间.
    version: hash,
    hash,
    eventCount: events.length,
    fileCount: files.length,
    sizeBytes,
    platform: device.platform,
    exportedAt,
  }
  await publishItem(sink, device, `session/${sessionId}`, item, now)

  store.recordResult('session', sessionId, { status: 'uploaded', hash, lastEventSeq, dir, title })
  store.data.counters.uploads += 1
  await store.save()

  return { status: 'uploaded', kind: 'session', id: sessionId, title, dir, hash, eventCount: events.length, sizeBytes }
}

module.exports = { exportSession, resolveTitle, serializeLog, lastSeqOf }