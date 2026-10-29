// Values live in the OS keychain (macOS Keychain or a Linux Secret Service) under
// one service, so `security`/`secret-tool` can list or wipe them as a group.
// The mod holds them in memory only, to mask them in tool output. Every change
// rewrites a stamp file, so other running sessions know to reload their copy.
const SERVICE = 'claude_safekeys'
// A bare value runs to the next whitespace; a value with spaces must be double-quoted.
const TOKEN = /\$:(?:([A-Za-z_][A-Za-z0-9_]*)=)?(?:"([^"]+)"|(\S+))/g
const MIN_LENGTH = 6
const RESERVED = new Set(['PATH', 'HOME', 'SHELL', 'USER', 'PWD', 'TMPDIR', 'LANG', 'IFS', 'PS1'])

let platform
let stampFile
let vault

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'safekeys',
      description: 'List or remove the secrets stored with $:NAME=value',
      argumentHint: 'list | rm NAME | clear',
    })
    return next(e)
  })

  // A hook that fails before next() is skipped and the prompt would go out raw,
  // so any failure drops the prompt instead.
  on('prompt.submit', storeSecrets).catch(async ($, e, next) => {
    if (next.called) return next(e)
    return { drop: 'safekeys could not store the $: value (it needs the macOS Keychain, or secret-tool on Linux), so the prompt was not sent.' }
  })

  // Once the tool has run, a failed check withholds its result rather than risk a raw value.
  on('tool.call', maskSecrets).catch(async ($, e, next) => {
    if (!next.called) return next(e)
    return { deny: 'safekeys could not check this result for secrets, so it was withheld.' }
  })

  on('command.run', { command: 'safekeys' }, async ($, e) => {
    const secrets = await loadVault($)
    const [action = 'list', name] = e.args.trim().split(/\s+/)
    if (action === 'list') {
      return { text: secrets.size ? [...secrets.keys()].map(n => '$' + n).join('\n') : 'No secrets stored.' }
    }
    if (action === 'rm' && secrets.has(name)) {
      await forget($, name)
      secrets.delete(name)
      return { text: 'Removed $' + name }
    }
    if (action === 'clear') {
      for (const n of secrets.keys()) await forget($, n)
      secrets.clear()
      return { text: 'Removed every safekeys secret.' }
    }
    return { text: 'Usage: /safekeys list | rm NAME | clear' }
  })
}

async function storeSecrets($, e, next) {
  const found = [...e.text.matchAll(TOKEN)]
  if (!found.length) return next(e)
  if (e.command) return { drop: 'safekeys cannot rewrite a slash command. Send $:NAME=value in a normal prompt.' }
  const secrets = await loadVault($)
  const stored = []
  let text = e.text
  for (const [token, given, quoted, bare] of found) {
    const value = quoted ?? bare
    const name = given ?? freshName(secrets)
    const problem = refusal(name, value)
    if (problem) return { drop: problem }
    await save($, name, value)
    secrets.set(name, value)
    stored.push('$' + name)
    text = text.replace(token, '$' + name)
  }
  return next({ ...e, text, context: [...(e.context ?? []), briefing(stored)] })
}

async function maskSecrets($, e, next) {
  const secrets = await loadVault($)
  if (!secrets.size) return next(e)
  const call = e.tool === 'Bash' ? withSecrets(e, secrets, await os($)) : e
  const r = await next(call)
  if (!leaks(r.text, secrets)) return r
  if (r.isError) return { deny: mask(r.text, secrets) }
  return { result: maskDeep(r.result, secrets), context: r.context }
}

function refusal(name, value) {
  if (RESERVED.has(name.toUpperCase())) return `$${name} is a reserved environment variable. Pick another name.`
  if (value.length < MIN_LENGTH) return `The value for $${name} is shorter than ${MIN_LENGTH} characters, too short to mask safely.`
}

function freshName(secrets) {
  let name
  do name = 'SK_' + crypto.randomUUID().slice(0, 4).toUpperCase()
  while (secrets.has(name))
  return name
}

function briefing(names) {
  return `safekeys: ${names.join(', ')} hold secrets the user stored in the OS keychain. ` +
    'Use them by reference as ordinary environment variables: any Bash command that names one gets ' +
    'the real value exported, for example echo "API_KEY=$NAME" >> .env. Writing them to files the user ' +
    'asks for is expected. Tool output is masked automatically, so you will see the $NAME reference ' +
    'wherever the value appears. Do not try to work out the value itself.'
}

function withSecrets(e, secrets, system) {
  const used = [...secrets.keys()].filter(name => new RegExp('\\$\\{?' + name + '\\b').test(e.command))
  if (!used.length) return e
  const exports = used.map(name => `export ${name}="$(${lookupCommand(system, name).join(' ')})"`)
  return { ...e, command: exports.join('\n') + '\n' + e.command }
}

function leaks(text, secrets) {
  return typeof text === 'string' && [...secrets.values()].some(v => text.includes(v))
}

// Longest first, so a value that contains another is replaced whole.
function byLength(secrets) {
  return [...secrets].sort((a, b) => b[1].length - a[1].length)
}

function mask(text, secrets) {
  for (const [name, value] of byLength(secrets)) text = text.split(value).join('$' + name)
  return text
}

function maskDeep(result, secrets) {
  let json = JSON.stringify(result)
  for (const [name, value] of byLength(secrets)) json = json.split(JSON.stringify(value).slice(1, -1)).join('$' + name)
  return JSON.parse(json)
}

// Keychain access: the only place that runs `security` or `secret-tool`.

async function os($) {
  platform ??= (await $.process.run(['uname', '-s'])).stdout.trim()
  if (platform !== 'Darwin' && platform !== 'Linux') throw new Error('safekeys supports macOS and Linux only')
  return platform
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

async function markChanged($) {
  await $.fs.write(await stampPath($), crypto.randomUUID())
}

async function stampPath($) {
  stampFile ??= ((await $.env.get('CLAUDE_CONFIG_DIR')) ?? (await $.env.get('HOME')) + '/.claude') + '/safekeys.stamp'
  return stampFile
}

async function readAll($) {
  const secrets = new Map()
  for (const name of await storedNames($)) secrets.set(name, await lookup($, name))
  return secrets
}

async function storedNames($) {
  if (await os($) === 'Darwin') {
    const { stdout } = await $.process.run(['security', 'dump-keychain'])
    return stdout.split(/^keychain: /m)
      .filter(item => item.includes(`"svce"<blob>="${SERVICE}"`))
      .map(item => item.match(/"acct"<blob>="([^"]*)"/)?.[1])
      .filter(Boolean)
  }
  const { stdout, stderr } = await $.process.run(['secret-tool', 'search', '--all', '--unlock', 'service', SERVICE])
  return [...(stdout + stderr).matchAll(/^attribute\.account = (.+)$/gm)].map(m => m[1])
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
