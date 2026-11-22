'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const CLIENT_PATH = path.join(__dirname, '..', 'client.js')

/**
 * Blank out string/template/comment contents so the scan only looks at code.
 * Length is preserved where practical, but we do not rely on offsets.
 */
function stripLiteralsAndComments(source) {
  let output = ''
  let index = 0
  let state = 'code'
  while (index < source.length) {
    const char = source[index]
    const next = index + 1 < source.length ? source[index + 1] : ''
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line'
        output += '  '
        index += 2
        continue
      }
      if (char === '/' && next === '*') {
        state = 'block'
        output += '  '
        index += 2
        continue
      }
      if (char === "'" || char === '"' || char === '`') {
        state = char
        output += ' '
        index += 1
        continue
      }
      output += char
      index += 1
      continue
    }
    if (state === 'line') {
      if (char === '\n') {
        state = 'code'
        output += '\n'
      } else {
        output += ' '
      }
      index += 1
      continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code'
        output += '  '
        index += 2
        continue
      }
      output += char === '\n' ? '\n' : ' '
      index += 1
      continue
    }
    // Inside a quoted string or template literal.
    if (char === '\\') {
      output += '  '
      index += 2
      continue
    }
    if (char === state) {
      state = 'code'
      output += ' '
      index += 1
      continue
    }
    output += char === '\n' ? '\n' : ' '
    index += 1
  }
  return output
}

/** Return the first argument text for the `h(` call whose `(` starts at openIndex. */
function readFirstArgument(code, openIndex) {
  let depth = 0
  let index = openIndex + 1
  const start = index
  while (index < code.length) {
    const char = code[index]
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) return code.slice(start, index)
      depth -= 1
    } else if (char === ',' && depth === 0) {
      return code.slice(start, index)
    }
    index += 1
  }
  return code.slice(start)
}

const INVOKED_TYPE = /^\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/

/** Find `h(SomeCall())` / `h(obj.Make())` element-as-type mistakes. */
function findInvokedTypeCalls(source) {
  const code = stripLiteralsAndComments(source)
  const matches = []
  const pattern = /\bh\s*\(/g
  let match = pattern.exec(code)
  while (match) {
    const openIndex = match.index + match[0].length - 1
    const firstArgument = readFirstArgument(code, openIndex)
    if (INVOKED_TYPE.test(firstArgument)) {
      const before = code.slice(0, match.index)
      const line = before.split('\n').length
      matches.push({ line, firstArgument: firstArgument.trim().replace(/\s+/g, ' ') })
    }
    match = pattern.exec(code)
  }
  return matches
}

test('client.js has no React element passed as an element type', () => {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  const calls = source.match(/\bh\s*\(/g) || []
  assert.ok(calls.length > 100, `expected many h() calls, found ${calls.length}`)
  const violations = findInvokedTypeCalls(source)
  assert.deepEqual(
    violations,
    [],
    'createElement first argument must be a component/type, not a call result:\n' +
      violations.map((item) => `  line ${item.line}: h(${item.firstArgument}...)`).join('\n'),
  )
})

test('invoked-type scanner detects h(Component()) and ignores h(Component, ...)', () => {
  assert.equal(findInvokedTypeCalls('const a = h(Spinner())').length, 1)
  assert.equal(findInvokedTypeCalls('const a = h(Spinner(), 1)').length, 1)
  assert.equal(findInvokedTypeCalls('const a = h(React.Fragment())').length, 1)
  assert.equal(findInvokedTypeCalls('const a = h(Spinner)').length, 0)
  assert.equal(findInvokedTypeCalls("const a = h('div', null, h(Spinner), 'x')").length, 0)
  assert.equal(findInvokedTypeCalls('// h(Spinner())\nconst a = h(Spinner, {})').length, 0)
  assert.equal(findInvokedTypeCalls('/* h(Spinner()) */ const a = h(Spinner)').length, 0)
})

test('client.js keeps its module-loader entry and Spinner component', () => {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.match(source, /id:\s*'dsh-wps-sync-bundle'/)
  assert.match(source, /function Spinner\s*\(/)
})