'use strict'

/**
 * The Host <-> Client bridge.
 *
 * A profile-installed bundle cannot ship generated `typert` descriptors, so the
 * UI talks to the Host the same way the shipped WeChat bundle does:
 *
 *   1. `ctx.webServer.register({kind:'prefix', path:'/api/wps-sync', handler})`
 *      serves a JSON API (and the one-time token);
 *   2. `ctx.connection.fetch.register(...)` exposes the same endpoints to the
 *      embedded browser when it cannot fetch directly;
 *   3. `ctx.connection.rpc.call('/wps-sync', 'request', payload)` carries calls
 *      that must ride the existing connection instead of a new port.
 *
 * Security mirrors the shipped implementation: loopback Host only, same-origin,
 * no cross-site fetch metadata, and a per-process bearer token for every write.
 */

const crypto = require('node:crypto')
const { HTTP_PREFIX, RPC_CHANNEL, MAX_BODY_BYTES } = require('./constants')
const { SyncError, badRequest, notReady } = require('./errors')

const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i
const TOKEN_PATTERN = /^[a-f0-9]{64}$/
/**
 * Desktop shells load the Web UI from a custom scheme, not from http(s).
 *
 * Historical redundancy, kept for older shells that did send such an Origin. It is
 * not the fence: `assertHost` (loopback only) is, and `assertOrigin` already
 * accepts an absent Origin, which is exactly the host's own rule in
 * `api-request-trust.ts` — "Absent Origin is fine, the Host fence above already
 * bound the request" (:148-150), while a present Origin must be http(s) and
 * same-authority (:160-175). The desktop path never reaches this branch either:
 * Electron's `forwardWebRequest` deletes origin/host/sec-fetch-site before it
 * proxies to the loopback host. Deliberately no CORS header is ever emitted for
 * this or any other origin (`assertOrigin` only refuses).
 */
const DESKTOP_ORIGIN = /^(?:dsh-app|dsh):/i

/** HTTP suffix -> ACTIONS key, for suffixes that are not valid identifiers. */
const SUFFIX_ACTIONS = {
  'remote/list': 'remoteList',
  'remote-list': 'remoteList',
}

function resolveAction(suffix) {
  const key = String(suffix || '').replace(/^\/+/, '')
  return SUFFIX_ACTIONS[key] ?? key
}

function forbidden(message, code) {
  return Object.assign(new Error(message), { status: 403, code })
}

function isTrustedOrigin(origin, host) {
  if (DESKTOP_ORIGIN.test(origin)) return true
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    // Same authority, either scheme: the Web UI may be served over https while
    // the loopback helper is plain http.
    return parsed.host === host
  } catch {
    return false
  }
}

function createToken() {
  return crypto.randomBytes(32).toString('hex')
}

function send(res, status, body) {
  if (res.writableEnded || res.headersSent) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function failure(error) {
  const status = Number.isFinite(error && error.status) ? error.status : 500
  return {
    status,
    body: {
      ok: false,
      error: {
        code: (error && error.code) || 'wps-sync/internal',
        message: error && error.message ? error.message : String(error),
      },
    },
  }
}

/** Read and parse a JSON object body with a hard size limit. */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '')
    if (!/^application\/json\b/i.test(contentType)) {
      reject(badRequest('请求必须是 application/json', 'wps-sync/content-type'))
      return
    }
    const chunks = []
    let size = 0
    let settled = false
    const failWith = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        failWith(badRequest(`请求体超过 ${limit} 字节上限`, 'wps-sync/body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => failWith(error))
    req.on('end', () => {
      if (settled) return
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        settled = true
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          failWith(badRequest('请求体必须是一个 JSON 对象', 'wps-sync/body-invalid'))
          return
        }
        settled = true
        resolve(parsed)
      } catch {
        failWith(badRequest('请求体不是合法 JSON', 'wps-sync/body-invalid'))
      }
    })
  })
}

const ACTIONS = {
  list: (engine) => engine.status({ fresh: true }),
  status: (engine) => engine.status({ fresh: true }),
  upload: (engine, payload) => engine.upload(payload.kind ?? 'all', payload.id, { force: payload.force === true }),
  auto: (engine, payload) => engine.setAuto(payload.kind ?? 'all', payload.id, payload.auto !== false),
  root: (engine, payload) => engine.setRoot(payload.syncRootDir ?? payload.root ?? '', { configEditor: engine.services.configEditor, entry: engine.services.entry }),
  remoteList: (engine) => engine.remoteList(),
  pull: (engine, payload) => engine.pull({ deviceId: payload.deviceId, kind: payload.kind, id: payload.id, version: payload.version }),
  restore: (engine, payload) => engine.restore({ importId: payload.importId, targetDir: payload.targetDir, conflict: payload.conflict }),
  archive: (engine, payload) => engine.archive({ importId: payload.importId, path: payload.path }),
}

/**
 * @param {{engine: object, token?: string, now?: () => number}} options
 */
function createBridge(options) {
  const engine = options.engine
  const token = options.token ?? createToken()
  const admit = typeof options.admit === 'function' ? options.admit : null

  /** Optional connection-level admission, exactly like the shipped bridge. */
  function assertAdmitted(req) {
    if (!admit) return
    try {
      admit(req)
    } catch (error) {
      // Fail closed: an admission failure is a rejection, never a pass-through,
      // even when the underlying error carries no HTTP status.
      if (error && error.status === 403) throw error
      throw forbidden('连接准入被拒绝', 'wps-sync/forbidden-connection')
    }
  }

  /** Loopback Host only; a missing Host header is refused. */
  function assertHost(req) {
    const host = String(req.headers.host || '')
    if (!host) throw forbidden('缺少 Host 头', 'wps-sync/forbidden-host')
    if (!LOOPBACK_HOST.test(host)) throw forbidden('只接受本机请求', 'wps-sync/forbidden-host')
    return host
  }

  /**
   * HTTP routes additionally check the requesting origin: same-authority
   * http(s), the desktop custom schemes, and only `cross-site` fetch metadata
   * are refused. The RPC channel deliberately skips this — the shipped client
   * calls it from the desktop shell, which has a non-http origin.
   */
  function assertOrigin(req, host) {
    const origin = String(req.headers.origin || '')
    if (origin && !isTrustedOrigin(origin, host)) {
      throw forbidden('请求来源不匹配', 'wps-sync/forbidden-origin')
    }
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      throw forbidden('拒绝跨站请求', 'wps-sync/forbidden-site')
    }
  }

  function assertLocal(req) {
    const host = assertHost(req)
    assertOrigin(req, host)
  }

  function assertTokenValue(suppliedRaw) {
    const supplied = String(suppliedRaw || '')
    if (!TOKEN_PATTERN.test(supplied)) {
      throw Object.assign(new Error('缺少或无效的 x-wps-sync-token'), { status: 403, code: 'wps-sync/forbidden-token' })
    }
    const expected = Buffer.from(token, 'utf8')
    const actual = Buffer.from(supplied, 'utf8')
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      throw Object.assign(new Error('x-wps-sync-token 不匹配'), { status: 403, code: 'wps-sync/forbidden-token' })
    }
  }

  function assertToken(req) {
    assertTokenValue(req.headers['x-wps-sync-token'])
  }

  async function dispatch(action, payload) {
    const handler = ACTIONS[action]
    if (!handler) throw badRequest(`未知操作：${action}`, 'wps-sync/unknown-action')
    const value = await handler(engine, payload ?? {})
    return value
  }

  /**
   * Route one HTTP request (webServer route and connection.fetch share this).
   *
   * The HTTP face deliberately does NOT consult `connection.admit`: the shipped
   * transport only applies admission to RPC channels (`rpc-host.ts:263-271`),
   * while `webServer` routes are protected by the loopback Host + Origin policy
   * and this plugin's own bearer token. Requiring admission here would 403 every
   * request from a host that has no Connection service at all.
   */
  async function handleRequest(req, res) {
    try {
      assertLocal(req)
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
      const pathname = url.pathname.replace(/\/+$/, '')
      const suffix = pathname.slice(HTTP_PREFIX.length) || ''

      if (req.method === 'GET' && (suffix === '' || suffix === '/state')) {
        const status = await engine.status({ fresh: true })
        send(res, 200, { ok: true, token, ...status })
        return
      }

      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: { code: 'wps-sync/method', message: '只支持 GET /state 与 POST 操作' } })
        return
      }
      assertToken(req)
      const payload = await readJsonBody(req)
      const action = resolveAction(suffix)
      const value = await dispatch(action, payload)
      send(res, 200, { ok: true, result: value })
    } catch (error) {
      const { status, body } = failure(error)
      send(res, status, body)
    }
  }

  /** The webServer route object. */
  const httpRoute = { kind: 'prefix', path: HTTP_PREFIX, handler: handleRequest }

  /** `connection.rpc.call('/wps-sync', 'request', payload)` handler. */
  async function handleRpc(req, res) {
    let rpcId = null
    try {
      // The RPC channel keeps the strict connection admission: unlike the plain
      // HTTP face it is reachable without our bearer header, so the connection's
      // own trust decision is the primary gate there.
      assertHost(req)
      assertAdmitted(req)
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
      if (!url.pathname.startsWith(RPC_CHANNEL)) {
        send(res, 404, { ok: false, error: { code: 'wps-sync/rpc-path', message: '未知 RPC 通道' } })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: { code: 'wps-sync/rpc-method', message: 'RPC 只支持 POST' } })
        return
      }
      // `connection.rpc.call` cannot attach custom headers, so the RPC path is
      // gated by the connection's own admission when one is available. Otherwise
      // the bearer must arrive either as the header or inside the payload (the
      // shipped client sends `payload.token`).
      const message = await readJsonBody(req)
      const headerToken = req.headers['x-wps-sync-token']
      if (headerToken !== undefined) {
        assertToken(req)
      } else if (!admit) {
        const payloadToken = message && message.payload && typeof message.payload.token === 'string' ? message.payload.token : ''
        assertTokenValue(payloadToken)
      }
      if (message.type !== 'client-request' || message.method !== 'request') {
        send(res, 400, { ok: false, error: { code: 'wps-sync/rpc-invalid', message: '不支持的 RPC 消息' } })
        return
      }
      rpcId = message.rpcId ?? null
      const payload = message.payload ?? {}
      const action = typeof payload.action === 'string' ? payload.action : ''
      const value = await dispatch(action, payload.args ?? {})
      send(res, 200, { type: 'server-response', rpcId, result: { ok: true, value } })
    } catch (error) {
      const { status, body } = failure(error)
      send(res, status, { type: 'server-response', rpcId, result: body })
    }
  }

  const rpcRoute = { kind: 'prefix', path: RPC_CHANNEL, handler: handleRpc }

  /**
   * `connection.rpc.handle(channel, handler)` handler.
   *
   * The installed contract is `(endpoint, payload, signal, peer) =>
   * Promise<{ok:true, value} | {ok:false, error:{code, message, details}}>`
   * (`dsh-client-connection/src/rpc.ts:136-157`). Registering the channel through
   * Connection — instead of only mounting our own webServer route — is what makes
   * `connection.rpc.call('/wps-sync', 'request', …)` work over the carrier the
   * page actually uses, and it keeps the transport's own admission in charge.
   */
  async function rpcHandler(endpoint, payload) {
    try {
      if (endpoint !== 'request') {
        return {
          ok: false,
          error: { code: 'wps-sync/rpc-endpoint', message: `未知 RPC 端点：${String(endpoint)}`, details: {} },
        }
      }
      const body = payload && typeof payload === 'object' ? payload : {}
      if (typeof body.token === 'string' && body.token !== '') assertTokenValue(body.token)
      const action = typeof body.action === 'string' ? body.action : ''
      const value = await dispatch(action, body.args ?? {})
      return { ok: true, value }
    } catch (error) {
      const { body } = failure(error)
      return {
        ok: false,
        error: { code: body.error.code, message: body.error.message, details: {} },
      }
    }
  }

  /** Turn a `Request` into a `Response` for connection.fetch. */
  async function handleFetch(request) {
    try {
      const url = new URL(request.url)
      // A `Request` cannot carry a forbidden `host` header, so the URL
      // authority is the fallback — it is still required to be loopback.
      const host = assertHost({ headers: { host: request.headers.get('host') || url.host } })
      assertOrigin(
        {
          headers: {
            origin: request.headers.get('origin') || '',
            'sec-fetch-site': request.headers.get('sec-fetch-site') || '',
          },
        },
        host,
      )
      const suffix = url.pathname.replace(/\/+$/, '').slice(HTTP_PREFIX.length) || ''
      if (request.method === 'GET' && (suffix === '' || suffix === '/state')) {
        const status = await engine.status({ fresh: true })
        return jsonResponse(200, { ok: true, token, ...status })
      }
      if (request.method !== 'POST') {
        return jsonResponse(405, { ok: false, error: { code: 'wps-sync/method', message: '只支持 GET /state 与 POST 操作' } })
      }
      const supplied = String(request.headers.get('x-wps-sync-token') || '')
      if (!TOKEN_PATTERN.test(supplied) || !crypto.timingSafeEqual(Buffer.from(supplied, 'utf8'), Buffer.from(token, 'utf8'))) {
        return jsonResponse(403, { ok: false, error: { code: 'wps-sync/forbidden-token', message: 'x-wps-sync-token 不匹配' } })
      }
      const raw = await request.text()
      let payload = {}
      if (raw && raw.trim()) {
        try {
          payload = JSON.parse(raw)
        } catch {
          return jsonResponse(400, { ok: false, error: { code: 'wps-sync/body-invalid', message: '请求体不是合法 JSON' } })
        }
      }
      const value = await dispatch(resolveAction(suffix), payload)
      return jsonResponse(200, { ok: true, result: value })
    } catch (error) {
      const { status, body } = failure(error)
      return jsonResponse(status, body)
    }
  }

  function jsonResponse(status, body) {
    if (typeof Response !== 'function') throw notReady('当前运行时不支持 fetch Response', 'wps-sync/no-fetch-response')
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  /**
   * `connection.fetch.register` entries.
   *
   * The installed contract is
   * `{path, methods, requestBody: 'buffered' | 'streaming', fetch(request) => Response}`
   * (`dsh-client-connection/src/rpc.ts:153-176`); the registry copies exactly
   * `methods`, `requestBody` and `fetch` (`src/rpc-host.ts:239-243`) and the
   * shared handler calls `route.fetch(request)` (`src/rpc-host.ts:222`). The
   * legacy `{requestBody:'buffer', handler}` shape that some bundles still pass
   * therefore registers without error but is unusable — those routes have no
   * `fetch`. Keep the current shape; it is validated against the installed type.
   */
  const fetchHandlers = [
    { suffix: '', methods: ['GET'] },
    { suffix: '/state', methods: ['GET'] },
    { suffix: '/upload', methods: ['POST'] },
    { suffix: '/auto', methods: ['POST'] },
    { suffix: '/root', methods: ['POST'] },
    { suffix: '/remote/list', methods: ['POST'] },
    { suffix: '/pull', methods: ['POST'] },
    { suffix: '/restore', methods: ['POST'] },
    { suffix: '/archive', methods: ['POST'] },
  ].map(({ suffix, methods }) => ({
    path: `${HTTP_PREFIX}${suffix}`,
    methods,
    requestBody: 'buffered',
    fetch: (request) => handleFetch(request),
  }))

  return {
    token,
    httpRoute,
    rpcRoute,
    fetchHandlers,
    dispatch,
    handleRequest,
    handleFetch,
    handleRpc,
    rpcHandler,
    resolveAction,
  }
}

module.exports = {
  createBridge,
  createToken,
  ACTIONS,
  resolveAction,
  readJsonBody,
  send,
  failure,
  isTrustedOrigin,
  LOOPBACK_HOST,
  TOKEN_PATTERN,
  SyncError,
}