// Bindings say where a key may go; these functions read where a command would send it.
// Pure functions; register.js decides what to do with the answers.
//
// A binding is a list of entries: `local` (never leaves this machine), `any` (no limit),
// `ssh:<host or alias>`, a web host (`api.example.com`), or `*.<domain>` for its subdomains.

const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^/\s'"@]*@)?([^/\s:'"?#\\]+)/gi
const BARE_HOST = /(?<![\w.@/:-])((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?=$|[/\s'"?#;)])/gi
const IPV4 = /(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})(?![\w.])/g
// Bare names that are far more often files than hosts.
const FILE_ENDINGS = /\.(env|json|jsonl|txt|md|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|php|java|kt|sh|zsh|bash|yml|yaml|toml|ini|cfg|conf|lock|log|csv|tsv|html|css|scss|sql|xml|pem|key|crt|pub|tar|gz|zip|png|jpg|svg|pdf|local|example|sample|bak|tmp|test|spec|config|d)$/i
// Constructs that can run something the command text doesn't show.
const HIDDEN = /\$\(|`|<\(|>\(|\beval\b|(^|[\s;&|])(source|\.)\s/
const SSH_TOOLS = new Set(['ssh', 'scp', 'sftp', 'rsync'])
// ssh options that take a value, so the word after them is not the host.
const SSH_VALUED = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-P', '-Q', '-R', '-S', '-W', '-w'])
const HOST = /^(\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}$|^(\d{1,3}\.){3}\d{1,3}$/i
const SSH_TARGET = /^[A-Za-z0-9._-]+$/
const REDIRECT = /^\d*[<>]/

// The entries of a binding as typed after `@`, or undefined when it doesn't read as one.
export function parseBinding(spec) {
  const entries = spec.split(',').map(entry => entry.trim().toLowerCase())
  const valid = entries.every(entry =>
    entry === 'local' || entry === 'any' || HOST.test(entry) ||
    (entry.startsWith('ssh:') && SSH_TARGET.test(entry.slice(4))))
  return valid && entries.length ? [...new Set(entries)] : undefined
}

// Where the command would send data: web hosts, and ssh targets. `unclear` when the
// command hides part of what it runs.
export function destinationsOf(command) {
  const calls = sshCalls(command)
  const ssh = [...new Set(calls.map(call => call.host))]
  // A command run over ssh runs on a host the binding already trusts, so only explicit
  // URLs in it count; its dotted words are mostly tables and files (mysql.user).
  let here = command
  for (const [start, end] of calls.map(call => call.remote).filter(Boolean).reverse()) {
    here = here.slice(0, start) + ' ' + here.slice(end)
  }
  const web = new Set()
  for (const m of command.matchAll(URL_HOST)) web.add(m[1].toLowerCase())
  for (const m of here.matchAll(BARE_HOST)) if (!FILE_ENDINGS.test(m[1])) web.add(m[1].toLowerCase())
  for (const m of here.matchAll(IPV4)) web.add(m[1])
  for (const target of ssh) web.delete(target)
  return { web: [...web], ssh, unclear: HIDDEN.test(command) }
}

// Each ssh, scp, sftp or rsync call: its target, and for ssh the span of the command it
// runs remotely, up to any local redirection.
function sshCalls(command) {
  const calls = []
  for (const words of simpleCommands(command)) {
    const tool = words[0].text
    if (!SSH_TOOLS.has(tool)) continue
    for (let i = 1; i < words.length; i++) {
      const word = words[i].text
      if (word.startsWith('-')) {
        if (SSH_VALUED.has(word)) i++
        continue
      }
      // user@host:path for scp and rsync, user@host for ssh
      const host = word.replace(/^[^@]*@/, '').replace(/:.*$/, '').toLowerCase()
      if (tool === 'ssh' || tool === 'sftp') {
        const remote = words.slice(i + 1)
        const last = remote.findIndex(w => REDIRECT.test(w.text))
        const ran = last < 0 ? remote : remote.slice(0, last)
        if (host) calls.push({ host, remote: tool === 'ssh' && ran.length ? [ran[0].start, ran.at(-1).end] : undefined })
        break
      }
      if (word.includes(':') && host) calls.push({ host })
    }
  }
  return calls
}

// The simple commands of a shell line, split at unquoted ; & | and newlines, as words
// with quotes removed and their offsets in the line.
function simpleCommands(line) {
  const commands = [[]]
  let word, quote
  const close = () => {
    if (word) commands.at(-1).push(word)
    word = undefined
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (!quote && /[;&|\n]/.test(c)) {
      close()
      commands.push([])
      continue
    }
    if (!quote && /\s/.test(c)) {
      close()
      continue
    }
    word ??= { text: '', start: i }
    if (quote ? c === quote : c === "'" || c === '"') quote = quote ? undefined : c
    else if (c === '\\' && quote !== "'" && i + 1 < line.length) word.text += line[++i]
    else word.text += c
    word.end = i + 1
  }
  close()
  return commands.filter(words => words.length)
}

export function webAllowed(host, entries) {
  return entries.some(entry => entry === host || (entry.startsWith('*.') && host.endsWith(entry.slice(1))))
}

// `names` holds the target as written and, when known, the hostname ssh resolves it to.
export function sshAllowed(names, entries) {
  return entries.some(entry => entry.startsWith('ssh:') && names.includes(entry.slice(4)))
}
