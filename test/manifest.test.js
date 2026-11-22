'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { DEFAULTS, normalizeConfig } = require('../lib/config')
const { DEFAULT_EXCLUDES, PLUGIN_NAME, HTTP_PREFIX, RPC_CHANNEL } = require('../lib/constants')

const ROOT = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

test('package.json describes a CommonJS host bundle plus a web client', () => {
  assert.equal(pkg.name, PLUGIN_NAME)
  assert.equal(pkg.type, 'commonjs')
  assert.equal(pkg.main, 'index.js')
  assert.match(pkg.engines.dsh, />=0\.2\./)
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject))
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('client.js'))
})

test('every file the package advertises exists on disk', () => {
  for (const entry of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json']) {
    assert.ok(fs.existsSync(path.join(ROOT, entry)), `missing ${entry}`)
  }
  const lib = fs.readdirSync(path.join(ROOT, 'lib')).filter((name) => name.endsWith('.js'))
  assert.ok(lib.length >= 20, `expected the host modules, found ${lib.length}`)
})

test('the locale files carry the bundle metadata the client renders', () => {
  for (const file of ['locale/en.json', 'locale/zh.json']) {
    const locale = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
    assert.ok(locale.meta && typeof locale.meta.title === 'string' && locale.meta.title.length > 0, `${file} meta.title`)
    assert.ok(typeof locale.meta.description === 'string' && locale.meta.description.length > 0, `${file} meta.description`)
  }
})

test('cordis.patch.yml inserts this bundle with the documented defaults', () => {
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: wps-sync/)
  assert.match(patch, new RegExp(`name: ${PLUGIN_NAME}`))
  assert.match(patch, /syncRootDir: ''/)
  assert.match(patch, /autoSync: true/)
  // The patch config must be a subset of what Config accepts; every documented
  // default is present so a fresh install starts from the PLAN's values.
  const config = normalizeConfig(DEFAULTS)
  assert.equal(config.maxFileSizeMB, 20)
  assert.equal(config.workspaceScanIntervalSec, 60)
  assert.equal(config.taskHistoryLimit, 50)
  assert.deepEqual(config.excludePatterns, DEFAULT_EXCLUDES)
})

test('index.js exports the host-entry shape the loader unwraps', () => {
  const entry = require('../index.js')
  assert.equal(entry.name, PLUGIN_NAME)
  assert.equal(entry.name, 'dsh-wps-sync-bundle')
  assert.ok(Array.isArray(entry.inject))
  assert.ok(entry.inject.includes('tools'))
  assert.equal(typeof entry.apply, 'function')
  assert.equal(HTTP_PREFIX, '/api/wps-sync')
  assert.equal(RPC_CHANNEL, '/wps-sync')
})

test('applying the plugin against a fake context registers and disposes cleanly', async () => {
  const entry = require('../index.js')
  const disposers = []
  const registered = { tools: [], listeners: [], effects: [], injections: [] }
  const fake = {
    baseUrl: 'file:///C:/Users/test/.dsh/profiles/web/cordis.patch.yml',
    fiber: { entry: { id: 'wps-sync' } },
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    get: () => undefined,
    effect(callback) {
      disposers.push(callback())
      return disposers.length
    },
    on(event, listener) {
      registered.listeners.push(event)
      return () => {}
    },
    inject(names, callback) {
      registered.injections.push(names)
      return () => {}
    },
    tools: { register: (definition) => { registered.tools.push(definition.name); return () => {} } },
  }

  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'wps-apply-'))
  const previous = process.env.DSH_WPS_SYNC_STATE_DIR
  process.env.DSH_WPS_SYNC_STATE_DIR = dir
  try {
    const applied = entry.apply(fake, { syncRootDir: '', debounceMs: 0 })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(registered.tools.length, 7)
    assert.ok(registered.listeners.includes('session/event'))
    assert.ok(registered.listeners.includes('schedule/changed'))
    assert.ok(registered.injections.some((names) => names.includes('webServer')))
    assert.ok(registered.injections.some((names) => names.includes('connection')))
    for (const dispose of disposers.reverse()) {
      if (typeof dispose === 'function') await dispose()
    }
    assert.equal(typeof applied, 'undefined')
    // `DSH_WPS_SYNC_STATE_DIR` names the plugin's own state directory verbatim;
    // only the profile-derived locations get the `dsh-wps-sync-bundle` subdir.
    assert.ok(fs.existsSync(path.join(dir, 'state.json')), 'state file is written on init')
  } finally {
    if (previous === undefined) delete process.env.DSH_WPS_SYNC_STATE_DIR
    else process.env.DSH_WPS_SYNC_STATE_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})