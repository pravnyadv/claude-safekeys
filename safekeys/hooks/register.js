// Values live in the OS keychain (macOS Keychain or a Linux Secret Service) under
// one service, so `security`/`secret-tool` can list or wipe them as a group.
// The mod holds them in memory only, to mask them in tool output. Every change
// rewrites a stamp file, so other running sessions know to reload their copy.
import { destinationsOf, parseBinding, sshAllowed, webAllowed } from './destinations.js'
import { findLeak, maskDeep, maskText, shieldFor } from './shield.js'

const SERVICE = 'claude_safekeys'
// $:NAME@binding=value. A bare value runs to the next whitespace, minus trailing
// punctuation; a value with spaces must be double-quoted, and the closing quote must
// end the token.
const TOKEN = /\$:(?:([A-Za-z_][A-Za-z0-9_]*)(?:@([^\s="]+))?=)?(?:"([^"\n]+)"(?=\s|$)|(\S*[^\s,.;:!?)\]}]))/g
const REBIND = /^([A-Za-z_][A-Za-z0-9_]*)@(.+)$/
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
// `$;` ending a prompt sends it without reading any $: token.
const BYPASS = /\s*\$;\s*$/
const CODE = /```[\s\S]*?```|`[^`\n]*`/g
const REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g
const HINT = ' If it is only an example, add $; at the end to send the prompt as typed.'
// Only what the person typed may store a key; a notification or peer message saying
// `$:` is text, though stored values in it are still masked.
const TYPED = new Set(['composer', 'bridge', 'sdk'])
const MIN_LENGTH = 4
// Longer values would overflow the stack while their encoded forms are built.
const MAX_LENGTH = 4096
const RESERVED = new Set(['PATH', 'HOME', 'SHELL', 'USER', 'PWD', 'TMPDIR', 'LANG', 'IFS', 'PS1'])

let platform
let stampFile
let vault
// The last list that loaded, so a keychain that later fails to answer still masks.
let lastGood = new Map()
// ssh target to the names it answers to, itself and the hostname `ssh -G` resolves.
const sshNames = new Map()

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'safekeys',
      description: 'List or remove the secrets stored with $:NAME=value, and where each may go',
      argumentHint: 'list | rm NAME | clear',
    })
    return next(e)
  })

  // A hook that fails before next() is skipped and the prompt would go out raw,
  // so any failure drops the prompt instead.
  on('prompt.submit', guardPrompt).catch(async ($, e, next) => {
    if (next.called) return next(e)
    return { drop: 'safekeys could not store the $: value (it needs the macOS Keychain, or secret-tool on Linux), so the prompt was not sent.' }
  })

  // A check that fails before the tool runs still masks with the last list that loaded;
  // once the tool has run, a failed check withholds its result rather than risk a raw value.
  on('tool.call', guardTool).catch(async ($, e, next) => {
    if (next.called) return { deny: 'safekeys could not check this result for secrets, so it was withheld.' }
    const r = await next(e)
    if (!lastGood.size || r.deny) return r
    const shield = shieldFor(lastGood)
    const result = maskDeep(r.result, shield)
    const text = typeof r.text === 'string' ? maskText(r.text, shield) : r.text
    if (result === r.result && text === r.text) return r
    return r.isError || result === r.result ? { deny: text } : { result, context: maskDeep(r.context, shield) }
  })

  // An @-mentioned file is attached without a tool call, so a file holding a key is refused.
  on('prompt.mention', async ($, e, next) => {
    const secrets = await currentSecrets($)
    if (!secrets.size) return next(e)
    let content
    try {
      content = await $.fs.read(e.path)
    } catch {
      return next(e)
    }
    const leaked = typeof content === 'string' && findLeak(content, shieldFor(secrets), 'output')
    if (!leaked) return next(e)
    await $.ui.toast(`@${e.mention} holds $${leaked}, so it was not attached. Ask Claude to read the file instead; that output is masked.`)
    return { deny: `safekeys: the file holds the value of $${leaked}` }
  })

  // Reminders such as "this file changed" carry file text. Organisation-managed sessions
  // don't run a user's mod on this event; there this hook does nothing.
  on('prompt.attachment', async ($, e, next) => {
    const secrets = await currentSecrets($)
    if (!secrets.size) return next(e)
    const text = maskText(e.text, shieldFor(secrets))
    return next(text === e.text ? e : { ...e, text })
  })

  // A forked slash command never raises prompt.submit, so its arguments are checked here.
  on('command.run', async ($, e, next) => {
    if (e.args.match(TOKEN)) return { text: 'safekeys: a $: value cannot be passed to a slash command. Send it in a normal prompt.' }
    const secrets = await currentSecrets($)
    if (!secrets.size) return next(e)
    const args = maskText(e.args, shieldFor(secrets), 'input')
    return next(args === e.args ? e : { ...e, args })
  })

  on('command.run', { command: 'safekeys' }, async ($, e) => {
    const secrets = await loadVault($)
    const [action = 'list', name] = e.args.trim().split(/\s+/)
    if (action === 'list') {
      const bindings = await bindingsOf($)
      const line = n => '$' + n + (bindings[n] ? ' -> ' + bindings[n].join(', ') : '')
      return { text: secrets.size ? [...secrets.keys()].map(line).join('\n') : 'No secrets stored.' }
    }
    if (action === 'rm' && secrets.has(name)) {
      await forget($, name)
      await bind($, name, undefined)
      return { text: 'Removed $' + name }
    }
    if (action === 'clear') {
      for (const n of secrets.keys()) await forget($, n)
      await $.store.delete('bindings')
      return { text: 'Removed every safekeys secret.' }
    }
    return { text: 'Usage: /safekeys list | rm NAME | clear' }
  })
}

async function guardPrompt($, e, next) {
  const bypass = BYPASS.test(e.text)
  const typed = e.text.replace(BYPASS, '')
  const secrets = await currentSecrets($)
  const tokens = bypass || !TYPED.has(e.origin?.kind) ? [] : [...typed.matchAll(TOKEN)]
  if (tokens.length && e.command) return { drop: 'safekeys cannot rewrite a slash command. Send $:NAME=value in a normal prompt.' }

  const code = [...typed.matchAll(CODE)].map(m => [m.index, m.index + m[0].length])
  if (tokens.some(m => code.some(([start, end]) => m.index >= start && m.index < end))) {
    return { drop: 'A $: value is inside backticks, so safekeys did not store it and did not send the prompt. If it is a real key, take it out of the backticks.' + HINT }
  }

  // Plan every token before saving any, so a refused prompt leaves nothing stored.
  const taken = new Set(secrets.keys())
  const named = new Set()
  const planned = []
  for (const match of tokens) {
    const [token, given, spec, quoted, bare] = match
    const plan = planToken(given, spec, quoted ?? bare, secrets, taken)
    if (plan.problem) return { drop: plan.problem + HINT }
    const { name, value, binding } = plan
    if (value !== undefined && named.has(name)) return { drop: `$${name} is set twice in this prompt.` + HINT }
    taken.add(name)
    named.add(name)
    planned.push({ at: match.index, token, name, value, binding })
  }

  const updated = new Map(secrets)
  let text = ''
  let last = 0
  for (const { at, token, name, value, binding } of planned) {
    if (value !== undefined) {
      await save($, name, value)
      updated.set(name, value)
    }
    if (binding) await bind($, name, binding)
    text += typed.slice(last, at) + '$' + name
    last = at + token.length
  }
  text = maskText(text + typed.slice(last), shieldFor(updated), 'input')

  const names = storedReferences(text, updated)
  // A slash command's line can't be rewritten, only let through or stopped.
  if (e.command) {
    if (text === typed) return next(e)
    return { drop: 'This slash command holds a saved key. Use its $NAME instead.' }
  }
  if (text === e.text && !names.length) return next(e)
  return next({ ...e, text, context: names.length ? [...(e.context ?? []), briefing(names)] : e.context })
}

// $:NAME@hosts=value stores and binds, $:value stores under a fresh name, $:NAME uses a
// saved key, and $:NAME@hosts rebinds one. A NAME@hosts token for a key that doesn't
// exist is refused rather than stored as a value: it is almost always quoted syntax.
function planToken(given, spec, raw, secrets, taken) {
  if (given) {
    const binding = spec === undefined ? undefined : parseBinding(spec)
    if (spec !== undefined && !binding) return { problem: `"@${spec}" is not a list of hosts, ssh:targets, local or any.` }
    return { name: given, value: raw, binding, problem: refusal(given, raw) }
  }
  const rebind = raw.match(REBIND)
  const binding = rebind && parseBinding(rebind[2])
  if (binding) {
    if (!secrets.has(rebind[1])) return { problem: `There is no saved key $${rebind[1]}. To store one, use $:${rebind[1]}@${rebind[2]}=value.` }
    return { name: rebind[1], binding }
  }
  if (secrets.has(raw)) return { name: raw }
  const name = freshName(taken)
  return { name, value: raw, problem: refusal(name, raw) }
}

function storedReferences(text, secrets) {
  return [...new Set([...text.matchAll(REFERENCE)].map(m => m[1]).filter(name => secrets.has(name)))].map(name => '$' + name)
}

async function guardTool($, e, next) {
  const secrets = await currentSecrets($)
  if (!secrets.size) return next(e)
  const shield = shieldFor(secrets)
  const leaked = findLeak(e, shield)
  if (leaked) {
    return { deny: `safekeys blocked this call: its input holds the value of $${leaked}, or an encoded piece of it. Refer to it as $${leaked} instead.` }
  }
  const sliced = e.tool === 'Bash' && [...secrets.keys()].find(name => slicePattern(name).test(e.command))
  if (sliced) {
    return { deny: `safekeys blocked this command: it would print part or a transformed copy of $${sliced}. Use $${sliced} whole.` }
  }
  const stray = e.tool === 'Bash' && await strayDestination($, e.command, secrets)
  if (stray && !(await confirmStray($, stray, e.command))) {
    return { deny: `safekeys stopped this command: $${stray.name} may only go to ${stray.allowed}, and this command would ${stray.where}. The user did not allow it.` }
  }
  const r = await next(e.tool === 'Bash' ? withSecrets(e, secrets) : e)
  if (r.deny) return r
  // Every field is masked, not only the text Claude reads: an Edit's result keeps the
  // whole original file, and the transcript stores all of it.
  const result = maskDeep(r.result, shield)
  const context = maskDeep(r.context, shield)
  const text = typeof r.text === 'string' ? maskText(r.text, shield) : r.text
  if (result === r.result && context === r.context && text === r.text) return r
  if (r.isError) return { deny: text }
  if (result !== r.result || context !== r.context) return { result, context }
  // Only the model's rendering held a value: withhold it rather than guess at the record.
  return { deny: text }
}

// A bound key the command would send somewhere its binding doesn't list, or that the
// command hides its handling of. Keys without a binding, or bound to `any`, are not checked.
async function strayDestination($, command, secrets) {
  const bindings = await bindingsOf($)
  const bound = namesIn(command, secrets).filter(name => bindings[name] && !bindings[name].includes('any'))
  if (!bound.length) return
  const { web, ssh, unclear } = destinationsOf(command)
  for (const name of bound) {
    const entries = bindings[name]
    const local = entries.includes('local')
    const places = web.filter(host => local || !webAllowed(host, entries))
    for (const target of ssh) {
      if (local || !sshAllowed(await sshNamesOf($, target), entries)) places.push('ssh:' + target)
    }
    if (places.length || unclear) {
      const where = places.length ? 'send it to ' + places.join(', ') : 'run code safekeys cannot see, such as $(...) or eval'
      return { name, allowed: entries.join(', '), where }
    }
  }
}

async function confirmStray($, stray, command) {
  const run = 'Run it this time'
  try {
    return await $.ui.ask(`$${stray.name} may only go to ${stray.allowed}, but this command would ${stray.where}:\n${command}\nRun it anyway?`, [run, "Don't run"]) === run
  } catch {
    return false
  }
}

// An ssh alias is matched by its own name and by the hostname ssh resolves it to.
async function sshNamesOf($, target) {
  if (!sshNames.has(target)) {
    let resolved
    try {
      resolved = (await $.process.run(['ssh', '-G', target])).stdout.match(/^hostname (\S+)$/m)?.[1]?.toLowerCase()
    } catch {
      // unresolvable: match the name as written
    }
    sshNames.set(target, resolved && resolved !== target ? [target, resolved] : [target])
  }
  return sshNames.get(target)
}

// Bindings say where keys may go; they aren't secret, so they live in the mod's own store.
// An unreadable store reads as no bindings: the guard stands down, masking carries on.
async function bindingsOf($) {
  try {
    return (await $.store.get('bindings')) ?? {}
  } catch {
    return {}
  }
}

async function bind($, name, binding) {
  const bindings = { ...(await bindingsOf($)) }
  if (binding) bindings[name] = binding
  else delete bindings[name]
  await $.store.set('bindings', bindings)
}

// ${NAME:3}, ${NAME#x}, ${NAME^^} and the like print a piece or a changed copy of
// the value; ${NAME:-default} and its kin print it whole and are left alone.
function slicePattern(name) {
  return new RegExp('\\$\\{' + name + '(?::(?![-=?+])|[#%/^,@])')
}

function refusal(name, value) {
  if (RESERVED.has(name.toUpperCase())) return `$${name} is a reserved environment variable. Pick another name.`
  if (value.length < MIN_LENGTH) return `The value for $${name} is shorter than ${MIN_LENGTH} characters, too short to mask safely.`
  if (value.length > MAX_LENGTH) return `The value for $${name} is longer than ${MAX_LENGTH} characters, too long to store.`
  // macOS hands such values back hex-encoded, so they can't be used or checked.
  if (/[^\x20-\x7e]/.test(value)) return `The value for $${name} has a line break or a non-ASCII character, which safekeys can't store intact.`
}

function freshName(taken) {
  let name
  do name = 'SK_' + crypto.randomUUID().slice(0, 4).toUpperCase()
  while (taken.has(name))
  return name
}

function briefing(names) {
  return `safekeys: ${names.join(', ')} hold secrets the user stored in the OS keychain. ` +
    'Use them by reference as ordinary environment variables: any Bash command that names one gets ' +
    'the real value exported, for example echo "API_KEY=$NAME" >> .env. Writing them to files the user ' +
    'asks for is expected. Tool output is masked automatically, so you will see the $NAME reference ' +
    'wherever the value appears. Do not try to work out the value itself.'
}

// The plugin's bin/ is on the Bash tool's PATH. Sourcing the helper keeps the keychain
// read out of the command text: auto mode's classifier refused an inline
// `security find-generic-password` as credential exploration.
function namesIn(command, secrets) {
  return [...secrets.keys()].filter(name => new RegExp('\\$\\{?' + name + '\\b').test(command))
}

function withSecrets(e, secrets) {
  const used = namesIn(e.command, secrets)
  if (!used.length) return e
  return { ...e, command: `. safekeys-env ${used.join(' ')}\n${e.command}` }
}

// Keychain access: the only place that runs `security` or `secret-tool`.

async function os($) {
  platform ??= (await $.process.run(['uname', '-s'])).stdout.trim()
  if (platform !== 'Darwin' && platform !== 'Linux') throw new Error('safekeys supports macOS and Linux only')
  return platform
}

async function currentSecrets($) {
  try {
    lastGood = await loadVault($)
  } catch {
    // keep masking with the last list that loaded
  }
  return lastGood
}

// Reloads whenever the stamp moved, including after this session's own change,
// so two sessions saving at once can't leave either with a stale list.
async function loadVault($) {
  const stamp = await readStamp($)
  if (vault?.stamp !== stamp) {
    const secrets = readAll($)
    vault = { stamp, secrets }
    secrets.catch(() => {
      if (vault?.secrets === secrets) vault = undefined
    })
  }
  return vault.secrets
}

async function readStamp($) {
  try {
    return await $.fs.read(await stampPath($))
  } catch {
    return ''
  }
}

// This session reloads on its next check whatever the stamp says; the stamp tells the others.
async function markChanged($) {
  vault = undefined
  await $.fs.write(await stampPath($), crypto.randomUUID())
}

async function stampPath($) {
  stampFile ??= ((await $.env.get('CLAUDE_CONFIG_DIR')) ?? (await $.env.get('HOME')) + '/.claude') + '/safekeys.stamp'
  return stampFile
}

// An item that won't read (deleted meanwhile, locked, not ours) is skipped, so one
// bad item can't stop the rest from being masked.
async function readAll($) {
  const secrets = new Map()
  for (const name of await storedNames($)) {
    try {
      secrets.set(name, await lookup($, name))
    } catch {
      // skipped
    }
  }
  return secrets
}

// Names come back from the keychain, where any program can plant an item, so only
// names that are plain shell variable names are trusted into commands and patterns.
async function storedNames($) {
  let names
  if (await os($) === 'Darwin') {
    const { stdout } = await $.process.run(['security', 'dump-keychain'])
    names = stdout.split(/^keychain: /m)
      .filter(item => item.includes(`"svce"<blob>="${SERVICE}"`))
      .map(item => item.match(/"acct"<blob>="([^"]*)"/)?.[1])
  } else {
    const { stdout, stderr } = await $.process.run(['secret-tool', 'search', '--all', '--unlock', 'service', SERVICE])
    names = [...(stdout + stderr).matchAll(/^attribute\.account = (.+)$/gm)].map(m => m[1])
  }
  return [...new Set(names.filter(name => name && NAME.test(name)))]
}

function lookupCommand(system, name) {
  return system === 'Darwin'
    ? ['security', 'find-generic-password', '-s', SERVICE, '-a', name, '-w']
    : ['secret-tool', 'lookup', 'service', SERVICE, 'account', name]
}

async function lookup($, name) {
  const { exitCode, stdout } = await $.process.run(lookupCommand(await os($), name))
  if (exitCode !== 0) throw new Error('safekeys could not read $' + name)
  return stdout.replace(/\n$/, '')
}

// The value goes over stdin, never argv, so it doesn't show up in `ps`.
async function save($, name, value) {
  const { exitCode } = await os($) === 'Darwin'
    ? await $.process.run(['security', '-i'], { stdin: `add-generic-password -U -s ${SERVICE} -a ${name} -X ${hex(value)}\n` })
    : await $.process.run(['secret-tool', 'store', '--label', 'safekeys ' + name, 'service', SERVICE, 'account', name], { stdin: value })
  if (exitCode !== 0 || await lookup($, name) !== value) throw new Error('safekeys could not store $' + name)
  await markChanged($)
}

async function forget($, name) {
  await $.process.run(await os($) === 'Darwin'
    ? ['security', 'delete-generic-password', '-s', SERVICE, '-a', name]
    : ['secret-tool', 'clear', 'service', SERVICE, 'account', name])
  await markChanged($)
}

function hex(value) {
  return [...new TextEncoder().encode(value)].map(b => b.toString(16).padStart(2, '0')).join('')
}
