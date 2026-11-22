'use strict'

/**
 * Host entry registration.
 *
 * `apply()` cannot be exercised without a Cordis host, so this file drives it with
 * a minimal stand-in that mirrors the three APIs the entry actually uses
 * (`ctx.effect`, `ctx.inject`, `ctx.get`) plus the services it reads. What matters
 * here is the composition contract: the HTTP route is always mounted, the local RPC
 * route only stands in for a missing Connection channel, and every registration is
 * owned by an effect so unloading removes it.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const entry = require('../index')
const { RPC_CHANNEL, HTTP_PREFIX } = require('../lib/constants')

function fakeCtx(services, { on } = {}) {
  const effects = []
  const injected = []
  const registered = []
  const ctx = {
    get: (name) => services[name],
    on: on || (() => () => {}),
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
        registered.push(definition.name)
        return () => {}
      },
    },
    fiber: { entry: { id: 'wps-sync' } },
  }
  return { ctx, effects, injected, registered }
}

function ownerFor(services, routes, disposers) {
  return {
    effect: (fn) => {
      const dispose = fn()
      disposers.push(dispose)
      return () => {}
    },
    webServer: {
      register: (route) => {
        if (routes.some((existing) => existing.path === route.path && existing.kind === route.kind)) {
          throw new Error(`duplicate route ${route.path}`)
        }
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    connection: services.connection,
  }
}

/** Dispose the entry's effects (engine, tools, subscriptions) and route owners. */
async function disposeAll(disposers, effects) {
  for (const dispose of effects) if (typeof dispose === 'function') await dispose()
  for (const dispose of disposers) if (typeof dispose === 'function') await dispose()
}

async function withStateDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wps-sync-entry-'))
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

test('the entry exports the plain CommonJS shape the loader unwraps', () => {
  assert.equal(typeof entry.apply, 'function')
  assert.deepEqual(entry.inject, ['tools'])
  assert.equal(entry.name, 'dsh-wps-sync-bundle')
})

test('apply registers the seven tools and always mounts the HTTP route', async () => {
  await withStateDir(async () => {
    const routes = []
    const disposers = []
    const { ctx, effects, injected, registered } = fakeCtx({})
    entry.apply(ctx, {})
    for (const { names, callback } of injected) callback(ownerFor({}, routes, disposers))

    assert.deepEqual(registered.sort(), [
      'wps_sync_list',
      'wps_sync_pull',
      'wps_sync_remote_list',
      'wps_sync_restore',
      'wps_sync_set_auto',
      'wps_sync_status',
      'wps_sync_upload',
    ])
    assert.ok(routes.some((route) => route.path === HTTP_PREFIX && route.kind === 'prefix'))
    await disposeAll(disposers, effects)
  })
})

test('without a Connection channel the entry serves /wps-sync itself', async () => {
  await withStateDir(async () => {
    const routes = []
    const disposers = []
    const { ctx, effects, injected } = fakeCtx({})
    entry.apply(ctx, {})
    for (const { callback } of injected) callback(ownerFor({}, routes, disposers))

    assert.ok(routes.some((route) => route.path === RPC_CHANNEL && route.kind === 'prefix'))

    // The fallback route answers the local framing the browser uses.
    const route = routes.find((candidate) => candidate.path === RPC_CHANNEL)
    let status = 0
    let text = ''
    const res = {
      writeHead: (code) => {
        status = code
      },
      end: (body) => {
        text = String(body ?? '')
      },
    }
    const payload = JSON.stringify({ type: 'client-request', method: 'request', rpcId: 'r1', payload: { action: 'status', args: {} } })
    await route.handler(
      {
        method: 'POST',
        url: `${RPC_CHANNEL}/request`,
        headers: { host: '127.0.0.1:51287', origin: 'http://127.0.0.1:51287', 'content-type': 'application/json' },
        on: (event, listener) => {
          if (event === 'data') listener(Buffer.from(payload))
          if (event === 'end') listener()
          return undefined
        },
      },
      res,
    )
    assert.equal(status, 200)
    const body = JSON.parse(text)
    assert.equal(body.type, 'server-response')
    assert.equal(body.rpcId, 'r1')
    // No Connection service means nothing to admit: the local route answers, and the
    // loopback Host check above is what keeps it private.
    assert.equal(body.result.ok, true)
    assert.equal(body.result.value.plugin, 'dsh-wps-sync-bundle')
    await disposeAll(disposers, effects)
  })
})

test('a Connection channel replaces the local RPC fallback instead of colliding', async () => {
  await withStateDir(async () => {
    const routes = []
    const disposers = []
    const channels = []
    const fetchRoutes = []
    const connection = {
      admit: () => undefined,
      rpc: {
        handle: (channel, handler) => {
          if (routes.some((route) => route.path === channel)) {
            throw new Error(`duplicate route ${channel}`)
          }
          channels.push(channel)
          routes.push({ kind: 'prefix', path: channel, handler })
          return () => {}
        },
      },
      fetch: {
        register: (route) => {
          fetchRoutes.push(route)
          return () => {}
        },
      },
    }
    const { ctx, effects, injected } = fakeCtx({ connection })
    entry.apply(ctx, {})
    for (const { callback } of injected) callback(ownerFor({ connection }, routes, disposers))

    assert.deepEqual(channels, [RPC_CHANNEL])
    assert.equal(routes.filter((route) => route.path === RPC_CHANNEL).length, 1)
    assert.ok(fetchRoutes.length > 0)
    for (const route of fetchRoutes) {
      assert.equal(route.requestBody, 'buffered')
      assert.equal(typeof route.fetch, 'function')
      assert.equal('handler' in route, false)
    }
    await disposeAll(disposers, effects)
  })
})

test('the fallback route disposer is idempotent across the Connection handover', async () => {
  await withStateDir(async () => {
    const routes = []
    const disposers = []
    const services = {}
    const { ctx, effects, injected } = fakeCtx(services)
    entry.apply(ctx, {})

    const webServerInject = injected.find((entry) => entry.names.includes('webServer'))
    const connectionInject = injected.find((entry) => entry.names.includes('connection'))

    // 1. No Connection yet: the plugin mounts its own /wps-sync route.
    webServerInject.callback(ownerFor(services, routes, disposers))
    assert.ok(routes.some((route) => route.path === RPC_CHANNEL))

    // 2. Connection arrives and claims the same prefix.
    const channels = []
    services.connection = {
      admit: () => undefined,
      rpc: {
        handle: (channel, handler) => {
          channels.push(channel)
          const route = { kind: 'prefix', path: channel, handler }
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index >= 0) routes.splice(index, 1)
          }
        },
      },
    }
    connectionInject.callback(ownerFor(services, routes, disposers))
    assert.deepEqual(channels, [RPC_CHANNEL])
    const owned = routes.filter((route) => route.path === RPC_CHANNEL)
    assert.equal(owned.length, 1, 'the handover must not leave two routes on the prefix')

    // 3. Unload: the fallback effect disposes after the manual handover. That must be
    //    a no-op, otherwise it would delete the Connection-owned route at this path.
    const fallbackDisposer = disposers[1]
    await fallbackDisposer()
    await fallbackDisposer()
    assert.equal(
      routes.filter((route) => route.path === RPC_CHANNEL).length,
      1,
      'a second disposal must not remove the Connection-owned route',
    )
    await disposeAll(disposers, effects)
  })
})

test('the workspace timer never relies on the un-injected cordis timer mixin', async () => {
  await withStateDir(async () => {
    const routes = []
    const disposers = []
    const { ctx, effects, injected } = fakeCtx({})
    // Reproduce a real Cordis host: the timer service is a mixin, and touching it
    // without `inject: ['timer']` throws instead of returning undefined. That throw
    // used to abort `engine.start()`, so the 60s workspace mirror never existed while
    // turns, HTTP and tools kept working.
    let mixinReads = 0
    for (const name of ['interval', 'timer']) {
      Object.defineProperty(ctx, name, {
        configurable: true,
        get() {
          mixinReads += 1
          throw new Error('cannot get property "timer" without inject')
        },
      })
    }
    const created = []
    const cleared = []
    const realSetInterval = globalThis.setInterval
    const realClearInterval = globalThis.clearInterval
    globalThis.setInterval = (callback, delay) => {
      const handle = { callback, delay, unref() {}, close() {} }
      created.push(handle)
      return handle
    }
    globalThis.clearInterval = (handle) => {
      cleared.push(handle)
    }
    try {
      entry.apply(ctx, { workspaceScanIntervalSec: 60 })
      for (const { callback } of injected) callback(ownerFor({}, routes, disposers))

      const deadline = Date.now() + 3000
      while (created.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(created.length, 1, 'the entry still installs the periodic scan timer')
      assert.equal(created[0].delay, 60000, 'the default interval is one minute')
      assert.equal(mixinReads, 0, 'ctx.interval / ctx.timer must never be touched')

      await disposeAll(disposers, effects)
      assert.deepEqual(cleared, [created[0]], 'unloading the entry clears the scan timer')

      // The startup scan is part of `start()`, so it must not need the manual queue either.
      const entries = await fs.readdir(process.env.DSH_WPS_SYNC_STATE_DIR)
      assert.ok(entries.includes('state.json'))
    } finally {
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
    }
  })
})

test('a failing init is contained and the subscriptions stay owned', async () => {
  await withStateDir(async () => {
    const handlers = []
    const routes = []
    const disposers = []
    const { ctx, effects, injected } = fakeCtx(
      {},
      {
        on: (name, handler) => {
          handlers.push({ name, handler })
          return () => {}
        },
      },
    )
    entry.apply(ctx, {})
    for (const { callback } of injected) callback(ownerFor({}, routes, disposers))

    assert.ok(effects.length > 0)
    assert.deepEqual(
      handlers.map((entry) => entry.name).sort(),
      ['schedule/changed', 'session/created', 'session/event'],
    )
    // A turn that is not a turn/end must not queue any work.
    const turn = handlers.find((entry) => entry.name === 'session/event')
    assert.doesNotThrow(() => turn.handler({ id: 's1' }, { type: 'turn/start', data: {} }))
    // Disposal never throws, even when nothing was mounted yet.
    await disposeAll(disposers, effects)
  })
})