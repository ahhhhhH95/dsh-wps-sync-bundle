'use strict'

/**
 * Content hashing.
 *
 * The hash of an item is derived from the hashes of its files, sorted by their
 * archive-relative POSIX path. That makes it stable across devices and across
 * file-system write order, which is what the "identical hashes on the second
 * device" acceptance check compares.
 */

const crypto = require('node:crypto')

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function hashBuffer(buffer) {
  return sha256Hex(buffer)
}

function hashText(text) {
  return sha256Hex(Buffer.from(String(text), 'utf8'))
}

/**
 * Combine per-file hashes into one item hash.
 *
 * @param {Iterable<{path: string, hash: string}>} files archive-relative paths
 * @returns {string} hex digest
 */
function hashFiles(files) {
  const rows = Array.from(files, (file) => `${normalize(file.path)}\u0000${file.hash}`)
  rows.sort()
  return sha256Hex(rows.join('\n'))
}

function normalize(value) {
  return String(value).replace(/\\/g, '/')
}

module.exports = { sha256Hex, hashBuffer, hashText, hashFiles }