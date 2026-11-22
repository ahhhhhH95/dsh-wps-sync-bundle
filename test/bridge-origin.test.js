'use strict'

/**
 * The origin gate is the only cross-origin surface this bridge has, and it stays
 * that way.
 *
 * The desktop renderer loads `dsh-app://app/`; `protocol.handle('dsh-app')`
 * forwards non-`shell` URLs through `forwardWebRequest`, which refuses any origin
 * other than `dsh-app://app`, rewrites the request onto the host URL, deletes
 * origin/host/cookie/sec-fetch-site and injects the host cookie. A renderer
 * `fetch('/api/wps-sync/state')` is therefore a SAME-ORIGIN `dsh-app://app/...`
 * request that arrives at the loopback server carrying the host cookie â€?no
 * preflight, no `Access-Control-*` needed. The `dsh web` browser form is
 * loopback same-origin for the same reason.
 *
 * Issuing `Access-Control-Allow-Origin` would not enable anything that the
 * shipped transport needs; it would only make the cookie-authenticated loopback
 * bridge readable from arbitrary web origins. These cases are the reverse
 * guardrail: any future CORS "fix" for this plugin has to break one of them
 * first, by design.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

const { createBridge } = require('../lib/bridge')
const { HTTP_PREFIX, RPC_CHANNEL } = require('../lib/constants')

const TOKEN = 'a'.repeat(64)
const LOOPBACK_HOST = '127.0.0.1:53434'
const LOOPBACK_ORIGIN = `http://${LOOPBACK_HOST}`
const DESKTOP_ORIGIN = 'dsh-app://app'

function makeEngine() {
  return {
    status: async () => ({ plugin: 'dsh-wps-sync-bundle', items: 42, queue: { pending: 0 } }),
    upload: async (kind, id, options) => ({ kind, id, options, uploaded: 0 }),
  }
}

function makeBridge(options = {}) {
  return createBridge({ engine: makeEngine(), token: TOKEN, ...options })
}

/** node:http request/response doubles that keep the raw response headers. */
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

function corsHeaders(response) {
  return Object.keys(response.headers).filter((key) => key.toLowerCase().startsWith('access-control-'))
}

function assertNoCorsHeaders(response) {
  assert.deepEqual(corsHeaders(response), [], 'the bridge must never emit Access-Control-* headers')
}

test('OPTIONS preflight is not granted: the method gate answers it exactly like any other verb', async () => {
  const bridge = makeBridge()
  for (const origin of [undefined, LOOPBACK_ORIGIN, DESKTOP_ORIGIN]) {
    const headers = { host: LOOPBACK_HOST, 'access-control-request-method': 'POST' }
    if (origin) headers.origin = origin
    const response = await invoke(bridge.httpRoute.handler, {
      method: 'OPTIONS',
      url: `${HTTP_PREFIX}/state`,
      headers,
    })
    assert.equal(response.status, 405, `OPTIONS must not be granted a 204 (origin: ${origin})`)
    assertNoCorsHeaders(response)
    const body = JSON.parse(response.body)
    assert.equal(body.error.code, 'wps-sync/method')
  }
})

test('OPTIONS on the RPC channel is refused the same way', async () => {
  const bridge = makeBridge()
  const response = await invoke(bridge.rpcRoute.handler, {
    method: 'OPTIONS',
    url: `${RPC_CHANNEL}/request`,
    headers: { host: LOOPBACK_HOST, origin: DESKTOP_ORIGIN },
  })
  assert.equal(response.status, 405)
  const body = JSON.parse(response.body)
  assert.equal((body.result ?? body).error.code, 'wps-sync/rpc-method')
  assertNoCorsHeaders(response)
})

test('a trusted loopback origin is served without any CORS grant', async () => {
  const bridge = makeBridge()
  const response = await invoke(bridge.httpRoute.handler, {
    method: 'GET',
    url: `${HTTP_PREFIX}/state`,
    headers: { host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN },
  })
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, true)
  assert.equal(body.token, TOKEN)
  assert.equal(body.plugin, 'dsh-wps-sync-bundle')
  assertNoCorsHeaders(response)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
})

test('the desktop shell origin passes the gate and receives no CORS grant', async () => {
  const bridge = makeBridge()
  const response = await invoke(bridge.httpRoute.handler, {
    method: 'GET',
    url: `${HTTP_PREFIX}/state`,
    headers: { host: LOOPBACK_HOST, origin: DESKTOP_ORIGIN },
  })
  assert.equal(response.status, 200, 'the dsh-app:// scheme is a first-class client origin')
  assertNoCorsHeaders(response)
})

test('an untrusted origin is refused and gains nothing readable', async () => {
  const bridge = makeBridge()
  for (const origin of ['https://evil.example', 'http://127.0.0.1:9999', 'null']) {
    const response = await invoke(bridge.httpRoute.handler, {
      method: 'GET',
      url: `${HTTP_PREFIX}/state`,
      headers: { host: LOOPBACK_HOST, origin },
    })
    assert.equal(response.status, 403, `origin ${origin} must be refused`)
    const body = JSON.parse(response.body)
    assert.equal(body.error.code, 'wps-sync/forbidden-origin')
    assertNoCorsHeaders(response)
  }
})

test('cross-site fetch metadata is refused even with a plausible origin', async () => {
  const bridge = makeBridge()
  const response = await invoke(bridge.httpRoute.handler, {
    method: 'GET',
    url: `${HTTP_PREFIX}/state`,
    headers: { host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN, 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(response.status, 403)
  const body = JSON.parse(response.body)
  assert.equal(body.error.code, 'wps-sync/forbidden-site')
})

test('a non-loopback Host is refused before anything else', async () => {
  const bridge = makeBridge()
  const response = await invoke(bridge.httpRoute.handler, {
    method: 'GET',
    url: `${HTTP_PREFIX}/state`,
    headers: { host: 'evil.example:53434', origin: 'http://evil.example:53434' },
  })
  assert.equal(response.status, 403)
  const body = JSON.parse(response.body)
  assert.equal(body.error.code, 'wps-sync/forbidden-host')
  assertNoCorsHeaders(response)
})

test('a token-bearing POST is served and still carries no CORS headers', async () => {
  const bridge = makeBridge()
  const response = await invoke(bridge.httpRoute.handler, {
    method: 'POST',
    url: `${HTTP_PREFIX}/upload`,
    headers: {
      host: LOOPBACK_HOST,
      origin: LOOPBACK_ORIGIN,
      'content-type': 'application/json',
      'x-wps-sync-token': TOKEN,
    },
    body: { kind: 'all' },
  })
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, true)
  assertNoCorsHeaders(response)
})

test('a tokenless POST is still 403 and gets no CORS grant to read it with', async () => {
  const bridge = makeBridge()
  for (const origin of [LOOPBACK_ORIGIN, DESKTOP_ORIGIN]) {
    const response = await invoke(bridge.httpRoute.handler, {
      method: 'POST',
      url: `${HTTP_PREFIX}/upload`,
      headers: { host: LOOPBACK_HOST, origin, 'content-type': 'application/json' },
      body: { kind: 'all' },
    })
    assert.equal(response.status, 403, 'the bearer is still mandatory for POST')
    const body = JSON.parse(response.body)
    assert.equal(body.error.code, 'wps-sync/forbidden-token')
    assertNoCorsHeaders(response)
  }

  const wrong = await invoke(bridge.httpRoute.handler, {
    method: 'POST',
    url: `${HTTP_PREFIX}/upload`,
    headers: {
      host: LOOPBACK_HOST,
      origin: LOOPBACK_ORIGIN,
      'content-type': 'application/json',
      'x-wps-sync-token': 'b'.repeat(64),
    },
    body: { kind: 'all' },
  })
  assert.equal(wrong.status, 403)
  assert.equal(JSON.parse(wrong.body).error.code, 'wps-sync/forbidden-token')
})

test('the Request-based fetch carrier also refuses OPTIONS and emits no CORS headers', async () => {
  const bridge = makeBridge()
  const entry = bridge.fetchHandlers.find((route) => route.path === `${HTTP_PREFIX}/state`)
  assert.ok(entry, 'the /state fetch route must exist')

  const get = await entry.fetch(
    new Request(`${LOOPBACK_ORIGIN}${HTTP_PREFIX}/state`, {
      headers: { origin: LOOPBACK_ORIGIN },
    }),
  )
  assert.equal(get.status, 200)
  assert.equal(get.headers.get('access-control-allow-origin'), null)
  assert.equal(get.headers.get('access-control-allow-credentials'), null)

  const options = await entry.fetch(
    new Request(`${LOOPBACK_ORIGIN}${HTTP_PREFIX}/state`, {
      method: 'OPTIONS',
      headers: { origin: LOOPBACK_ORIGIN, 'access-control-request-method': 'POST' },
    }),
  )
  assert.equal(options.status, 405)
  assert.equal(options.headers.get('access-control-allow-origin'), null)

  const foreign = await entry.fetch(
    new Request(`${LOOPBACK_ORIGIN}${HTTP_PREFIX}/state`, {
      headers: { origin: 'https://evil.example' },
    }),
  )
  assert.equal(foreign.status, 403)
  assert.equal(foreign.headers.get('access-control-allow-origin'), null)
})

test('the bridge source contains no CORS support at all', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'lib', 'bridge.js'), 'utf8')
  assert.equal(/access-control/i.test(source), false, 'no Access-Control header may be emitted')
  assert.equal(/allow-credentials/i.test(source), false)
  assert.equal(/204/.test(source), false, 'nothing may answer a preflight with 204')
})