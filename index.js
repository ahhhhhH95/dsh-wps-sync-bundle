'use strict'

/**
 * dsh-wps-sync — Host entry.
 *
 * Exports the plain CommonJS form the Cordis loader unwraps: `inject`, `Config`
 * (when the host peer is resolvable) and `apply`. Everything the plugin creates
 * — tools, event listeners, the HTTP bridge, timers — is an effect owned by this
 * context, so unloading the bundle removes all of it.
 */

const os = require('node:os')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const { SyncEngine } = require('./lib/engine')
const { createToolDefinitions } = require('./lib/tools')
const { createBridge } = require('./lib/bridge')
const { Config } = require('./lib/config')
const { PLUGIN_NAME, RPC_CHANNEL, HTTP_PREFIX } = require('./lib/constants')

/**
 * Negative cache for the host's own RPC channel, shared by every load in this
 * process (module scope on purpose: a reload must not pay for the same known
 * failure again).
 *
 * On the desktop host the `connection` service is visible but its
 * `rpc.handle` cannot register anything: it throws
 * `cannot get property "webServer" without inject`, because the connection
 * service's context has no webServer. That is a property of the host, not of a
 * particular load, so once it is measured the handover is skipped outright and
 * the plugin keeps serving `/wps-sync` through its own webServer route.
 */
let connectionRpcUnsupported = false
const CONNECTION_RPC_UNSUPPORTED = /without inject|not available|no webServer/i

function resolveStateDir(ctx) {
  const explicit = process.env.DSH_WPS_SYNC_STATE_DIR
  if (explicit && explicit.trim()) return path.resolve(explicit.trim())
  const profile = process.env.DSH_PROFILE_DIR
  if (profile && profile.trim()) return path.join(path.resolve(profile.trim()), PLUGIN_NAME)
  const baseUrl = ctx && ctx.baseUrl
  if (baseUrl) {
    try {
      const url = baseUrl instanceof URL ? baseUrl : new URL(String(baseUrl))
      if (url.protocol === 'file:') return path.join(path.dirname(fileURLToPath(url)), PLUGIN_NAME)
    } catch {
      /* fall through to the home fallback */
    }
  }
  return path.join(os.homedir(), '.dsh', PLUGIN_NAME)
}

function loggerFor(ctx) {
  try {
    if (typeof ctx.logger === 'function') {
      const logger = ctx.logger('wps-sync')
      if (logger && typeof logger.warn === 'function') return logger
    }
  } catch {
    /* logging must never break the plugin */
  }
  return null
}

function servicesFor(ctx) {
  const get = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }
  return {
    get sessionQuery() {
      return get('sessionQuery')
    },
    get workspaceRegistry() {
      return get('workspaceRegistry')
    },
    get schedule() {
      return get('schedule')
    },
    get configEditor() {
      return get('configEditor')
    },
    get entry() {
      return ctx.fiber ? ctx.fiber.entry : undefined
    },
    // Do NOT probe `ctx.interval` / `ctx.timer` here. Cordis exposes the timer
    // service through a mixin whose getter reads `ctx[source]`, and an
    // un-injected service access throws instead of returning undefined:
    //   Error: cannot get property "timer" without inject
    //   at getTarget (cordis/lib/index.js:1471:15)
    // A `typeof ctx.interval` guard therefore threw, `engine.start()` rejected,
    // and the periodic workspace scan never ran while everything else worked.
    // A plain Node timer owned by the engine (cleared in `engine.stop()`, which
    // runs from the plugin's effect disposer) is the dependency-free contract.
    setInterval: (callback, delay) => {
      const handle = setInterval(callback, delay)
      if (typeof handle.unref === 'function') handle.unref()
      return () => clearInterval(handle)
    },
  }
}

function apply(ctx, rawConfig) {
  const logger = loggerFor(ctx)
  const onBackgroundError = (error) => {
    if (logger) logger.warn(error && error.message ? error.message : String(error))
  }

  const engine = new SyncEngine({
    config: rawConfig,
    stateDir: resolveStateDir(ctx),
    services: servicesFor(ctx),
    onBackgroundError,
  })

  ctx.effect(() => {
    let cancelled = false
    // Kept so an unload can wait for a still-running `init()`: it writes the
    // state file, and finishing it after teardown would race the disposal.
    const startup = engine
      .init()
      .then(() => {
        if (cancelled) return undefined
        return engine.start()
      })
      .catch(onBackgroundError)
    return async () => {
      cancelled = true
      await startup.catch(() => {})
      // Return the promise so an unloading host (and a test) can wait until the
      // final state write and timer teardown actually finished.
      return engine.stop().catch(() => {})
    }
  })

  // ---- tools ---------------------------------------------------------------
  ctx.effect(() => {
    const disposers = createToolDefinitions(engine).map((definition) => ctx.tools.register(definition))
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* registration already gone */
        }
      }
    }
  })

  // ---- durable events ------------------------------------------------------
  if (typeof ctx.on === 'function') {
    ctx.effect(() =>
      ctx.on('session/event', (session, event) => {
        if (!session || typeof session.id !== 'string') return
        if (!event || event.type !== 'turn/end') return
        engine.handleTurnEnd(session.id)
      }),
    )
    ctx.effect(() =>
      ctx.on('session/created', () => {
        engine.invalidateStatus()
      }),
    )
    ctx.effect(() =>
      ctx.on('schedule/changed', () => {
        engine.handleScheduleChanged()
      }),
    )
  }

  // ---- route diagnostics ---------------------------------------------------
  // Which carrier each route ended up on, so a single `wps_sync_status` call can
  // separate "the host never offered this fiber a route table" from "we tried and
  // lost the seat" from "serving":
  //
  //   absent     the inject callback never ran (this fiber has no webServer)
  //   mounted    the route is in the host table
  //   duplicate  the path is held elsewhere and the bounded retries are running;
  //              for the RPC channel a duplicate that survives every retry is the
  //              expected outcome, because the host's own `connection.rpc` prefix
  //              owns that path and is a working carrier
  //   failed     a non-duplicate registration error, an effect that could not be
  //              created, or the retries ran out
  const routeDiagnostics = { http: 'absent', rpc: 'absent', detail: null }
  /**
   * Bounded ring buffer of route events.
   *
   * Troubleshooting material only: it is surfaced through `routes.history`. Route
   * events are events, not user-visible faults -- a handover that falls back, a
   * shadowed fetch route, or a mount that wins on retry has already recovered, and
   * listing it under `errors` made a healthy reload look broken.
   */
  const routeEvents = []
  /** Terminal failures only -- the ones that really never mounted. These reach `errors`. */
  const routeFailures = new Map()
  /** Which route the single `detail` string belongs to, so a sibling settling cannot erase it. */
  let routeDetailKey = null

  const routeErrorMessage = (error) => (error && error.message ? String(error.message) : String(error))

  const recordRouteEvent = (error, code, where, level = 'warn') => {
    const message = routeErrorMessage(error)
    routeEvents.push({ code, message, where })
    if (routeEvents.length > 8) routeEvents.splice(0, routeEvents.length - 8)
    if (!logger) return
    // A skip that the plugin has already worked around is debug noise, not a warning.
    const emit = level === 'debug' && typeof logger.debug === 'function' ? logger.debug : logger.warn
    if (typeof emit !== 'function') return
    try {
      emit.call(logger, `wps-sync route ${where}: ${message}`)
    } catch {
      /* logging must never break registration */
    }
  }

  /** Record a route that gave up: this one is a fault the operator must see. */
  const failRoute = (key, error, code, where) => {
    recordRouteEvent(error, code, where)
    // A `Map` keyed by route: repeated status calls cannot append this twice.
    routeFailures.set(key, { code, message: routeErrorMessage(error), where })
  }

  const isRouteDiagnosticEntry = (entry) =>
    /^wps-sync\/route-/.test(String((entry && entry.code) || ''))

  const noteRouteDetail = (key, text) => {
    routeDetailKey = key
    routeDiagnostics.detail = text
  }

  const setRouteState = (key, state, detail) => {
    routeDiagnostics[key] = state
    if (state === 'mounted' || state === 'absent') routeFailures.delete(key)
    if (detail !== undefined) {
      noteRouteDetail(key, detail)
      return
    }
    // Clear only a detail this same route recorded: the sibling route settling
    // must not erase the other one's explanation.
    if (routeDetailKey === key && (state === 'mounted' || state === 'absent')) {
      routeDetailKey = null
      routeDiagnostics.detail = null
    }
  }

  // Additive on purpose: the existing status shape stays intact so the client's
  // normalize is unaffected, and the diagnostics ride along for `wps_sync_status`
  // and the renderer.
  const readStatus = engine.status.bind(engine)
  engine.status = async (options) => {
    const value = await readStatus(options)
    const routes = { http: routeDiagnostics.http, rpc: routeDiagnostics.rpc }
    if (routeDiagnostics.detail) routes.detail = routeDiagnostics.detail
    if (routeEvents.length) {
      routes.history = routeEvents.map((event) => `${event.code} | ${event.where} | ${event.message}`)
    }
    const errors = Array.isArray(value.errors) ? value.errors : []
    // Historical `route-*` entries (written by earlier builds that treated every
    // route event as an error) are dropped here so existing panels clean
    // themselves up; only a route that never mounted is reported now.
    const kept = errors.filter((entry) => !isRouteDiagnosticEntry(entry))
    if (kept.length === errors.length && !routeFailures.size) return { ...value, routes }
    return { ...value, routes, errors: [...kept, ...routeFailures.values()] }
  }

  // ---- route absence watchdog ----------------------------------------------
  /**
   * `absent` is the only silent failure mode: the host never ran the webServer
   * injection, nothing was registered, and every `/api/wps-sync` request dies in
   * the host's default handler while the panel can only say "cannot reach the
   * sync service". A healthy host mounts within milliseconds, so give it a grace
   * period and then say it once, with the reason, instead of leaving the user
   * with an unexplained failure. If a late injection does mount the route, the
   * state becomes `mounted` and `setRouteState` drops the failure again.
   */
  const routeAbsentGraceMs = (() => {
    const raw = Number(process.env.DSH_WPS_SYNC_ROUTE_ABSENT_GRACE_MS)
    return Number.isFinite(raw) && raw >= 0 ? raw : 5000
  })()

  ctx.effect(() => {
    const timer = setTimeout(() => {
      if (routeDiagnostics.http !== 'absent') return
      failRoute(
        'http',
        new Error(
          `this host never provided a webServer route table, so ${HTTP_PREFIX} is unreachable: the panel and the HTTP interface cannot reach the sync service (see routes)`,
        ),
        'wps-sync/route-http-absent',
        HTTP_PREFIX,
      )
    }, routeAbsentGraceMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  })

  // ---- bridge --------------------------------------------------------------
  // Fail closed: any unexpected failure while asking the connection to admit a
  // request must deny it, never let it through.
  const admit = (req) => {
    let connection
    try {
      connection = ctx.get('connection')
    } catch (error) {
      throw Object.assign(new Error('无法确认连接状态'), { status: 403, code: 'wps-sync/forbidden-connection' })
    }
    if (!connection || typeof connection.admit !== 'function') return
    let admission
    try {
      admission = connection.admit(req)
    } catch (error) {
      throw Object.assign(new Error('连接鉴权失败'), { status: 403, code: 'wps-sync/forbidden-connection' })
    }
    if (admission && admission.rejection) {
      throw Object.assign(new Error('连接未授权本次请求'), { status: 403, code: 'wps-sync/forbidden-connection' })
    }
  }
  const bridge = createBridge({ engine, admit })

  /**
   * Bounded retry window for a `duplicate` registration.
   *
   * A plugin reload can run the new fiber's injection before the previous instance
   * released its routes (`set_plugin` off -> on in quick succession), and the
   * shipped table deletes by path (`dsh-host-webserver/src/index.ts:445-452`), so
   * a seat can free up a moment later. 12 x 120ms is a reload's worth of slack and
   * never runs while a route is actually mounted.
   */
  const ROUTE_RETRY_DELAY_MS = 120
  const ROUTE_RETRY_LIMIT = 12

  const isDuplicateRouteError = (error) =>
    Boolean(error) && /duplicate.*route/i.test(String(error.message || error))

  /**
   * One-shot self probe for the HTTP route.
   *
   * A successful `register()` only proves that the webServer *instance this fiber
   * holds* accepted the route. It cannot prove that instance is the one serving
   * traffic — on the desktop host the listener lives in the host process, and a
   * second, non-serving instance would happily accept registrations and answer
   * nothing. A single delayed `GET <ourselves>/api/wps-sync/state` settles it: that
   * path is token-free, the request comes from loopback with no Origin, so it is
   * the exact request shape `assertHost`/`assertOrigin` accept, and only our own
   * route can answer `{ok:true,...}` there (the host's `/api` prefix would answer
   * 401 `unauthorized` instead).
   *
   * Runs once per successful mount (load, or the end of a retry window), never on a
   * timer loop, and every outcome is diagnostic only.
   * `DSH_WPS_SYNC_ROUTE_PROBE_DELAY_MS` exists so tests do not have to wait.
   */
  const ROUTE_PROBE_DELAY_MS = (() => {
    const raw = Number(process.env.DSH_WPS_SYNC_ROUTE_PROBE_DELAY_MS)
    return Number.isFinite(raw) && raw >= 0 ? raw : 1200
  })()

  const probeHttpRoute = (owner, isCancelled) => {
    if (typeof fetch !== 'function') {
      noteRouteDetail('http', 'self-probe skipped: no global fetch')
      return null
    }
    const server = owner && owner.webServer
    if (!server || typeof server.register !== 'function') return null
    let probeUrl = null
    try {
      // `getOrigin()` already carries the scheme on the shipped host; `protocol`
      // may or may not end in ':'. Compose defensively and never double it.
      let authority = typeof server.getOrigin === 'function' ? server.getOrigin() : null
      if (authority && /^[a-z][a-z0-9+.-]*:\/\//i.test(authority)) {
        probeUrl = `${authority.replace(/\/+$/, '')}${HTTP_PREFIX}/state`
      } else {
        if (!authority && server.port) authority = `127.0.0.1:${server.port}`
        if (!authority) {
          // Not listening yet: nothing to probe, and the mount itself is still real.
          noteRouteDetail('http', 'self-probe skipped: webServer has no address')
          return null
        }
        const protocol = typeof server.protocol === 'string' && server.protocol ? server.protocol : 'http:'
        probeUrl = `${protocol.replace(/:?$/, ':')}//${authority}${HTTP_PREFIX}/state`
      }
    } catch (error) {
      noteRouteDetail('http', `self-probe skipped: ${error && error.message}`)
      return null
    }
    const timer = setTimeout(() => {
      if (isCancelled()) return
      const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(5000) : undefined
      Promise.resolve()
        .then(() => fetch(probeUrl, { method: 'GET', signal }))
        .then(async (response) => {
          if (isCancelled()) return
          let answered = false
          try {
            const body = await response.json()
            answered = Boolean(body && body.ok === true)
          } catch {
            answered = false
          }
          if (response.ok && answered) {
            setRouteState('http', 'mounted', null)
            return
          }
          const detail = `self-probe ${probeUrl} -> HTTP ${response.status}`
          setRouteState('http', 'failed', detail)
          recordRouteEvent(new Error(detail), 'wps-sync/route-http-unreachable', HTTP_PREFIX)
          failRoute('http', new Error(detail), 'wps-sync/route-http-failed', HTTP_PREFIX)
        })
        .catch((error) => {
          if (isCancelled()) return
          const detail = `self-probe ${probeUrl} -> ${error && error.message}`
          setRouteState('http', 'failed', detail)
          recordRouteEvent(error, 'wps-sync/route-http-unreachable', HTTP_PREFIX)
          failRoute('http', error, 'wps-sync/route-http-failed', HTTP_PREFIX)
        })
    }, ROUTE_PROBE_DELAY_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return timer
  }

  /**
   * Disposer of this plugin's own `/wps-sync` route, when it mounted one.
   *
   * Two carriers can answer the RPC channel on the same path: the host's
   * Connection RPC channel (`connection.rpc.handle`, which registers
   * `{kind:'prefix', path: channel}` on the *same* webServer,
   * `dsh-client-connection/src/rpc-host.ts:253-277`) and our own route below. The
   * route table throws `webserver: duplicate prefix route "/wps-sync"` when a path
   * is taken, so only one may be mounted at a time: the handover in the
   * `connection` injection releases ours first.
   */
  let disposeRpcFallback = null

  /**
   * The owner object of the `webServer` injection.
   *
   * Only that owner may touch `webServer`: an injection callback's owner exposes
   * exactly the services it was injected with, so the `connection` callback below
   * cannot register a route through its own owner — doing so throws
   * `cannot get property "webServer" without inject` (measured live: the host's
   * `connection.rpc.handle` fails with exactly that, which is why the host channel
   * cannot be mounted on this host at all and the fallback must be re-mounted
   * through *this* owner).
   */
  let routeOwner = null

  /**
   * Mount one route, capturing every failure and retrying a duplicate a bounded
   * number of times.
   *
   * Always returns an idempotent disposer and never throws: registration must not
   * be able to abort the injection callback, because that rolls back the *other*
   * route too (see the comment on the `webServer` injection below).
   */
  const mountRoute = (owner, route, key) => {
    let release = null
    let timer = null
    let probeTimer = null
    let disposed = false
    let attempts = 0

    const disposeOnce = () => {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (probeTimer) {
        clearTimeout(probeTimer)
        probeTimer = null
      }
      if (disposeRpcFallback === disposeOnce) disposeRpcFallback = null
      const releaseNow = release
      release = null
      if (typeof releaseNow !== 'function') return
      try {
        releaseNow()
      } catch {
        /* the table entry is already gone */
      }
    }
    if (key === 'rpc') disposeRpcFallback = disposeOnce

    const attempt = () => {
      timer = null
      if (disposed || typeof release === 'function') return
      attempts += 1
      try {
        release = owner.webServer.register(route)
        setRouteState(key, 'mounted')
        // Confirm the seat really answers (see `probeHttpRoute`); the RPC route
        // answers no GET, so only the HTTP face is probed.
        if (key === 'http' && !probeTimer) probeTimer = probeHttpRoute(owner, () => disposed)
      } catch (error) {
        const duplicate = isDuplicateRouteError(error)
        if (duplicate && attempts <= ROUTE_RETRY_LIMIT && !disposed) {
          setRouteState(key, 'duplicate', `${route.path}: ${error.message} (attempt ${attempts})`)
          timer = setTimeout(attempt, ROUTE_RETRY_DELAY_MS)
          if (typeof timer.unref === 'function') timer.unref()
          return
        }
        // A duplicate that outlives every retry means the path belongs to somebody
        // else for good. For the RPC channel that is the host channel -- a working
        // carrier, not a failure -- so it is reported as `duplicate`, never
        // `failed`, and never retried forever. Either way the seat was never ours,
        // so this is the one route outcome that reaches the user-visible errors.
        const state = duplicate && key === 'rpc' ? 'duplicate' : 'failed'
        setRouteState(key, state, `${route.path}: ${error && error.message}`)
        failRoute(key, error, `wps-sync/route-${key}-${duplicate ? 'duplicate' : 'failed'}`, route.path)
      }
    }

    attempt()
    return disposeOnce
  }

  /** Give the route its own effect; a throwing `owner.effect` is recorded, never rethrown. */
  const mountRouteInEffect = (owner, route, key) => {
    try {
      owner.effect(() => mountRoute(owner, route, key))
    } catch (error) {
      // The effect could not even be created, so nothing can mount this route.
      setRouteState(key, 'failed', `${route.path}: ${error && error.message}`)
      failRoute(key, error, `wps-sync/route-${key}-effect-failed`, route.path)
    }
  }

  ctx.inject(['webServer'], (owner) => {
    // Both mounts are unconditional, HTTP first, and each gets its own effect and
    // its own capture. Nothing in this callback may read a service this fiber did
    // not inject.
    //
    // Round 1 of this fix gated the RPC fallback behind a truthiness read of a
    // service this callback never injected (`connection`, off the owner object),
    // inside the *second* effect of this callback. On the live desktop host this
    // plugin fiber has no `connection` service, so that read throws
    //   Error: cannot get property "connection" without inject
    // -- the same failure family as the `ctx.timer` note in `servicesFor` above.
    // Cordis then aborts the whole injection callback and rolls back every effect
    // that callback already created, invoking the route table's release function,
    // which deletes by *path* (`dsh-host-webserver/src/index.ts:445-452`).
    // Reproduced against the shipped cordis: mount a route in effect #1, read an
    // un-injected service in effect #2, and the route is gone -- with nothing
    // logged anywhere.
    //
    // That is exactly the shape measured on the host after that reload:
    // `GET /api/wps-sync/state` -> 401 `unauthorized` from the host's own `/api`
    // prefix, `/wps-sync*` -> empty 404/405 from the route table default, no
    // warning in any log, while the tools effect (a *different* injection callback)
    // kept working. A second way to lose the same seat is a reload race: the new
    // fiber registers while the previous instance still holds the path, the table
    // throws `duplicate`, and an uncaptured throw again kills the sibling effect.
    // Both paths are covered here: no service probe at all, and every registration
    // captured -- a duplicate is retried a bounded number of times rather than
    // accepted or propagated.
    mountRouteInEffect(owner, bridge.httpRoute, 'http')
    mountRouteInEffect(owner, bridge.rpcRoute, 'rpc')
    routeOwner = owner
  })

  ctx.inject(['connection'], (owner) => {
    // `connection` is injected here, so reading it is this callback's contract --
    // unlike a webServer-only inject, where touching it is a registry probe.
    const { connection } = owner
    const channel = connection?.rpc
    /** Re-mount the fallback through the *webServer* owner; this callback's owner cannot touch webServer. */
    const remountFallback = (why) => {
      if (!routeOwner) {
        setRouteState('rpc', 'absent', `${RPC_CHANNEL}: ${why}; the webServer injection owns the fallback`)
        return () => {}
      }
      return mountRoute(routeOwner, bridge.rpcRoute, 'rpc')
    }
    if (typeof channel?.handle === 'function' && connectionRpcUnsupported) {
      // Measured on this host on an earlier load (`CONNECTION_RPC_UNSUPPORTED`):
      // the host channel cannot register on any webServer it can see. Do not pay
      // for the same throw again -- keep serving through our own route, which is
      // the path that was verified to work.
      recordRouteEvent(
        new Error('connection.rpc.handle cannot see a webServer on this host; keeping the plugin route'),
        'wps-sync/route-rpc-handover-skipped',
        RPC_CHANNEL,
        'debug',
      )
      if (!disposeRpcFallback) {
        if (routeOwner) mountRouteInEffect(routeOwner, bridge.rpcRoute, 'rpc')
        else setRouteState('rpc', 'absent', `${RPC_CHANNEL}: the webServer injection owns the fallback`)
      }
    } else if (typeof channel?.handle === 'function') {
      // Release our route first: the host channel registers the same prefix and
      // would throw against a table that still holds ours.
      if (typeof disposeRpcFallback === 'function') {
        try {
          disposeRpcFallback()
        } catch {
          /* the fallback route may never have been mounted */
        }
        disposeRpcFallback = null
      }
      try {
        owner.effect(() => {
          try {
            const release = channel.handle(RPC_CHANNEL, (endpoint, payload) => bridge.rpcHandler(endpoint, payload))
            setRouteState('rpc', 'mounted')
            return release
          } catch (error) {
            // The channel could not claim the prefix (it may not even be able to see
            // a webServer: measured live this throws
            // `cannot get property "webServer" without inject`). Re-mount our own
            // route -- retried when a stale holder still owns the path, and always
            // through the webServer owner -- and never rethrow: a failed handover
            // must not take this fiber, or the HTTP route, down with it.
            //
            // A "this channel cannot see a webServer" failure is a property of the
            // host, not of this load: remember it so later loads skip the attempt
            // instead of logging the same dead end on every reload.
            if (CONNECTION_RPC_UNSUPPORTED.test(routeErrorMessage(error))) connectionRpcUnsupported = true
            recordRouteEvent(error, 'wps-sync/route-rpc-handover-failed', RPC_CHANNEL)
            return remountFallback(error && error.message)
          }
        })
      } catch (error) {
        recordRouteEvent(error, 'wps-sync/route-rpc-effect-failed', RPC_CHANNEL)
        if (routeOwner) mountRouteInEffect(routeOwner, bridge.rpcRoute, 'rpc')
      }
    }
    // Kept, and deliberately annotated rather than removed.
    //
    // These entries are the `connection.fetch` surface: exact `/api/...` paths
    // dispatched by the host's shared fetch handler. On the measured host shape
    // they are unreachable — our `/api/wps-sync` prefix is longer than the host's
    // `/api` prefix, so the route table hands every `/api/wps-sync*` request to
    // our own route (that is why `GET /api/wps-sync/state` answers 200 without the
    // host's cookie admission). They are also pinned by the registration contract
    // in test/index-registration.test.js, so removing them would break a shipped
    // surface for no functional gain; the registration itself stays correct if the
    // dispatcher is ever reached.
    if (typeof connection?.fetch?.register !== 'function') return
    try {
      owner.effect(() => {
        const disposers = []
        for (const entry of bridge.fetchHandlers) {
          try {
            disposers.push(connection.fetch.register(entry))
          } catch (error) {
            // Isolated per entry: one refused path must not drop the others.
            recordRouteEvent(error, 'wps-sync/route-fetch-failed', entry.path)
          }
        }
        return () => {
          for (const dispose of disposers) {
            if (typeof dispose !== 'function') continue
            try {
              dispose()
            } catch {
              /* the registration is already gone */
            }
          }
        }
      })
    } catch (error) {
      recordRouteEvent(error, 'wps-sync/route-fetch-effect-failed', 'connection.fetch')
    }
  })
}

const exportsObject = { name: PLUGIN_NAME, inject: ['tools'], apply }
if (Config) exportsObject.Config = Config
module.exports = exportsObject