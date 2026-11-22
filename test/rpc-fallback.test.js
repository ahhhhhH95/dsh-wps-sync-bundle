'use strict'

/**
 * The `/wps-sync` carrier, exercised against a mock route table.
 *
 * Defect B on the live desktop host: `GET /api/wps-sync/state` answered 200 from
 * this plugin's own HTTP route, while every `/wps-sync*` request fell through to
 * the route table default (empty 404 for GET, empty 405 for POST, no
 * `content-type`). `/wps-sync` was in no table at all, so the RPC channel simply
 * did not exist for the renderer.
 *
 * The registration gate that caused it (`if (hasConnectionRpc()) return`, probing
 * `ctx.get('connection')?.rpc?.handle`) is gone. These cases pin the replacement
 * contract:
 *
 *   A. connection registered with `admit` only, no `rpc`/`fetch`  -> both routes mounted
 *   B. `ctx.get('connection')` throws (service not injected)      -> both routes mounted
 *   C. connection really has `rpc.handle`                          -> host channel only,
 *      no fallback, no duplicate throw; if `handle` throws the fallback is re-mounted
 *      so the prefix stays served exactly once and the fiber stays alive.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const entry = require('../index')
const { RPC_CHANNEL, HTTP_PREFIX } = require('../lib/constants')

/** A route table with the shipped semantics (`dsh-host-webserver/src/index.ts:440-452,648-661`). */
function makeWebServer() {
  const exact = new Map()
  const prefixes = new Map()
  const calls = []
  const webServer = {
    calls,
    exact,
    prefixes,
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      // "Duplicate (kind, path) throws" — the shipped table refuses a taken path.
      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      calls.push({ kind: route.kind, path: route.path })
      table.set(route.path, route)
      return () => {
        if (table.get(route.path) === route) table.delete(route.path)
      }
    },
    /** Exact first, then the longest matching prefix, then nothing. */
    match(pathname) {
      if (exact.has(pathname)) return exact.get(pathname)
      let best
      for (const [prefix, route] of prefixes) {
        if (pathname !== prefix && !pathname.startsWith(prefix + '/')) continue
        if (best === undefined || prefix.length > best.path.length) best = route
      }
      return best
    },
  }
  return webServer
}

function fakeCtx(services, { getThrows = false } = {}) {
  const effects = []
  const injected = []
  const tools = []
  const ctx = {
    get: (name) => {
      if (getThrows) throw new Error(`cannot get "${name}" without inject`)
      return services[name]
    },
    on: () => () => {},
    effect: (fn) => {
      const dispose = fn()
      effects.push(dispose)
      return () => {}
    },
    inject: (names, callback) => {
      injected.push({ names, callback })
    },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
    },
    fiber: { entry: { id: 'wps-sync' } },
  }
  return { ctx, effects, injected, tools }
}

/**
 * The owner surface a Cordis injection callback receives.
 *
 * `effectThrows(index)` lets a case model `owner.effect()` itself failing with
 * `cannot create effect on inactive context` (cordis `fiber.ts:172`), which is a
 * different failure from `register()` throwing inside an established effect.
 */
function ownerFor(webServer, services, { effectThrows = () => false, stripWebServer = false } = {}) {
  const disposers = []
  let calls = 0
  const owner = {
    effect: (fn) => {
      const index = calls
      calls += 1
      if (effectThrows(index)) {
        const error = new Error('cannot create effect on inactive context')
        error.code = 'INACTIVE_EFFECT'
        throw error
      }
      const dispose = fn()
      disposers.push(dispose)
      return () => {}
    },
    get webServer() {
      // Measured live: the `connection` injection's owner does not inject
      // webServer, so touching it throws instead of returning the service.
      if (stripWebServer) throw new Error('cannot get property "webServer" without inject')
      return webServer
    },
    get connection() {
      return services.connection
    },
  }
  return { owner, disposers }
}

/** The diagnostics outlet, read the way the host reads it: one `wps_sync_status` call. */
async function statusOf(tools) {
  const definition = tools.find((tool) => tool.name === 'wps_sync_status')
  assert.ok(definition, 'the status tool must be registered')
  return definition.execute({})
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A fresh module instance.
 *
 * `index.js` caches the "this host's `connection.rpc` cannot mount" measurement
 * at module scope on purpose (a reload must not pay for the same known failure
 * again), so cases that need that cache cold have to reload the module.
 */
function freshEntry() {
  const resolved = require.resolve('../index')
  delete require.cache[resolved]
  return require('../index')
}

/** Set `DSH_WPS_SYNC_ROUTE_ABSENT_GRACE_MS` for one case; `index.js` reads it per apply. */
async function withGrace(ms, fn) {
  const previous = process.env.DSH_WPS_SYNC_ROUTE_ABSENT_GRACE_MS
  process.env.DSH_WPS_SYNC_ROUTE_ABSENT_GRACE_MS = String(ms)
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_WPS_SYNC_ROUTE_ABSENT_GRACE_MS
    else process.env.DSH_WPS_SYNC_ROUTE_ABSENT_GRACE_MS = previous
  }
}

/** node:http request/response doubles. */
function invoke(handler, request) {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(
      Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    )
    const req = {
      method: request.method ?? 'GET',
      url: request.url,
      headers,
      on(event, listener) {
        if (event !== 'data' && event !== 'end' && event !== 'error') return req
        if (event === 'data' && request.body !== undefined) {
          const buffer = Buffer.from(
            typeof request.body === 'string' ? request.body : JSON.stringify(request.body),
            'utf8',
          )
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
      },
      on() {},
      get writableEnded() {
        return false
      },
      get headersSent() {
        return false
      },
    }
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(reject)
  })
}

async function withStateDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wps-sync-rpc-'))
  const previous = process.env.DSH_WPS_SYNC_STATE_DIR
  process.env.DSH_WPS_SYNC_STATE_DIR = dir
  try {
    return await fn(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_WPS_SYNC_STATE_DIR
    else process.env.DSH_WPS_SYNC_STATE_DIR = previous
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function disposeAll(effects, disposers) {
  for (const dispose of disposers) if (typeof dispose === 'function') await dispose()
  for (const dispose of effects) if (typeof dispose === 'function') await dispose()
}

function rpcRequest(overrides = {}) {
  return {
    method: 'POST',
    url: `${RPC_CHANNEL}/request`,
    headers: {
      host: '127.0.0.1:53434',
      origin: 'http://127.0.0.1:53434',
      'content-type': 'application/json',
      ...overrides.headers,
    },
    body: JSON.stringify({
      type: 'client-request',
      method: 'request',
      rpcId: 'rpc-1',
      payload: { action: 'status', args: {} },
      ...overrides.payload,
    }),
  }
}

test('ctx A: a connection with only admit leaves the fallback mounted', async () => {
  await withStateDir(async () => {
    const webServer = makeWebServer()
    const services = { connection: { admit: () => undefined } }
    const { ctx, effects, injected } = fakeCtx(services)
    entry.apply(ctx, {})
    const { owner, disposers } = ownerFor(webServer, services)
    for (const { callback } of injected) callback(owner)

    assert.deepEqual(
      webServer.calls.map((call) => `${call.kind}:${call.path}`),
      [`prefix:${HTTP_PREFIX}`, `prefix:${RPC_CHANNEL}`],
      'the HTTP route and the RPC fallback are both registered on a connection without rpc.handle',
    )
    assert.ok(webServer.prefixes.has(RPC_CHANNEL))
    await disposeAll(effects, disposers)
  })
})

test('ctx B: a throwing ctx.get still mounts the fallback and fails admission closed', async () => {
  await withStateDir(async () => {
    const webServer = makeWebServer()
    // The service is not injected: reading it from the plugin context throws.
    const { ctx, effects, injected } = fakeCtx({}, { getThrows: true })
    entry.apply(ctx, {})
    const { owner, disposers } = ownerFor(webServer, {})
    assert.doesNotThrow(() => {
      for (const { callback } of injected) callback(owner)
    })
    assert.deepEqual(
      webServer.calls.map((call) => `${call.kind}:${call.path}`),
      [`prefix:${HTTP_PREFIX}`, `prefix:${RPC_CHANNEL}`],
      'an uninjectable service must not gate the carrier that is actually served',
    )

    // Fail closed: with admission unable to confirm the connection, the RPC face
    // refuses rather than serving unauthenticated. This is the :168 branch, not a
    // reason to relax anything: a renderer request carries the host cookie, and a
    // cookie-less one is meant to be refused.
    const route = webServer.match(`${RPC_CHANNEL}/request`)
    assert.equal(typeof route.handler, 'function')
    const response = await invoke(route.handler, rpcRequest())
    assert.equal(response.status, 403)
    const body = JSON.parse(response.body)
    assert.equal(body.result.ok, false)
    assert.equal(body.result.error.code, 'wps-sync/forbidden-connection')
    assert.equal(response.headers['access-control-allow-origin'], undefined)
    await disposeAll(effects, disposers)
  })
})

test('ctx C: a real rpc.handle owns the prefix and the fallback yields without throwing', async () => {
  await withStateDir(async () => {
    const webServer = makeWebServer()
    const channels = []
    let mountedHandler
    const connection = {
      admit: () => undefined,
      rpc: {
        handle: (channel, handler) => {
          channels.push(channel)
          mountedHandler = handler
          return webServer.register({ kind: 'prefix', path: channel, handler })
        },
      },
      fetch: { register: () => () => {} },
    }
    const services = { connection }
    const { ctx, effects, injected } = fakeCtx(services)
    entry.apply(ctx, {})
    const { owner, disposers } = ownerFor(webServer, services)
    assert.doesNotThrow(() => {
      for (const { callback } of injected) callback(owner)
    })

    assert.deepEqual(channels, [RPC_CHANNEL], 'the host channel is mounted exactly once')
    assert.deepEqual(
      webServer.calls.map((call) => `${call.kind}:${call.path}`),
      [`prefix:${HTTP_PREFIX}`, `prefix:${RPC_CHANNEL}`, `prefix:${RPC_CHANNEL}`],
      'the fallback mounts unconditionally first, then hands the same path to the host channel',
    )
    assert.equal(
      webServer.prefixes.get(RPC_CHANNEL).handler,
      mountedHandler,
      'the mounted handler is the one handed to connection.rpc.handle, not a second local route',
    )
    await disposeAll(effects, disposers)
    assert.equal(webServer.prefixes.has(RPC_CHANNEL), false, 'unload releases the host channel route')
  })
})

test('ctx C throwing handle: the fallback is re-mounted, served once, and never kills the fiber', async () => {
  await withStateDir(async () => {
    const webServer = makeWebServer()
    const connection = {
      admit: () => undefined,
      rpc: {
        handle: () => {
          throw new Error('webserver: duplicate prefix route "/wps-sync"')
        },
      },
    }
    const services = { connection }
    const { ctx, effects, injected } = fakeCtx(services)
    entry.apply(ctx, {})
    const { owner, disposers } = ownerFor(webServer, services)
    assert.doesNotThrow(() => {
      for (const { callback } of injected) callback(owner)
    })

    const owned = [...webServer.prefixes.keys()].filter((key) => key === RPC_CHANNEL)
    assert.equal(owned.length, 1, 'the prefix is served exactly once even after a failed handover')
    assert.notEqual(webServer.prefixes.get(RPC_CHANNEL).handler, undefined)
    await disposeAll(effects, disposers)
  })
})

test('a handover owner that cannot see webServer still leaves the fallback serving (live host shape)', async () => {
  await withStateDir(async () => {
    const webServer = makeWebServer()
    // Measured on the live host: `connection.rpc.handle` itself throws
    // `cannot get property "webServer" without inject`, because the connection
    // service's context cannot register on the webServer. The fallback must then
    // be re-mounted through the webServer injection's owner, which is the only
    // owner allowed to touch webServer.
    const connection = {
      admit: () => undefined,
      rpc: {
        handle: () => {
          throw new Error('cannot get property "webServer" without inject')
        },
      },
      fetch: { register: () => () => {} },
    }
    const services = { connection }
    const { ctx, effects, injected, tools } = fakeCtx(services)
    entry.apply(ctx, {})

    const webServerInject = injected.find((entryItem) => entryItem.names.includes('webServer'))
    const connectionInject = injected.find((entryItem) => entryItem.names.includes('connection'))
    assert.ok(webServerInject && connectionInject, 'both injection sites must exist')

    const { owner: fullOwner, disposers } = ownerFor(webServer, services)
    const { owner: strippedOwner } = ownerFor(webServer, services, { stripWebServer: true })
    assert.doesNotThrow(() => webServerInject.callback(fullOwner))
    assert.doesNotThrow(
      () => connectionInject.callback(strippedOwner),
      'a handover failure must never escape the connection injection',
    )

    assert.ok(webServer.prefixes.has(RPC_CHANNEL), 'the fallback is still mounted after a failed handover')
    const status = await statusOf(tools)
    assert.equal(status.routes.rpc, 'mounted', 're-mounting through the webServer owner restores the channel')
    // A handover that fell back to our own route is expected on this host, and it
    // recovered: it belongs in the diagnostics, never in the user-visible errors.
    assert.equal(
      (status.errors ?? []).some((error) => /^wps-sync\/route-/.test(error.code)),
      false,
      'a recovered handover must not look like a fault on the panel',
    )
    const history = status.routes.history ?? []
    assert.ok(
      history.some((line) => line.includes('wps-sync/route-rpc-handover-failed')),
      'the handover record is still available through routes.history',
    )

    const response = await invoke(webServer.match(`${RPC_CHANNEL}/request`).handler, rpcRequest())
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(response.body).result.value.plugin, 'dsh-wps-sync-bundle')
    await disposeAll(effects, disposers)
  })
})

test('the self-probe uses the server origin verbatim (no doubled scheme) and confirms mounted', async () => {
  await withStateDir(async () => {
    const webServer = makeWebServer()
    // Shipped host shape: `getOrigin()` already returns the full origin.
    webServer.protocol = 'http:'
    webServer.port = 53434
    webServer.getOrigin = () => 'http://127.0.0.1:53434'
    const seen = []
    const realFetch = global.fetch
    global.fetch = async (url) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    try {
      const services = { connection: { admit: () => undefined } }
      const { ctx, effects, injected, tools } = fakeCtx(services)
      entry.apply(ctx, {})
      const { owner, disposers } = ownerFor(webServer, services)
      assert.doesNotThrow(() => {
        for (const { callback } of injected) callback(owner)
      })
      await sleep(1500)

      assert.deepEqual(
        seen,
        [`http://127.0.0.1:53434${HTTP_PREFIX}/state`],
        'the probe must compose the address exactly once',
      )
      const status = await statusOf(tools)
      assert.equal(status.routes.http, 'mounted', 'a 200 from our own route keeps the state mounted')
      await disposeAll(effects, disposers)
    } finally {
      global.fetch = realFetch
    }
  })
})

test('an unreachable self-probe reports failed without disturbing the RPC fallback', async () => {
  await withStateDir(async () => {
    const webServer = makeWebServer()
    webServer.protocol = 'http:'
    webServer.port = 53434
    webServer.getOrigin = () => 'http://127.0.0.1:53434'
    const realFetch = global.fetch
    global.fetch = async () => {
      throw new Error('The operation was aborted due to timeout')
    }
    try {
      const services = { connection: { admit: () => undefined } }
      const { ctx, effects, injected, tools } = fakeCtx(services)
      entry.apply(ctx, {})
      const { owner, disposers } = ownerFor(webServer, services)
      assert.doesNotThrow(() => {
        for (const { callback } of injected) callback(owner)
      })
      await sleep(1500)

      const status = await statusOf(tools)
      assert.equal(status.routes.http, 'failed', 'a probe that cannot reach the route is reported, not hidden')
      assert.match(status.routes.detail ?? '', /self-probe .*aborted due to timeout/)
      assert.equal(status.routes.rpc, 'mounted', 'diagnosing the HTTP route must not touch the RPC carrier')
      assert.ok(webServer.prefixes.has(RPC_CHANNEL))
      await disposeAll(effects, disposers)
    } finally {
      global.fetch = realFetch
    }
  })
})

test('a foreign owner of /wps-sync does not make the registration throw', async () => {
  await withStateDir(async () => {
    const webServer = makeWebServer()
    const foreign = { kind: 'prefix', path: RPC_CHANNEL, handler: () => {} }
    webServer.register(foreign)
    const services = {}
    const { ctx, effects, injected, tools } = fakeCtx(services)
    entry.apply(ctx, {})
    const { owner, disposers } = ownerFor(webServer, services)
    assert.doesNotThrow(() => {
      for (const { callback } of injected) callback(owner)
    })
    assert.equal(webServer.prefixes.get(RPC_CHANNEL), foreign, 'the foreign route keeps the prefix')
    assert.deepEqual(
      webServer.calls.map((call) => call.path),
      [RPC_CHANNEL, HTTP_PREFIX],
      'the foreign registration and our http route; the held /wps-sync path is retried, never stolen or thrown',
    )
    const status = await statusOf(tools)
    assert.equal(status.routes.rpc, 'duplicate', 'a path owned by someone else is reported, not hidden')
    await disposeAll(effects, disposers)
  })
})

test('POST /wps-sync/request is dispatched through the table and answers {ok:true,value}', async () => {
  await withStateDir(async () => {
    const webServer = makeWebServer()
    const services = { connection: { admit: () => undefined } }
    const { ctx, effects, injected } = fakeCtx(services)
    entry.apply(ctx, {})
    const { owner, disposers } = ownerFor(webServer, services)
    for (const { callback } of injected) callback(owner)

    // Longest-prefix routing: `/wps-sync/request` must reach our channel, not a default.
    const route = webServer.match(`${RPC_CHANNEL}/request`)
    assert.ok(route, 'the prefix must be matchable')
    assert.equal(route.path, RPC_CHANNEL)
    const response = await invoke(route.handler, rpcRequest({ payload: { token: 'a'.repeat(64) } }))
    assert.equal(response.status, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.type, 'server-response')
    assert.equal(body.rpcId, 'rpc-1')
    assert.equal(body.result.ok, true)
    assert.equal(body.result.value.plugin, 'dsh-wps-sync-bundle')
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
    // No CORS grant: the desktop renderer reaches this over the same-origin
    // `dsh-app://app` proxy, so cross-origin readability is never extended.
    assert.equal(response.headers['access-control-allow-origin'], undefined)
    assert.equal(response.headers['access-control-allow-credentials'], undefined)
    await disposeAll(effects, disposers)
  })
})

test('a rejected admission still answers 403 JSON and the disposer is idempotent', async () => {
  await withStateDir(async () => {
    const webServer = makeWebServer()
    const services = { connection: { admit: () => ({ rejection: 401 }) } }
    const { ctx, effects, injected } = fakeCtx(services)
    entry.apply(ctx, {})
    const { owner, disposers } = ownerFor(webServer, services)
    for (const { callback } of injected) callback(owner)

    const route = webServer.match(`${RPC_CHANNEL}/request`)
    const denied = await invoke(route.handler, rpcRequest({ payload: { token: 'a'.repeat(64) } }))
    assert.equal(denied.status, 403)
    const deniedBody = JSON.parse(denied.body)
    assert.equal(deniedBody.result.error.code, 'wps-sync/forbidden-connection')
    assert.equal(denied.headers['access-control-allow-origin'], undefined)

    // dispose releases the route; a second disposal is a no-op, not a delete of
    // whatever occupies the prefix by then.
    const fallbackDisposer = disposers[1]
    assert.equal(typeof fallbackDisposer, 'function')
    await fallbackDisposer()
    assert.equal(webServer.prefixes.has(RPC_CHANNEL), false)
    assert.doesNotThrow(() => fallbackDisposer())
    await disposeAll(effects, disposers)
  })
})

test('a stale instance holding /api/wps-sync is retried, reported, then claimed', async () => {
  await withStateDir(async () => {
    const webServer = makeWebServer()
    // The reload race: the previous plugin instance has not released the seat yet.
    const stale = { kind: 'prefix', path: HTTP_PREFIX, handler: () => {} }
    webServer.register(stale)
    const services = { connection: { admit: () => undefined } }
    const { ctx, effects, injected, tools } = fakeCtx(services)
    entry.apply(ctx, {})
    const { owner, disposers } = ownerFor(webServer, services)
    assert.doesNotThrow(() => {
      for (const { callback } of injected) callback(owner)
    })

    assert.ok(
      webServer.prefixes.has(RPC_CHANNEL),
      'a held http seat must not stop the rpc fallback from mounting',
    )
    let status = await statusOf(tools)
    assert.equal(status.routes.http, 'duplicate', 'a held seat is reported as duplicate while retries run')
    assert.equal(status.routes.rpc, 'mounted')
    assert.match(String(status.routes.detail), /duplicate prefix route/)

    // What an unload does: the holder releases the path.
    webServer.prefixes.delete(HTTP_PREFIX)
    await sleep(400)

    status = await statusOf(tools)
    assert.equal(status.routes.http, 'mounted', 'the bounded retry claims the seat once it is free')
    assert.equal(webServer.prefixes.get(HTTP_PREFIX).handler === stale.handler, false, 'the seat is ours now')
    await disposeAll(effects, disposers)
    assert.equal(webServer.prefixes.has(HTTP_PREFIX), false, 'unload releases the retried route')
  })
})

test('a non-duplicate http registration error is isolated and reported', async () => {
  await withStateDir(async () => {
    const webServer = makeWebServer()
    const register = webServer.register.bind(webServer)
    webServer.register = (route) => {
      if (route.path === HTTP_PREFIX) throw new Error('webserver: table exploded')
      return register(route)
    }
    const services = { connection: { admit: () => undefined } }
    const { ctx, effects, injected, tools } = fakeCtx(services)
    entry.apply(ctx, {})
    const { owner, disposers } = ownerFor(webServer, services)
    assert.doesNotThrow(() => {
      for (const { callback } of injected) callback(owner)
    })

    const status = await statusOf(tools)
    assert.equal(status.routes.http, 'failed', 'a non-duplicate throw is a failure, not a duplicate')
    assert.equal(status.routes.rpc, 'mounted', 'the rpc mount is independent of the http failure')
    const recorded = status.errors.filter((entry) => entry.code === 'wps-sync/route-http-failed')
    assert.equal(recorded.length, 1, 'the failure is surfaced in the status errors, not swallowed')
    assert.match(recorded[0].message, /table exploded/)
    await disposeAll(effects, disposers)
  })
})

test('an effect that cannot be created is recorded and never masks the other route', async () => {
  await withStateDir(async () => {
    // Case 1: the http effect cannot be created at all.
    const webServerA = makeWebServer()
    const a = fakeCtx({ connection: { admit: () => undefined } })
    entry.apply(a.ctx, {})
    const builtA = ownerFor(webServerA, { connection: { admit: () => undefined } }, { effectThrows: (index) => index === 0 })
    assert.doesNotThrow(() => {
      for (const { callback } of a.injected) callback(builtA.owner)
    })
    const statusA = await statusOf(a.tools)
    assert.equal(statusA.routes.http, 'failed', 'INACTIVE_EFFECT on the http effect is recorded as failed')
    assert.equal(statusA.routes.rpc, 'mounted', 'and does not take the rpc fallback down')
    assert.ok(
      statusA.errors.some((entry) => entry.code === 'wps-sync/route-http-effect-failed'),
      'the effect failure is reported',
    )
    await disposeAll(a.effects, builtA.disposers)

    // Case 2: the rpc effect cannot be created; the http route survives it.
    const webServerB = makeWebServer()
    const b = fakeCtx({ connection: { admit: () => undefined } })
    entry.apply(b.ctx, {})
    const builtB = ownerFor(webServerB, { connection: { admit: () => undefined } }, { effectThrows: (index) => index === 1 })
    assert.doesNotThrow(() => {
      for (const { callback } of b.injected) callback(builtB.owner)
    })
    const statusB = await statusOf(b.tools)
    assert.equal(statusB.routes.http, 'mounted')
    assert.equal(statusB.routes.rpc, 'failed')
    assert.ok(webServerB.prefixes.has(HTTP_PREFIX), 'the http route is still mounted')
    await disposeAll(b.effects, builtB.disposers)
  })
})

test('a healthy load keeps every route event out of the user-visible errors', async () => {
  await withStateDir(async () => {
    const webServer = makeWebServer()
    const services = { connection: { admit: () => undefined } }
    const { ctx, effects, injected, tools } = fakeCtx(services)
    entry.apply(ctx, {})
    const { owner, disposers } = ownerFor(webServer, services)
    for (const { callback } of injected) callback(owner)

    const status = await statusOf(tools)
    assert.equal(status.routes.http, 'mounted')
    assert.equal(status.routes.rpc, 'mounted')
    assert.equal(
      (status.errors ?? []).some((entry) => /^wps-sync\/route-/.test(entry.code)),
      false,
      'nothing failed, so nothing belongs in errors',
    )
    await disposeAll(effects, disposers)
  })
})

test('historical route-* entries are filtered out of the status errors', async () => {
  await withStateDir(async (dir) => {
    // An older build wrote every route event into `errors`; those records are now
    // diagnostics only, and an upgraded user must not keep seeing them.
    await fs.writeFile(
      path.join(dir, 'state.json'),
      JSON.stringify({
        errors: [
          { code: 'wps-sync/route-rpc-handover-failed', message: 'cannot get property "webServer" without inject' },
          { code: 'wps-sync/route-fetch-failed', message: 'shadowed by /api/wps-sync' },
          { code: 'other/code', message: 'keep me' },
        ],
      }),
      'utf8',
    )
    const webServer = makeWebServer()
    const services = { connection: { admit: () => undefined } }
    const { ctx, effects, injected, tools } = fakeCtx(services)
    entry.apply(ctx, {})
    const { owner, disposers } = ownerFor(webServer, services)
    for (const { callback } of injected) callback(owner)

    const status = await statusOf(tools)
    const codes = (status.errors ?? []).map((entry) => entry.code)
    assert.deepEqual(codes.filter((code) => /^wps-sync\/route-/.test(code)), [], 'legacy route records are dropped')
    assert.deepEqual(codes, ['other/code'], 'unrelated errors are preserved')
    await disposeAll(effects, disposers)
  })
})

test('a host channel known to be unmountable is skipped on the next load', async () => {
  await withStateDir(async () => {
    const fresh = freshEntry()

    // Load 1: the host channel fails the way this host always fails it.
    const webServerA = makeWebServer()
    let callsA = 0
    const connectionA = {
      admit: () => undefined,
      rpc: {
        handle: () => {
          callsA += 1
          throw new Error('cannot get property "webServer" without inject')
        },
      },
    }
    const a = fakeCtx({ connection: connectionA })
    fresh.apply(a.ctx, {})
    const builtA = ownerFor(webServerA, { connection: connectionA })
    assert.doesNotThrow(() => {
      for (const { callback } of a.injected) callback(builtA.owner)
    })
    assert.equal(callsA, 1, 'the first load must still try the handover')
    const statusA = await statusOf(a.tools)
    assert.equal(statusA.routes.rpc, 'mounted', 'the fallback keeps the channel mounted')
    assert.ok(
      (statusA.routes.history ?? []).some((line) => line.includes('wps-sync/route-rpc-handover-failed')),
      'the real failure stays diagnosable in history',
    )
    assert.equal(
      (statusA.errors ?? []).some((entry) => /^wps-sync\/route-/.test(entry.code)),
      false,
      'a recovered handover is not a user-visible error',
    )
    await disposeAll(a.effects, builtA.disposers)

    // Load 2 in the same process: the host property is known, so no attempt.
    const webServerB = makeWebServer()
    let callsB = 0
    const connectionB = {
      admit: () => undefined,
      rpc: {
        handle: () => {
          callsB += 1
          return () => {}
        },
      },
    }
    const b = fakeCtx({ connection: connectionB })
    fresh.apply(b.ctx, {})
    const builtB = ownerFor(webServerB, { connection: connectionB })
    assert.doesNotThrow(() => {
      for (const { callback } of b.injected) callback(builtB.owner)
    })
    assert.equal(callsB, 0, 'a reload must not retry the known-impossible handover')
    const statusB = await statusOf(b.tools)
    assert.equal(statusB.routes.rpc, 'mounted', 'skipping the handover never leaves the channel absent')
    assert.ok(webServerB.prefixes.has(RPC_CHANNEL))
    assert.ok(
      (statusB.routes.history ?? []).some((line) => line.includes('wps-sync/route-rpc-handover-skipped')),
      'the skip is recorded neutrally',
    )
    await disposeAll(b.effects, builtB.disposers)
  })
})

test('a handover failing for another reason is retried on the next load, not cached', async () => {
  await withStateDir(async () => {
    const fresh = freshEntry()
    let calls = 0
    const connection = {
      admit: () => undefined,
      rpc: {
        handle: () => {
          calls += 1
          throw new Error('rpc: channel already registered')
        },
      },
    }
    const webServerA = makeWebServer()
    const a = fakeCtx({ connection })
    fresh.apply(a.ctx, {})
    const builtA = ownerFor(webServerA, { connection })
    for (const { callback } of a.injected) callback(builtA.owner)
    assert.equal(calls, 1)
    const statusA = await statusOf(a.tools)
    assert.equal(statusA.routes.rpc, 'mounted', 'the fallback is re-mounted, the error is not swallowed')
    await disposeAll(a.effects, builtA.disposers)

    const webServerB = makeWebServer()
    const b = fakeCtx({ connection })
    fresh.apply(b.ctx, {})
    const builtB = ownerFor(webServerB, { connection })
    for (const { callback } of b.injected) callback(builtB.owner)
    assert.equal(calls, 2, 'an unrelated channel error is not treated as a host property')
    await disposeAll(b.effects, builtB.disposers)
  })
})

test('an absent route table is reported once, after the grace period', async () => {
  await withStateDir(async () => {
    await withGrace(40, async () => {
      const { ctx, effects, tools } = fakeCtx({ connection: { admit: () => undefined } })
      // No injection callback ever runs: this is the "absent" shape.
      entry.apply(ctx, {})
      await sleep(140)

      const first = await statusOf(tools)
      assert.equal(first.routes.http, 'absent')
      const reported = (first.errors ?? []).filter((entry) => entry.code === 'wps-sync/route-http-absent')
      assert.equal(reported.length, 1, 'the absence is surfaced once, with a reason')
      assert.match(reported[0].message, /webServer route table/)
      assert.match(reported[0].message, /unreachable/)

      const second = await statusOf(tools)
      assert.equal(
        (second.errors ?? []).filter((entry) => entry.code === 'wps-sync/route-http-absent').length,
        1,
        'repeated status reads never append the same absence again',
      )
      await disposeAll(effects, [])
    })
  })
})

test('the grace period reports nothing while a late injection can still arrive', async () => {
  await withStateDir(async () => {
    await withGrace(400, async () => {
      const { ctx, effects, tools } = fakeCtx({ connection: { admit: () => undefined } })
      entry.apply(ctx, {})
      await sleep(80)

      const status = await statusOf(tools)
      assert.equal(status.routes.http, 'absent', 'still inside the window')
      assert.equal(
        (status.errors ?? []).some((entry) => entry.code === 'wps-sync/route-http-absent'),
        false,
        'a host that simply has not injected yet must not be accused',
      )
      await disposeAll(effects, [])
    })
  })
})

test('a late injection after the absence report clears it again', async () => {
  await withStateDir(async () => {
    await withGrace(30, async () => {
      const webServer = makeWebServer()
      const services = { connection: { admit: () => undefined } }
      const { ctx, effects, injected, tools } = fakeCtx(services)
      entry.apply(ctx, {})
      await sleep(120)
      assert.equal((await statusOf(tools)).routes.http, 'absent')

      const { owner, disposers } = ownerFor(webServer, services)
      for (const { callback } of injected) callback(owner)

      const status = await statusOf(tools)
      assert.equal(status.routes.http, 'mounted', 'the late route claims the seat')
      assert.equal(
        (status.errors ?? []).some((entry) => entry.code === 'wps-sync/route-http-absent'),
        false,
        'a mounted route must retract the absence report',
      )
      await disposeAll(effects, disposers)
    })
  })
})

test('registration reads no un-injected service (source guard)', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'index.js'), 'utf8')
  assert.equal(
    source.includes('owner.connection'),
    false,
    'no registration path may read the owner object\'s connection service',
  )
  assert.equal(source.includes('hasConnectionRpc'), false, 'the old registry probe gate is gone')
  assert.equal(source.includes('mountRpcFallback'), false, 'the round-1 helper that only swallowed duplicates is gone')

  const probes = source.split("ctx.get('connection')").length - 1
  assert.equal(probes, 1, 'ctx.get("connection") is used exactly once: the request-time admit closure')
  const admitAt = source.indexOf('const admit = (req)')
  const probeAt = source.indexOf("ctx.get('connection')")
  const bridgeAt = source.indexOf('const bridge = createBridge')
  assert.ok(admitAt > 0 && admitAt < probeAt && probeAt < bridgeAt, 'the probe lives inside admit(), not in registration')
})