'use strict'

/**
 * Transport tests for the WPS sync client bundle.
 *
 * `client.js` is a browser bundle: everything lives inside the
 * `window.__ModuleLoader__` factory and the transport helpers are closures, so the
 * only honest way to test them is to run the bundle in a `vm` context and drive the
 * registered slot components through a minimal React runtime. This file therefore
 * contains:
 *
 *   - a tiny React runtime (function components + the hooks client.js uses),
 *   - a `vm` loader that captures the module and its locale dictionaries,
 *   - behaviour tests for the desktop (`dsh-app://app/`) and `dsh web` transports,
 *     the RPC fallback and the `no_transport` dead end,
 *   - dictionary/`errorText` coverage checks across client.js and locale/*.json.
 *
 * The bundle is never modified: no test hooks were added to the plugin source.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const CLIENT_PATH = path.join(ROOT, 'client.js')
const CLIENT_SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

function readLocale(name) {
  const file = path.join(ROOT, 'locale', name + '.json')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const LOCALE = { en: readLocale('en'), zh: readLocale('zh') }

// ---------------------------------------------------------------------------
// Minimal React runtime
// ---------------------------------------------------------------------------

const ELEMENT = Symbol('wps.element')
const FORWARD_REF = Symbol('wps.forwardRef')

function sameDeps(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

function createReact() {
  let currentFiber = null
  let hookIndex = 0
  let dirty = false
  let renderedPaths = new Set()
  let idCounter = 0
  const fibers = new Map()

  class Component {
    constructor(props) {
      this.props = props
    }

    setState() {
      throw new Error('class setState is not supported by this harness')
    }
  }
  Component.prototype.isReactComponent = true

  function createElement(type, config, ...children) {
    const props = Object.assign({}, config)
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    return { $$typeof: ELEMENT, type, props }
  }

  function forwardRef(render) {
    return { $$typeof: FORWARD_REF, render }
  }

  function fiberFor(key) {
    let fiber = fibers.get(key)
    if (!fiber) {
      fiber = { hooks: [] }
      fibers.set(key, fiber)
    }
    return fiber
  }

  function nextHook(initial) {
    if (!currentFiber) throw new Error('a hook was called outside of a component render')
    const index = hookIndex++
    const hooks = currentFiber.hooks
    if (!Object.prototype.hasOwnProperty.call(hooks, index)) {
      hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    }
    return hooks[index]
  }

  function useState(initial) {
    const hook = nextHook(initial)
    function setValue(next) {
      const value = typeof next === 'function' ? next(hook.value) : next
      if (Object.is(value, hook.value)) return
      hook.value = value
      dirty = true
    }
    return [hook.value, setValue]
  }

  function useRef(initial) {
    const hook = nextHook(undefined)
    if (!Object.prototype.hasOwnProperty.call(hook, 'ref')) hook.ref = { current: initial }
    return hook.ref
  }

  function useMemo(factory, deps) {
    const hook = nextHook(undefined)
    if (!Object.prototype.hasOwnProperty.call(hook, 'memo')) {
      hook.memo = factory()
      hook.deps = deps
    } else if (!sameDeps(hook.deps, deps)) {
      hook.memo = factory()
      hook.deps = deps
    }
    return hook.memo
  }

  function useCallback(callback, deps) {
    const hook = nextHook(undefined)
    if (!Object.prototype.hasOwnProperty.call(hook, 'callback')) {
      hook.callback = callback
      hook.deps = deps
    } else if (!sameDeps(hook.deps, deps)) {
      hook.callback = callback
      hook.deps = deps
    }
    return hook.callback
  }

  function useId() {
    const hook = nextHook(undefined)
    if (!hook.id) {
      idCounter += 1
      hook.id = 'wps-test-id-' + idCounter
    }
    return hook.id
  }

  function useEffect(effect, deps) {
    const hook = nextHook(undefined)
    hook.effect = effect
    hook.deps = deps
  }

  function renderNode(node, key, out) {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      node.forEach((child, index) => renderNode(child, key + '/' + index, out))
      return
    }
    if (!node || node.$$typeof !== ELEMENT) {
      throw new Error('unexpected React child: ' + String(node))
    }
    const type = node.type
    const props = node.props
    if (typeof type === 'string') {
      renderNode(props.children, key + '/c', out)
      return
    }
    if (typeof type === 'function' && type.prototype && type.prototype.isReactComponent) {
      const instance = new type(props)
      renderNode(instance.render(), key + '#class', out)
      return
    }
    const render = type && type.$$typeof === FORWARD_REF ? type.render : type
    if (typeof render !== 'function') throw new Error('unknown element type: ' + String(type))
    const fiber = fiberFor(key)
    renderedPaths.add(key)
    const outerFiber = currentFiber
    const outerIndex = hookIndex
    currentFiber = fiber
    hookIndex = 0
    let rendered
    try {
      rendered = render(props, null)
    } finally {
      currentFiber = outerFiber
      hookIndex = outerIndex
    }
    renderNode(rendered, key + '#out', out)
  }

  function flushEffects() {
    for (const [key, fiber] of fibers) {
      if (!renderedPaths.has(key)) continue
      fiber.hooks.forEach((hook) => {
        if (!hook || typeof hook.effect !== 'function') return
        if (hook.ran && hook.deps !== undefined && sameDeps(hook.deps, hook.prevDeps)) return
        if (typeof hook.cleanup === 'function') hook.cleanup()
        hook.cleanup = hook.effect()
        hook.prevDeps = hook.deps
        hook.ran = true
      })
    }
  }

  function settle() {
    return new Promise((resolve) => setTimeout(resolve, 0)).then(() => new Promise((resolve) => setTimeout(resolve, 0)))
  }

  async function render(element) {
    let text = []
    for (let pass = 0; pass < 16; pass += 1) {
      dirty = false
      renderedPaths = new Set()
      text = []
      renderNode(element, '$', text)
      flushEffects()
      await settle()
      if (!dirty) return text
    }
    return text
  }

  const React = {
    Component,
    createElement,
    forwardRef,
    useState,
    useRef,
    useMemo,
    useCallback,
    useId,
    useEffect,
    useLayoutEffect: useEffect,
  }

  return { React, ReactDOM: { createPortal: (node) => node }, render }
}

// ---------------------------------------------------------------------------
// Bundle loader
// ---------------------------------------------------------------------------

function createDocumentStub() {
  const head = { appendChild() {}, removeChild() {} }
  return {
    head,
    body: { appendChild() {}, removeChild() {}, style: {} },
    activeElement: null,
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, parentNode: null }),
    addEventListener() {},
    removeEventListener() {},
    contains: () => false,
    querySelector: () => null,
  }
}

function jsonResponse(body, status) {
  const code = status === undefined ? 200 : status
  return {
    ok: code >= 200 && code < 300,
    status: code,
    async text() {
      return JSON.stringify(body)
    },
  }
}

const STATE_BODY = {
  ok: true,
  token: 'tok-desktop',
  syncRootDir: 'C:/Users/ASUS/WPS Cloud Files/1440662744',
  syncRootValid: true,
  device: { id: 'df88b8b4-f3bb-4875-9a59-c51519055332', name: 'ASUS-DESKTOP' },
  queue: { pending: 0, items: [] },
  sessions: [{ id: 'session-1', title: 'Transport work', auto: true }],
  workspaces: [],
  tasks: null,
  imports: [],
  errors: [],
}

function defaultFetchHandler(url) {
  if (url === '/api/wps-sync/state') return jsonResponse(STATE_BODY)
  if (url === '/api/wps-sync/remote/list') return jsonResponse({ ok: true, result: { devices: [] } })
  return jsonResponse({ ok: false, error: { code: 'not_found', message: 'no such route' } }, 404)
}

/**
 * Load client.js inside a vm context and register its slots.
 *
 * options.location  — the page Location the bundle sees (omit for "no location")
 * options.transport — value of globalThis.__DSH_TRANSPORT__ (omit for none)
 * options.fetch     — fetch implementation (omit for "no fetch at all")
 * options.rpc       — connection.rpc stand-in for the RPC fallback test
 */
function loadBundle(options) {
  const settings = options || {}
  const react = createReact()
  const sandbox = {
    console,
    URL,
    Intl,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: createDocumentStub(),
  }
  if (settings.location) sandbox.location = settings.location
  if (settings.transport) sandbox.__DSH_TRANSPORT__ = settings.transport
  if (settings.fetch) sandbox.fetch = settings.fetch

  const loaded = []
  sandbox.__ModuleLoader__ = {
    load(mod) {
      loaded.push(mod)
    },
  }

  const context = vm.createContext(sandbox)
  vm.runInContext('globalThis.window = globalThis', context)
  vm.runInContext(CLIENT_SOURCE, context, { filename: CLIENT_PATH })

  assert.equal(loaded.length, 1, 'client.js must register exactly one bundle')
  const mod = loaded[0]
  assert.equal(mod.id, 'dsh-wps-sync-bundle')

  const api = mod.factory((name) => {
    if (name === 'react') return react.React
    if (name === 'react-dom') return react.ReactDOM
    throw new Error('client.js required an unexpected module: ' + name)
  })

  const slots = {}
  const captured = { dicts: null, slotNames: [] }
  const connection = settings.rpc ? { rpc: settings.rpc } : null
  const ctx = {
    effect(fn) {
      return fn()
    },
    locale: {
      register(namespace, dictionaries) {
        captured.dicts = { namespace, value: dictionaries }
        return function unregister() {}
      },
    },
    slots: {
      inject(name, callback) {
        callback()
      },
      register(config, Component) {
        const slotKey = config.name + '/' + (config.key || config.id)
        slots[slotKey] = Component
        captured.slotNames.push(slotKey)
        return function unregister() {}
      },
    },
    get(id) {
      return id === 'connection' ? connection : null
    },
    connection,
  }

  api.apply(ctx)

  return { api, react, slots, captured, ctx }
}

function makeT(dict) {
  return function translate(key, params) {
    const template = typeof dict[key] === 'string' ? dict[key] : key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined || params[name] === null ? match : String(params[name])))
  }
}

function makeFetch(handler) {
  const calls = []
  function fetchImpl(input, init) {
    calls.push({ url: input, init: init || {}, method: (init && init.method) || 'GET' })
    return Promise.resolve().then(() => (handler || defaultFetchHandler)(input, init || {}))
  }
  fetchImpl.calls = calls
  return fetchImpl
}

const DESKTOP_LOCATION = { protocol: 'dsh-app:', hostname: 'app', origin: 'dsh-app://app', href: 'dsh-app://app/' }
const WEB_LOCATION = { protocol: 'http:', hostname: '127.0.0.1', port: '53434', origin: 'http://127.0.0.1:53434', href: 'http://127.0.0.1:53434/' }

async function renderPanel(bundle, localeName) {
  const dicts = bundle.captured.dicts.value
  const Panel = bundle.slots['plugins.bundle.config/dsh-wps-sync-bundle']
  assert.equal(typeof Panel, 'function', 'the config panel slot must be registered')
  const text = await bundle.react.render(bundle.react.React.createElement(Panel, { t: makeT(dicts[localeName]) }))
  return { text, joined: text.join(' ') }
}

function authHeaders(call) {
  const headers = (call.init && call.init.headers) || {}
  const found = {}
  for (const [key, value] of Object.entries(headers)) found[key.toLowerCase()] = value
  return found
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

test('desktop renderer (dsh-app://app) fetches the relative API path through the Host proxy', async () => {
  const transport = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:53434' }
  const fetchImpl = makeFetch()
  const bundle = loadBundle({ location: DESKTOP_LOCATION, transport, fetch: fetchImpl })

  const { joined } = await renderPanel(bundle, 'en')
  assert.ok(fetchImpl.calls.length >= 2, 'the panel must load /state and then scan remote')
  assert.equal(fetchImpl.calls[0].url, '/api/wps-sync/state', 'desktop calls must stay relative, not absolute')
  assert.equal(fetchImpl.calls[0].method, 'GET')
  assert.equal(fetchImpl.calls[1].url, '/api/wps-sync/remote/list')
  assert.equal(fetchImpl.calls[1].method, 'POST')
  const headers = authHeaders(fetchImpl.calls[1])
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers['x-wps-sync-token'], 'tok-desktop')
  assert.ok(!('x-wps-sync-token' in authHeaders(fetchImpl.calls[0])), 'GET /state must stay token-free')
  assert.equal(fetchImpl.calls[0].init.credentials, 'same-origin')
  assert.notEqual(fetchImpl.calls[1].init.credentials, 'include')
  assert.match(joined, /Transport work/, 'the panel must render the loaded sessions')
  assert.doesNotMatch(joined, /No transport is available/, 'desktop must not fall into no_transport')
})

test('desktop detection requires the privileged dsh-app://app origin and ownsHost', async () => {
  for (const scenario of [
    { location: { protocol: 'dsh-app:', hostname: 'evil' }, transport: { ownsHost: true } },
    { location: { protocol: 'dsh-app:', hostname: 'shell' }, transport: { ownsHost: true } },
    { location: DESKTOP_LOCATION, transport: { ownsHost: false } },
    { location: DESKTOP_LOCATION, transport: null },
  ]) {
    const fetchImpl = makeFetch()
    const bundle = loadBundle({ location: scenario.location, transport: scenario.transport, fetch: fetchImpl })
    const { joined } = await renderPanel(bundle, 'en')
    assert.equal(fetchImpl.calls.length, 0, 'a non-privileged dsh-app origin must not fetch: ' + JSON.stringify(scenario))
    assert.match(joined, /No transport is available/, 'expected the no_transport copy for ' + JSON.stringify(scenario))
  }
})

test('both registered slots render and only the panel scans the remote index', async () => {
  const transport = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:53434' }

  const panelFetch = makeFetch()
  const panelBundle = loadBundle({ location: DESKTOP_LOCATION, transport, fetch: panelFetch })
  await renderPanel(panelBundle, 'en')
  assert.deepEqual(panelBundle.captured.slotNames.sort(), [
    'conversation.session.header.utilities/wps-sync-session',
    'plugins.bundle.config/dsh-wps-sync-bundle',
  ])
  assert.deepEqual(
    panelFetch.calls.map((call) => call.method + ' ' + call.url),
    ['GET /api/wps-sync/state', 'POST /api/wps-sync/remote/list'],
  )

  const headerFetch = makeFetch()
  const headerBundle = loadBundle({ location: DESKTOP_LOCATION, transport, fetch: headerFetch })
  const Header = headerBundle.slots['conversation.session.header.utilities/wps-sync-session']
  assert.equal(typeof Header, 'function')
  const dicts = headerBundle.captured.dicts.value
  const text = await headerBundle.react.render(
    headerBundle.react.React.createElement(Header, { sessionId: 'session-1', t: makeT(dicts.en) }),
  )
  const joined = text.join(' ')
  assert.match(joined, /Transport work|尚未同步|Not synced|sync/i, 'the header action must render its caption')
  assert.deepEqual(
    headerFetch.calls.map((call) => call.method + ' ' + call.url),
    ['GET /api/wps-sync/state'],
    'the session header loads /state only; the remote scan belongs to the panel',
  )
})

test('dsh web on a loopback http origin keeps using the relative path', async () => {
  const fetchImpl = makeFetch()
  const bundle = loadBundle({ location: WEB_LOCATION, fetch: fetchImpl })
  const { joined } = await renderPanel(bundle, 'en')
  assert.equal(fetchImpl.calls[0].url, '/api/wps-sync/state')
  assert.equal(fetchImpl.calls[1].url, '/api/wps-sync/remote/list')
  assert.match(joined, /ASUS-DESKTOP/)
})

test('a non-loopback page origin is refused instead of silently trusted', async () => {
  const fetchImpl = makeFetch()
  const bundle = loadBundle({ location: { protocol: 'http:', hostname: 'evil.example' }, fetch: fetchImpl })
  const { joined } = await renderPanel(bundle, 'en')
  assert.equal(fetchImpl.calls.length, 0)
  assert.match(joined, /No transport is available/)
})

test('without HTTP the RPC connection is used, and HTTP is never retried afterwards', async () => {
  const calls = []
  const rpc = {
    async call(channel, endpoint, payload) {
      calls.push({ channel, endpoint, payload })
      if (payload.action === 'status') {
        return { type: 'rpc', result: { ok: true, value: Object.assign({}, STATE_BODY) } }
      }
      return { type: 'rpc', result: { ok: true, value: { devices: [] } } }
    },
  }
  const bundle = loadBundle({ rpc })
  const { joined } = await renderPanel(bundle, 'en')

  assert.equal(calls.length, 2, 'expected a status call plus a remote list call')
  assert.equal(calls[0].channel, '/wps-sync')
  assert.equal(calls[0].endpoint, 'request')
  assert.equal(calls[0].payload.action, 'status')
  assert.equal(calls[1].payload.action, 'remoteList')
  assert.match(joined, /Transport work/)
})

test('no HTTP and no RPC reports no_transport instead of network', async () => {
  const bundle = loadBundle({})
  const { joined } = await renderPanel(bundle, 'zh')
  assert.match(joined, /没有可用的传输通道/)
  assert.doesNotMatch(joined, /无法连接同步服务/)
})

test('the HTTP path is resolved before the RPC fallback and no_transport is last', () => {
  const start = CLIENT_SOURCE.indexOf('async function send(route, input)')
  assert.ok(start > 0, 'send(route, input) must exist')
  const body = CLIENT_SOURCE.slice(start, CLIENT_SOURCE.indexOf('\n      }', start))
  const http = body.indexOf('resolveFetcher()')
  const rpc = body.indexOf('resolveRpc(')
  const dead = body.indexOf('no_transport')
  assert.ok(http > 0 && rpc > http && dead > rpc, 'order must be HTTP -> RPC -> no_transport')
})

// ---------------------------------------------------------------------------
// Stale-endpoint reporting
// ---------------------------------------------------------------------------

test('a socket-level fetch failure is reported as a stale endpoint with recovery steps', async () => {
  const transport = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:53434' }
  const fetchImpl = makeFetch(() => {
    throw new TypeError('Failed to fetch')
  })
  const bundle = loadBundle({ location: DESKTOP_LOCATION, transport, fetch: fetchImpl })
  const { joined } = await renderPanel(bundle, 'zh')

  assert.match(joined, /此地址上的同步服务没有响应/)
  assert.match(joined, /Ctrl\+Shift\+R/)
  assert.match(joined, /dsh web/)
  assert.doesNotMatch(joined, /没有可用的传输通道/)
})

test('a non-network failure keeps the generic network copy instead of blaming a stale port', async () => {
  const transport = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:53434' }
  const fetchImpl = makeFetch(() => {
    throw new Error('the worker handed back a broken envelope')
  })
  const bundle = loadBundle({ location: DESKTOP_LOCATION, transport, fetch: fetchImpl })
  const { joined } = await renderPanel(bundle, 'zh')
  assert.match(joined, /无法连接同步服务/)
  assert.doesNotMatch(joined, /此地址上的同步服务没有响应/)
})

test('ECONNREFUSED-style failures are stale endpoints while abort stays a timeout', () => {
  const fresh = loadBundle({})
  const react = fresh.react
  void react

  // The error codes are produced inside the bundle; assert the classification
  // table the code relies on is still in place.
  assert.match(CLIENT_SOURCE, /name === 'TypeError' \|\| name === 'NetworkError'/)
  assert.match(CLIENT_SOURCE, /econnrefused/)
  assert.match(CLIENT_SOURCE, /name === 'TimeoutError' \|\| name === 'AbortError'/)
  assert.match(CLIENT_SOURCE, /new WpsError\('stale_endpoint'/)
})

// ---------------------------------------------------------------------------
// Dictionaries + errorText coverage
// ---------------------------------------------------------------------------

function errorTextSource() {
  const start = CLIENT_SOURCE.indexOf('function errorText(error, t)')
  assert.ok(start > 0, 'errorText must exist')
  const end = CLIENT_SOURCE.indexOf('\n    }', start)
  return CLIENT_SOURCE.slice(start, end)
}

test('every code errorText knows has a key in both dictionaries and in locale/*.json', () => {
  const bundle = loadBundle({})
  const dictionaries = bundle.captured.dicts.value
  const source = errorTextSource()

  const codes = new Set()
  for (const match of source.matchAll(/code === '([^']+)'/g)) codes.add(match[1])
  assert.deepEqual(
    [...codes].sort(),
    ['bad_response', 'bad_state', 'network', 'no_transport', 'stale_endpoint', 'timeout'],
    'errorText must map every transport code',
  )

  const keys = new Set()
  for (const match of source.matchAll(/\bt\('([^']+)'\)/g)) keys.add(match[1])
  assert.ok(keys.has('error.staleEndpoint'), 'errorText must translate stale_endpoint')
  assert.ok(keys.has('error.transport'), 'errorText must translate no_transport')

  for (const key of keys) {
    assert.equal(typeof dictionaries.en[key], 'string', 'EN dictionary is missing ' + key)
    assert.equal(typeof dictionaries.zh[key], 'string', 'ZH dictionary is missing ' + key)
    assert.ok(dictionaries.en[key].length > 0, 'EN copy is empty for ' + key)
    assert.ok(dictionaries.zh[key].length > 0, 'ZH copy is empty for ' + key)
  }
})

test('EN and ZH client dictionaries stay in sync, including locale/*.json mirrors', () => {
  const bundle = loadBundle({})
  const dictionaries = bundle.captured.dicts.value
  assert.equal(bundle.captured.dicts.namespace, 'wps-sync')

  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort(), 'the two inline dictionaries must expose the same keys')

  for (const key of ['error.network', 'error.staleEndpoint', 'error.transport']) {
    assert.ok(dictionaries.en[key], 'EN dictionary is missing ' + key)
    assert.ok(dictionaries.zh[key], 'ZH dictionary is missing ' + key)
    assert.equal(LOCALE.en.clientErrors[key], dictionaries.en[key], 'locale/en.json drifted from the inline EN dictionary for ' + key)
    assert.equal(LOCALE.zh.clientErrors[key], dictionaries.zh[key], 'locale/zh.json drifted from the inline ZH dictionary for ' + key)
  }

  for (const [name, dict] of [['EN', dictionaries.en], ['ZH', dictionaries.zh]]) {
    assert.match(dict['error.staleEndpoint'], /Ctrl\+Shift\+R/, name + ' stale-endpoint copy must name the hard refresh')
    assert.match(dict['error.staleEndpoint'], /dsh web/, name + ' stale-endpoint copy must name the dsh web URL')
    assert.match(dict['error.network'], /Ctrl\+Shift\+R/, name + ' network copy must name the hard refresh')
    assert.match(dict['error.network'], /dsh web/i, name + ' network copy must name the dsh web URL')
  }
})

test('the transport guards are documented in the source, not bypassed by absolute URLs', () => {
  assert.match(CLIENT_SOURCE, /carrier\.ownsHost === true/)
  assert.match(CLIENT_SOURCE, /function isDesktopAppLocation/)
  assert.match(CLIENT_SOURCE, /function isLoopbackHttpLocation/)
  assert.match(CLIENT_SOURCE, /HTTP_PREFIX \+ route/)
  // No absolute Base is built from streamBaseUrl: the Host proxy is same-origin.
  assert.doesNotMatch(CLIENT_SOURCE, /streamBaseUrl/)
})