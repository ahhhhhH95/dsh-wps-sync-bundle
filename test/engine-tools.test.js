'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')

const { SyncEngine } = require('../lib/engine')
const { createToolDefinitions } = require('../lib/tools')
const { createBridge } = require('../lib/bridge')
const {
  makeArchive,
  makeStore,
  tempDir,
  writeFile,
  fakeSessionQuery,
  sessionSnapshot,
} = require('./helpers')

const NOW = () => Date.parse('2026-03-04T05:06:07.000Z')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function buildEngine(overrides = {}) {
  const archive = await makeArchive()
  const workspaceRoot = await tempDir('wps-engine-ws-')
  await writeFile(path.join(workspaceRoot, 'readme.txt'), 'hello workspace')
  const stateDir = path.join(archive.base, 'state')
  const config = {
    syncRootDir: archive.syncRoot,
    autoSync: true,
    debounceMs: 0,
    workspaceScanIntervalSec: 0,
    ...overrides.config,
  }
  const services = {
    sessionQuery: fakeSessionQuery(sessionSnapshot('sess-1'), '引擎测试'),
    workspaceRegistry: {
      list: () => [{ id: 'ws-1', title: '引擎工作区', path: workspaceRoot, updatedAt: NOW() }],
    },
    schedule: {
      async catalog() {
        return [{ id: 'task-1', title: '每夜任务', kind: 'daily', scheduledAt: '2026-03-05T01:00:00.000Z', status: 'active' }]
      },
    },
    ...overrides.services,
  }
  const engine = new SyncEngine({ config, stateDir, services, now: NOW })
  await engine.init()
  await engine.start()
  // `start()` mirrors auto workspaces immediately, so let that startup pass settle
  // before a test starts asserting on the queue.
  await engine.queue.idle()
  return { engine, archive, workspaceRoot, stateDir }
}

test('engine status reports the sync root, items and the read-only import boundary', async () => {
  const { engine, archive } = await buildEngine()
  try {
    const status = await engine.status({ fresh: true })
    assert.equal(status.ok, true)
    assert.equal(status.syncRootDir, archive.syncRoot)
    assert.equal(status.syncRootValid, true)
    assert.equal(status.runtimeImportSupported, false)
    assert.equal(status.autoDefault, true)
    assert.ok(status.device.id)
    assert.deepEqual(status.counts.sessions, 1)
    assert.deepEqual(status.counts.workspaces, 1)
    assert.deepEqual(status.counts.tasks, 1)
    assert.ok(Array.isArray(status.queue.jobs))
    assert.ok(Array.isArray(status.errors))
    assert.ok(Array.isArray(status.imports))
    assert.ok(status.remote)
  } finally {
    await engine.stop()
  }
})

test('engine uploads a session, the task catalog and a workspace mirror', async () => {
  const { engine, archive, workspaceRoot } = await buildEngine()
  try {
    const session = await engine.upload('session', 'sess-1')
    assert.equal(session.status, 'uploaded')
    assert.ok(await fs.stat(path.join(archive.sink.rootDir, session.dir, 'session.jsonl')))

    const tasks = await engine.upload('tasks')
    assert.equal(tasks.status, 'uploaded')
    assert.ok(await fs.stat(path.join(archive.sink.rootDir, tasks.dir, 'scheduled-tasks.json')))

    const workspace = await engine.upload('workspace', 'ws-1')
    // The startup scan may already have mirrored it; a second call reports unchanged.
    assert.ok(['uploaded', 'unchanged'].includes(workspace.status))
    assert.ok(await fs.stat(path.join(archive.sink.rootDir, workspace.dir, 'files', 'readme.txt')))

    const items = await engine.listItems()
    assert.equal(items.counts.uploaded, 3)
    assert.equal(items.tasks.id, 'tasks:global')
  } finally {
    await engine.stop()
  }
})

test('turn/end debounces into one export and respects the auto flag', async () => {
  const { engine, archive } = await buildEngine()
  try {
    engine.handleTurnEnd('sess-1')
    await wait(30)
    await engine.queue.idle()
    const item = storeItem(engine, 'session:sess-1')
    assert.equal(item.lastResult, 'uploaded')

    await engine.setAuto('session', 'sess-1', false)
    assert.equal(engine.isAuto('session', 'sess-1'), false)
    const before = engine.queue.list().length
    engine.handleTurnEnd('sess-1')
    await wait(30)
    assert.equal(engine.queue.list().length, before, 'no job is queued while auto is off')

    await engine.setAuto('session', 'sess-1', true)
    engine.handleTurnEnd('sess-1')
    await wait(30)
    await engine.queue.idle()
    assert.ok(engine.queue.list().length > before)
    assert.ok(await fs.stat(path.join(archive.sink.rootDir, `conversations/${engine.store.device.id}`)))
  } finally {
    await engine.stop()
  }
})

test('schedule/changed exports the task catalog when tasks are on auto', async () => {
  const { engine, archive } = await buildEngine()
  try {
    await engine.setAuto('tasks', 'tasks:global', false)
    engine.handleScheduleChanged()
    await wait(30)
    assert.equal(engine.queue.pending, 0)

    await engine.setAuto('tasks', 'tasks:global', true)
    engine.handleScheduleChanged()
    await wait(30)
    await engine.queue.idle()
    const record = storeItem(engine, 'tasks:global')
    assert.equal(record.lastResult, 'uploaded')
    assert.ok(await fs.stat(path.join(archive.sink.rootDir, record.dir, 'scheduled-tasks.json')))
  } finally {
    await engine.stop()
  }
})

test('setRoot validates and records the chosen sync root', async () => {
  const { engine } = await buildEngine()
  try {
    await assert.rejects(() => engine.setRoot('relative/path'), (error) => error.code === 'wps-sync/root-invalid')
    await assert.rejects(() => engine.setRoot(''), (error) => error.code === 'wps-sync/root-invalid')
    const moved = await tempDir('wps-new-root-')
    const result = await engine.setRoot(moved)
    assert.equal(result.syncRootDir, path.resolve(moved))
    assert.equal(result.configPersisted, false, 'no config editor in this fake context')
    const status = await engine.status({ fresh: true })
    assert.equal(status.syncRootDir, path.resolve(moved))
  } finally {
    await engine.stop()
  }
})

test('the seven tools expose strict argument validation and a renderable output', async () => {
  const { engine } = await buildEngine()
  try {
    const tools = createToolDefinitions(engine)
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['wps_sync_list', 'wps_sync_pull', 'wps_sync_remote_list', 'wps_sync_restore', 'wps_sync_set_auto', 'wps_sync_status', 'wps_sync_upload'],
    )
    for (const tool of tools) {
      assert.equal(tool.parameters.type, 'object')
      assert.equal(tool.parameters.additionalProperties, false)
      assert.equal(typeof tool.output.render, 'function')
      const rendered = tool.output.render({}, { ok: true })
      assert.equal(rendered[0].type, 'text')
      assert.match(rendered[0].text, /ok/)
      assert.equal(typeof tool.execute, 'function')
    }

    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    const status = await byName.wps_sync_status.execute({})
    assert.equal(status.ok, true)
    assert.equal(status.runtimeImportSupported, false)

    const listed = await byName.wps_sync_list.execute({ kind: 'session', limit: 10 })
    assert.equal(listed.kind, 'session')
    assert.ok(Array.isArray(listed.items))
    assert.equal(listed.counts.sessions, 1)

    await assert.rejects(() => byName.wps_sync_status.execute({ oops: 1 }), /不支持的参数/)
    await assert.rejects(() => byName.wps_sync_upload.execute({ kind: 'nope' }), /必须是/)
    await assert.rejects(() => byName.wps_sync_upload.execute({}), /缺少必填参数 kind/)
    await assert.rejects(
      () => byName.wps_sync_restore.execute({ importId: 'x', targetDir: 'relative/dir' }),
      /targetDir 必须是绝对路径/,
    )
    await assert.rejects(() => byName.wps_sync_set_auto.execute({ kind: 'session', auto: 'yes' }), /必须是布尔值/)

    const uploaded = await byName.wps_sync_upload.execute({ kind: 'tasks' })
    assert.equal(uploaded.status, 'uploaded')
  } finally {
    await engine.stop()
  }
})

test('bridge serves status over HTTP with a token and rejects bad tokens', async () => {
  const { engine } = await buildEngine()
  try {
    const bridge = createBridge({ engine })
    const response = await invoke(bridge.httpRoute.handler, {
      method: 'GET',
      url: '/api/wps-sync/state',
      headers: { host: '127.0.0.1:51287' },
    })
    assert.equal(response.status, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.token, bridge.token)
    assert.equal(body.ok, true)
    assert.equal(body.runtimeImportSupported, false)
    assert.ok(body.remote)
    assert.ok(Array.isArray(body.items))

    const denied = await invoke(bridge.httpRoute.handler, {
      method: 'POST',
      url: '/api/wps-sync/upload',
      headers: { host: '127.0.0.1:51287', 'content-type': 'application/json', origin: 'http://127.0.0.1:51287', 'x-wps-sync-token': 'f'.repeat(64) },
      body: { kind: 'tasks' },
    })
    assert.equal(denied.status, 403)

    const uploaded = await invoke(bridge.httpRoute.handler, {
      method: 'POST',
      url: '/api/wps-sync/upload',
      headers: {
        host: '127.0.0.1:51287',
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:51287',
        'x-wps-sync-token': bridge.token,
      },
      body: { kind: 'tasks' },
    })
    assert.equal(uploaded.status, 200)
    assert.equal(JSON.parse(uploaded.body).result.status, 'uploaded')

    const foreignHost = await invoke(bridge.httpRoute.handler, {
      method: 'GET',
      url: '/api/wps-sync/state',
      headers: { host: 'evil.example.com' },
    })
    assert.equal(foreignHost.status, 403)
  } finally {
    await engine.stop()
  }
})

test('bridge rpc answers a client-request envelope', async () => {
  const { engine } = await buildEngine()
  try {
    const bridge = createBridge({ engine, admit: () => {} })
    const response = await invoke(bridge.rpcRoute.handler, {
      method: 'POST',
      url: '/wps-sync/request',
      headers: { host: '127.0.0.1:51287', 'content-type': 'application/json', origin: 'http://127.0.0.1:51287' },
      body: { type: 'client-request', method: 'request', rpcId: 'r1', payload: { action: 'status', args: {} } },
    })
    assert.equal(response.status, 200)
    const envelope = JSON.parse(response.body)
    assert.equal(envelope.type, 'server-response')
    assert.equal(envelope.rpcId, 'r1')
    assert.equal(envelope.result.ok, true)
    assert.equal(envelope.result.value.runtimeImportSupported, false)
  } finally {
    await engine.stop()
  }
})

test('bridge rpc requires the token when the connection offers no admission', async () => {
  const { engine } = await buildEngine()
  try {
    const bridge = createBridge({ engine })
    const anonymous = await invoke(bridge.rpcRoute.handler, {
      method: 'POST',
      url: '/wps-sync/request',
      headers: { host: '127.0.0.1:51287', 'content-type': 'application/json', origin: 'http://127.0.0.1:51287' },
      body: { type: 'client-request', method: 'request', rpcId: 'r2', payload: { action: 'status', args: {} } },
    })
    assert.equal(anonymous.status, 403)

    const authorized = await invoke(bridge.rpcRoute.handler, {
      method: 'POST',
      url: '/wps-sync/request',
      headers: {
        host: '127.0.0.1:51287',
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:51287',
        'x-wps-sync-token': bridge.token,
      },
      body: { type: 'client-request', method: 'request', rpcId: 'r3', payload: { action: 'status', args: {} } },
    })
    assert.equal(authorized.status, 200)
    assert.equal(JSON.parse(authorized.body).rpcId, 'r3')

    const admittedButWrongToken = await invoke(createBridge({ engine, admit: () => {} }).rpcRoute.handler, {
      method: 'POST',
      url: '/wps-sync/request',
      headers: {
        host: '127.0.0.1:51287',
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:51287',
        'x-wps-sync-token': 'a'.repeat(64),
      },
      body: { type: 'client-request', method: 'request', rpcId: 'r4', payload: { action: 'status', args: {} } },
    })
    assert.equal(admittedButWrongToken.status, 403)
  } finally {
    await engine.stop()
  }
})

test('bridge rpc accepts the bearer inside the payload, like the shipped client', async () => {
  const { engine } = await buildEngine()
  try {
    const bridge = createBridge({ engine })
    const accepted = await invoke(bridge.rpcRoute.handler, {
      method: 'POST',
      url: '/wps-sync/request',
      headers: { host: '127.0.0.1:51287', 'content-type': 'application/json', origin: 'http://127.0.0.1:51287' },
      body: {
        type: 'client-request',
        method: 'request',
        rpcId: 'r5',
        payload: { action: 'list', args: {}, token: bridge.token },
      },
    })
    assert.equal(accepted.status, 200)
    const envelope = JSON.parse(accepted.body)
    assert.equal(envelope.result.ok, true)
    assert.equal(envelope.result.value.counts.sessions, 1)
    assert.equal(envelope.result.value.token, undefined, 'the status payload never leaks the bearer')
  } finally {
    await engine.stop()
  }
})

test('start mirrors immediately, keeps a periodic timer and clears it on stop', async () => {
  const archive = await makeArchive()
  const workspaceRoot = await tempDir('wps-engine-start-')
  await writeFile(path.join(workspaceRoot, 'first.txt'), 'first')
  const timers = []
  const cleared = []
  const engine = new SyncEngine({
    config: {
      syncRootDir: archive.syncRoot,
      autoSync: true,
      debounceMs: 0,
      workspaceScanIntervalSec: 60,
    },
    stateDir: path.join(archive.base, 'state'),
    services: {
      sessionQuery: fakeSessionQuery(sessionSnapshot('sess-1'), '启动测试'),
      workspaceRegistry: {
        list: () => [{ id: 'ws-1', title: '启动工作区', path: workspaceRoot, updatedAt: NOW() }],
      },
      setInterval: (callback, delay) => {
        timers.push({ callback, delay })
        return () => cleared.push(delay)
      },
    },
    now: NOW,
  })
  try {
    await engine.init()
    await engine.start()

    assert.equal(timers.length, 1, 'start registers exactly one periodic scan timer')
    assert.equal(timers[0].delay, 60000, 'the 60s default maps to a 60s timer')
    assert.equal(cleared.length, 0)

    // Startup must not wait for the first tick: the mirror is already written.
    await engine.queue.idle()
    const mirror = path.join(archive.sink.rootDir, 'workspaces')
    const deviceDirs = await fs.readdir(mirror)
    assert.equal(deviceDirs.length, 1)
    const [workspaceDir] = await fs.readdir(path.join(mirror, deviceDirs[0]))
    assert.ok(workspaceDir.startsWith('启动工作区-ws-1'))
    assert.equal(
      await fs.readFile(path.join(mirror, deviceDirs[0], workspaceDir, 'files', 'first.txt'), 'utf8'),
      'first',
    )

    // A tick picks up new files without any manual call.
    await writeFile(path.join(workspaceRoot, 'second.txt'), 'second')
    timers[0].callback()
    await engine.queue.idle()
    assert.equal(
      await fs.readFile(path.join(mirror, deviceDirs[0], workspaceDir, 'files', 'second.txt'), 'utf8'),
      'second',
    )
  } finally {
    await engine.stop()
  }
  assert.deepEqual(cleared, [60000], 'stop clears the scan timer')
})

test('a failing timer registration is recorded instead of vanishing', async () => {
  const archive = await makeArchive()
  const workspaceRoot = await tempDir('wps-engine-timer-fail-')
  await writeFile(path.join(workspaceRoot, 'kept.txt'), 'kept')
  const engine = new SyncEngine({
    config: { syncRootDir: archive.syncRoot, autoSync: true, debounceMs: 0, workspaceScanIntervalSec: 60 },
    stateDir: path.join(archive.base, 'state'),
    services: {
      sessionQuery: fakeSessionQuery(sessionSnapshot('sess-1'), '计时器失败'),
      workspaceRegistry: {
        list: () => [{ id: 'ws-1', title: '失败工作区', path: workspaceRoot, updatedAt: NOW() }],
      },
      setInterval: () => {
        const error = new Error('cannot get property "timer" without inject')
        error.code = 'wps-sync/timer-unavailable'
        throw error
      },
    },
    now: NOW,
  })
  try {
    await engine.init()
    await engine.start()

    const errors = engine.store.data.errors
    assert.equal(errors.length, 1, 'the failure is recorded, never silently dropped')
    assert.equal(errors[0].code, 'wps-sync/timer-unavailable')
    assert.equal(errors[0].key, 'workspace-scan')
    // The startup scan still ran, so one broken timer cannot hide the mirror.
    await engine.queue.idle()
    const status = await engine.status({ fresh: true })
    assert.equal(status.counts.uploaded, 1)
  } finally {
    await engine.stop()
  }
})

function storeItem(engine, key) {
  const record = engine.store.getItem(key)
  assert.ok(record, `missing item ${key}`)
  return record
}

/** Minimal request/response doubles for the bridge handlers. */
function invoke(handler, request) {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
    const req = {
      method: request.method ?? 'GET',
      url: request.url,
      headers,
      on(event, listener) {
        if (event !== 'data' && event !== 'end' && event !== 'error') return req
        if (event === 'data' && request.body !== undefined) {
          const buffer = Buffer.from(typeof request.body === 'string' ? request.body : JSON.stringify(request.body), 'utf8')
          setTimeout(() => listener(buffer), 0)
        }
        if (event === 'end' && request.body !== undefined) setTimeout(() => listener(), 0)
        return req
      },
    }
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      writeHead(status, extra) {
        this.statusCode = status
        Object.assign(this.headers, extra ?? {})
        return this
      },
      end(chunk) {
        if (chunk !== undefined) this.body += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        resolve({ status: this.statusCode, headers: this.headers, body: this.body })
        return this
      },
    }
    try {
      const result = handler(req, res)
      if (result && typeof result.then === 'function') result.catch(reject)
    } catch (error) {
      reject(error)
    }
  })
}