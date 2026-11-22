// PreToolUse command hook: puts `. safekeys-env NAME...` in front of a Bash command that names a
// stored key. Auto mode lets a plugin's command hook change a Bash call; it denies the same change
// from a module hook ("a hook changed this call's input after auto mode reviewed it").
const fs = require('fs')
const path = require('path')

const OWN_PREFIX = /^\. safekeys-env [A-Za-z0-9_ ]+\n/
const dir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude')

let input = ''
process.stdin.on('data', chunk => { input += chunk }).on('end', () => {
  try {
    const call = JSON.parse(input).tool_input
    if (typeof call?.command !== 'string' || OWN_PREFIX.test(call.command)) return
    const names = JSON.parse(fs.readFileSync(path.join(dir, 'safekeys.names'), 'utf8'))
    const used = names.filter(name => new RegExp('\\$\\{?' + name + '\\b').test(call.command))
    if (!used.length) return
    const command = `. safekeys-env ${used.join(' ')}\n${call.command}`
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...call, command } } }))
  } catch {
    // No names file yet, or unreadable input: leave the command as it is.
  }
})
