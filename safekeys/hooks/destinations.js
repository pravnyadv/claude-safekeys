// Bindings say where a key may go; these functions read where a command would send it.
// Pure functions; register.js decides what to do with the answers.
//
// A binding is a list of entries: `local` (never leaves this machine), `any` (no limit),
// `ssh:<host or alias>`, a web host (`api.example.com`), or `*.<domain>` for its subdomains,
// over ssh too (`ssh:*.<domain>`).
//
// A question stops whatever the person is running, so only a destination the command
// shows counts: a URL, an ssh/scp/rsync target, or a bare host handed to a network tool.
// Loopback is this machine, and what runs on a remote host is that host's business.

const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^/\s'"@]*@)?([^/\s:'"?#;|&\\]+)/gi
const BARE_HOST = /(?<![\w.@/:-])((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?=$|[/\s'"?#;)])/gi
const IPV4 = /(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})(?![\w.])/g
// Bare names that are far more often files than hosts.
const FILE_ENDINGS = /\.(env|json|jsonl|txt|md|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|php|java|kt|sh|zsh|bash|yml|yaml|toml|ini|cfg|conf|lock|log|csv|tsv|html|css|scss|sql|xml|pem|key|crt|pub|tar|gz|zip|png|jpg|svg|pdf|local|example|sample|bak|tmp|test|spec|config|d)$/i
const LOOPBACK = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|0\.0\.0\.0)$/
const SSH_TOOLS = new Set(['ssh', 'scp', 'sftp', 'rsync'])
// Tools that take a bare host as where to connect; elsewhere a dotted word is a file,
// a table or a service name (mysql.user, nginx.service, com.apple.dock).
// Matched as a word anywhere, so `bash -c "curl x"`, `xargs curl` and a ProxyCommand count too.
const NETWORK_TOOL = /(?:^|[\s'"(;|&`/=])(?:curl|wget|nc|ncat|netcat|socat|telnet|ftp|lftp|http|https|xh|openssl|mysql|mariadb|psql|redis-cli|mongosh|mongo)(?=[\s'")]|$)/
// Words that run the word after them: `sudo ssh`, `TERM=x ssh`, `sshpass -p pw ssh`.
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'caffeinate', 'sshpass'])
const WRAPPER_VALUED = new Set(['-u', '-g', '-p', '-f', '-n', '-C', '-h', '-D'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// ssh options that take a value, so the word after them is not the host.
const SSH_VALUED = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-P', '-Q', '-R', '-S', '-W', '-w'])
const HOST = /^(\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}$|^(\d{1,3}\.){3}\d{1,3}$/i
const SSH_TARGET = /^[A-Za-z0-9._-]+$/
const REDIRECT = /^\d*[<>]/
// curl options whose value is sent to, or written from, the URL's host: never a destination.
const CURL_CARRIES = /^(-[dHFwouAeK]|--data(-[a-z]+)?|--json|--header|--form(-string)?|--write-out|--output|--user|--user-agent|--referer|--config)$/
const CURL_CARRIES_JOINED = /^(-[dHFwouAeK].|--(data(-[a-z]+)?|json|header|form(-string)?|write-out|output|user|user-agent|referer|config)=)/

// The entries of a binding as typed after `@`, or undefined when it doesn't read as one.
export function parseBinding(spec) {
  const entries = spec.split(',').map(entry => entry.trim().toLowerCase())
  const valid = entries.every(entry =>
    entry === 'local' || entry === 'any' || HOST.test(entry) ||
    (entry.startsWith('ssh:') && (SSH_TARGET.test(entry.slice(4)) || HOST.test(entry.slice(4)))))
  return valid && entries.length ? [...new Set(entries)] : undefined
}

// Where the command would send data: web hosts, and ssh targets.
export function destinationsOf(command) {
  const heredocs = [...command.matchAll(/<<-?\s*['"]?([A-Za-z_][\w]*)['"]?[^\n]*\n[\s\S]*?^\s*\1\s*$/gm)].map(m => {
    const line = command.slice(command.lastIndexOf('\n', m.index - 1) + 1, m.index + m[0].indexOf('\n'))
    // Only a body read as data is skipped; one fed to an interpreter is code to check.
    if (!/^\s*(?:\S+\/)?(?:cat|tee|curl|wget|http|xh|gh)\b[^|;&]*$/.test(line)) return [m.index, m.index]
    const start = m.index + m[0].indexOf('\n') + 1
    return [start, m.index + m[0].length]
  })
  command = without(command, heredocs)
  const commands = simpleCommands(command)
  const calls = commands.flatMap(sshCalls)
  const ssh = [...new Set(calls.map(call => call.host))]
  // The command an ssh call runs is checked by the ssh target's binding alone.
  const here = without(command, calls.map(call => call.remote).filter(Boolean))
  const parts = simpleCommands(here)
  const named = without(here, parts.flatMap((words, i) => carried(words, parts[i + 1]?.[0]?.text === 'xargs')))
  const web = new Set()
  for (const m of named.matchAll(URL_HOST)) web.add(m[1].toLowerCase())
  if (NETWORK_TOOL.test(here)) {
    const bare = without(named, parts.flatMap(words => {
      const tool = toolOf(words)?.tool
      return ['jq', 'echo'].includes(tool) && !/\|\s*xargs\b/.test(here) ? [[words[0].start, words.at(-1).end]] : []
    }))
    for (const m of bare.matchAll(BARE_HOST)) if (!FILE_ENDINGS.test(m[1])) web.add(m[1].toLowerCase())
    for (const m of bare.matchAll(IPV4)) web.add(m[1])
    for (const words of parts) {
      if (!words.some(word => basename(word.text) === 'curl')) continue
      for (let i = 0; i < words.length; i++) {
        const word = words[i].text
        const value = word === '--connect-to' ? words[i + 1]?.text : word.startsWith('--connect-to=') ? word.slice(13) : undefined
        if (value) {
          const host = value.split(':')[2]
          if (host) web.add(host.toLowerCase())
        }
        if (/^-x[^-]/.test(word) && named.slice(words[i].start, words[i].end).trim()) {
          const host = word.slice(2).replace(/^[a-z]+:\/\//i, '').split(':')[0]
          web.delete(word.toLowerCase())
          if (host) web.add(host.toLowerCase())
        }
      }
    }
  }
  for (const target of ssh) web.delete(target)
  return { web: [...web].filter(host => !LOOPBACK.test(host)), ssh }
}

// The line with each [start, end] span blanked; offsets stay valid for later spans.
function without(line, spans) {
  for (const [start, end] of [...spans].sort((a, b) => b[0] - a[0])) line = line.slice(0, start) + ' '.repeat(end - start) + line.slice(end)
  return line
}

// Spans of the data, headers and output paths in a curl call, so a host or URL named only
// inside them (a DNS record's content, a redirect rule) is not read as where curl connects.
function curlCarried(words) {
  const at = words.findIndex(word => basename(word.text) === 'curl')
  if (at < 0) return []
  const spans = []
  for (let i = at + 1; i < words.length; i++) {
    const word = words[i]
    if (CURL_CARRIES.test(word.text) && i + 1 < words.length) spans.push([words[++i].start, words[i].end])
    else if (CURL_CARRIES_JOINED.test(word.text)) spans.push([word.start, word.end])
  }
  return spans
}

// Values carried in request options and HTTP request items are not destinations.
function carried(words, feedsXargs) {
  const spans = curlCarried(words)
  const { tool, at } = toolOf(words) ?? {}
  if (tool === 'jq' && !feedsXargs) return [[words[0].start, words.at(-1).end]]
  const valued = tool === 'wget' ? /^(--header|--post-data|--body-data|--referer|-O|--output-document)$/
    : tool === 'gh' ? /^(-f|-F|--field|--raw-field)$/ : null
  for (let i = (at ?? -1) + 1; i < words.length; i++) {
    const word = words[i]
    if (valued?.test(word.text) && i + 1 < words.length) spans.push([words[++i].start, words[i].end])
    else if (tool === 'wget' && /^(--header|--post-data|--body-data|--referer|--output-document)=/.test(word.text)) spans.push([word.start, word.end])
    else if (tool === 'gh' && /^(--field|--raw-field)=/.test(word.text)) spans.push([word.start, word.end])
    else if (['http', 'https', 'xh'].includes(tool) && /^[^:=\s]+(?::=|==|=|:)/.test(word.text) && !/^[a-z]+:\/\//i.test(word.text) && !/^[a-z0-9.-]+:\d+(?:\/|$)/i.test(word.text)) spans.push([word.start, word.end])
  }
  return spans
}

// The command a simple command runs once wrappers and VAR=value words are skipped.
function toolOf(words) {
  let i = 0
  while (i < words.length) {
    const word = words[i].text
    if (ASSIGNMENT.test(word)) i++
    else if (WRAPPERS.has(basename(word))) {
      i++
      while (i < words.length && words[i].text.startsWith('-')) i += WRAPPER_VALUED.has(words[i].text) ? 2 : 1
    } else break
  }
  return i < words.length ? { tool: basename(words[i].text), at: i } : undefined
}

function basename(word) {
  return word.slice(word.lastIndexOf('/') + 1)
}

// The ssh, scp, sftp or rsync call in a simple command: its target, and for ssh the span
// of the command it runs remotely, up to any local redirection.
function sshCalls(words) {
  const calls = []
  const { tool, at } = toolOf(words) ?? {}
  if (SSH_TOOLS.has(tool)) {
    for (let i = at + 1; i < words.length; i++) {
      const word = words[i].text
      if (word.startsWith('-')) {
        // A value letter takes the rest of its word (-p2222) or, last in a cluster, the next word (-vp 2222).
        const letters = word.slice(1)
        if (letters && [...letters].findIndex(letter => SSH_VALUED.has('-' + letter)) === letters.length - 1) i++
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
  const hosts = entries.filter(entry => entry.startsWith('ssh:')).map(entry => entry.slice(4))
  return names.some(name => webAllowed(name, hosts))
}
