// Finds stored values in text, in every form a command could print them: as is,
// reversed, hex, URL- or JSON-escaped, base64 at any byte alignment, and any long
// enough piece of those. Pure functions; register.js owns the keychain.
//
// Output (what Claude reads) is matched aggressively. Input (what Claude writes,
// and prompts) matches a short value only as a whole word, so a 4-character key
// can't block every command that happens to contain those letters.

// Below this length a value gets no fragment matching, and input matches it only as a word.
const SHORT = 8
// Shorter fragments would match public key prefixes such as `sk_live_` or `github_pat_`.
const FRAGMENT = 12
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const shields = new WeakMap()

// One shield per loaded key list; a reload brings a new Map and so a new shield.
// Fragments of every long key share one lookup table, so output is scanned once.
export function shieldFor(secrets) {
  let shield = shields.get(secrets)
  if (!shield) {
    const guards = [...secrets].sort((a, b) => b[1].length - a[1].length).map(([name, value]) => guardOf(name, value))
    const windows = new Map()
    for (const guard of guards) {
      if (guard.short) continue
      for (const form of guard.forms) {
        for (let i = 0; i + FRAGMENT <= form.length; i++) {
          const window = form.slice(i, i + FRAGMENT)
          if (!windows.has(window)) windows.set(window, guard.ref)
        }
      }
    }
    shield = { guards, windows }
    shields.set(secrets, shield)
  }
  return shield
}

// mode 'output' for tool results, 'input' for tool input and prompts.
export function maskText(text, shield, mode = 'output') {
  if (!text.includes('\x1b')) return maskPlain(text, shield, mode)
  // Colour codes can split a value, so the text without them decides what must go. Masking
  // in place keeps the colours, and is used only when it removes exactly the same.
  const maskedPlain = maskPlain(text.replace(ANSI, ''), shield, mode)
  const inPlace = maskPlain(text, shield, mode)
  return inPlace.replace(ANSI, '') === maskedPlain ? inPlace : maskedPlain
}

// Masks every string inside a value; returns the same object when nothing changed.
export function maskDeep(value, shield, mode = 'output') {
  if (typeof value === 'string') return maskText(value, shield, mode)
  if (!value || typeof value !== 'object') return value
  let changed = false
  const masked = Array.isArray(value) ? [] : {}
  for (const [key, item] of Object.entries(value)) {
    masked[key] = maskDeep(item, shield, mode)
    changed ||= masked[key] !== item
  }
  return changed ? masked : value
}

// The name of a key whose value, or a piece of it, appears anywhere in `value`.
export function findLeak(value, shield, mode = 'input') {
  const masked = maskDeep(value, shield, mode)
  if (masked === value) return
  const before = JSON.stringify(value)
  const after = JSON.stringify(masked)
  const count = (text, ref) => text.split(ref).length
  return shield.guards.find(guard => count(after, guard.ref) > count(before, guard.ref))?.name
}

function guardOf(name, value) {
  const short = value.length < SHORT
  const forms = formsOf(value)
  return { name, ref: '$' + name, short, forms, word: wordPattern(value) }
}

function maskPlain(text, { guards, windows }, mode) {
  for (const guard of guards) {
    if (guard.short && mode === 'input') text = text.replace(guard.word, () => guard.ref)
    else for (const form of guard.forms) text = text.split(form).join(guard.ref)
  }
  return maskFragments(text, windows)
}

function wordPattern(value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'g')
}

function formsOf(value) {
  const bytes = new TextEncoder().encode(value)
  const hexed = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  const base64 = [0, 1, 2].map(offset => base64Core(bytes, offset))
  return [...new Set([
    value,
    [...value].reverse().join(''),
    hexed,
    hexed.toUpperCase(),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
    ...base64,
    ...base64.map(core => core.replace(/\+/g, '-').replace(/\//g, '_')),
  ])].filter(form => form.length >= 4).sort((a, b) => b.length - a.length)
}

// Base64 of the value as it would appear after `offset` other bytes, keeping only
// the characters drawn wholly from the value's own bytes. Character i encodes
// bits 6i to 6i+5 of the input.
function base64Core(bytes, offset) {
  const padded = new Uint8Array(offset + bytes.length)
  padded.set(bytes, offset)
  const encoded = btoa(String.fromCharCode(...padded))
  const pure = i => Math.floor(6 * i / 8) >= offset && Math.floor((6 * i + 5) / 8) < offset + bytes.length
  let start = 0
  while (start < encoded.length && !pure(start)) start++
  let end = start
  while (end < encoded.length && pure(end)) end++
  return encoded.slice(start, end)
}

function maskFragments(text, windows) {
  if (!windows.size || text.length < FRAGMENT) return text
  let hits
  for (let i = 0; i + FRAGMENT <= text.length; i++) {
    const ref = windows.get(text.slice(i, i + FRAGMENT))
    if (ref === undefined) continue
    hits ??= new Array(text.length)
    hits.fill(ref, i, i + FRAGMENT)
  }
  if (!hits) return text
  let out = ''
  for (let i = 0; i < text.length;) {
    if (hits[i] === undefined) {
      out += text[i++]
      continue
    }
    out += hits[i]
    const ref = hits[i]
    while (hits[i] === ref) i++
  }
  return out
}
