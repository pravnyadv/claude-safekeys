import { expect, test } from 'claude-code/testing'

const FAKE = 'sk-test-FAKE1234567890'

type System = 'Darwin' | 'Linux'

// Answers $.process.run the way `uname`, `security` and `secret-tool` would,
// backed by a Map instead of a real keychain.
function fakeKeychain(on, system: System, items = new Map<string, string>(), { broken = false, argvs = [] as string[] } = {}) {
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
  const missing = { value: { exitCode: 44, stdout: '', stderr: 'not found' } }
  on('process.run', ($, e) => {
    argvs.push(e.argv.join(' '))
    const [cmd, ...args] = e.argv
    if (cmd === 'uname') return ok(system + '\n')
    if (broken) return { value: { exitCode: 1, stdout: '', stderr: 'keychain locked' } }
    const account = args[args.indexOf(system === 'Darwin' ? '-a' : 'account') + 1]
    if (cmd === 'security') {
      if (args[0] === '-i') {
        const [, name, hex] = e.init.stdin.match(/-a (\S+) -X ([0-9a-f]+)/)
        items.set(name, new TextDecoder().decode(new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16)))))
        return ok()
      }
      if (args[0] === 'dump-keychain') {
        return ok([...items.keys()].map(n => `keychain: "/k"\nattributes:\n    "acct"<blob>="${n}"\n    "svce"<blob>="claude_safekeys"\n`).join(''))
      }
      if (args[0] === 'find-generic-password') return items.has(account) ? ok(items.get(account) + '\n') : missing
      if (args[0] === 'delete-generic-password') return items.delete(account) ? ok() : missing
    }
    if (cmd === 'secret-tool') {
      if (args[0] === 'store') return items.set(account, e.init.stdin) && ok()
      if (args[0] === 'search') return ok([...items.keys()].map(n => `attribute.account = ${n}\n`).join(''))
      if (args[0] === 'lookup') return items.has(account) ? ok(items.get(account)) : missing
      if (args[0] === 'clear') return items.delete(account) ? ok() : missing
    }
    throw new Error('unexpected command ' + e.argv.join(' '))
  })
  return items
}

function passThroughPrompts(on) {
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
}

const prompt = (text: string) => ({ text, wait: false, origin: { kind: 'user' } })

test('a prompt without $: passes through untouched and never touches the keychain', async ($, on) => {
  on('process.run', () => { throw new Error('keychain touched') })
  passThroughPrompts(on)
  const out = await $.prompt.submit(prompt('fix the build'))
  expect(out.text).toBe('fix the build')
  expect(out.context).toBeUndefined()
})

for (const system of ['Darwin', 'Linux'] as const) {
  test(`${system}: $:NAME=value is stored and replaced by $NAME`, async ($, on) => {
    const items = fakeKeychain(on, system)
    passThroughPrompts(on)
    const out = await $.prompt.submit(prompt(`$:STRIPE_KEY=${FAKE} write it to .env`))
    expect(out.text).toBe('$STRIPE_KEY write it to .env')
    expect(items.get('STRIPE_KEY')).toBe(FAKE)
    expect(out.context[0]).toContain('$STRIPE_KEY')
    expect(JSON.stringify(out)).not.toContain(FAKE)
  })

  test(`${system}: a Bash command that names a secret gets it exported, and its output is masked`, async ($, on) => {
    fakeKeychain(on, system, new Map([['STRIPE_KEY', FAKE]]))
    let ran = ''
    on('tool.call', ($, e) => {
      ran = e.command
      return { result: { stdout: `STRIPE_KEY=${FAKE}`, stderr: '' }, text: `STRIPE_KEY=${FAKE}` }
    })
    const out = await $.tool.call({ tool: 'Bash', command: 'echo "STRIPE_KEY=$STRIPE_KEY" >> .env' })
    const lookup = system === 'Darwin'
      ? 'security find-generic-password -s claude_safekeys -a STRIPE_KEY -w'
      : 'secret-tool lookup service claude_safekeys account STRIPE_KEY'
    expect(ran).toBe(`export STRIPE_KEY="$(${lookup})"\necho "STRIPE_KEY=$STRIPE_KEY" >> .env`)
    expect(out.result.stdout).toBe('STRIPE_KEY=$STRIPE_KEY')
  })
}

test('$:value without a name gets a random SK_ name', async ($, on) => {
  const items = fakeKeychain(on, 'Darwin')
  passThroughPrompts(on)
  const out = await $.prompt.submit(prompt(`use $:${FAKE} for the API`))
  expect(out.text).toMatch(/^use \$SK_[0-9A-F]{4} for the API$/)
  expect([...items.values()]).toEqual([FAKE])
})

test('a double-quoted value keeps its spaces', async ($, on) => {
  const items = fakeKeychain(on, 'Darwin')
  passThroughPrompts(on)
  const out = await $.prompt.submit(prompt(`$:PHRASE="correct horse battery staple" use it`))
  expect(out.text).toBe('$PHRASE use it')
  expect(items.get('PHRASE')).toBe('correct horse battery staple')
})

for (const system of ['Darwin', 'Linux'] as const) {
  test(`${system}: no command ever carries the value in its arguments`, async ($, on) => {
    const argvs: string[] = []
    const items = fakeKeychain(on, system, new Map(), { argvs })
    passThroughPrompts(on)
    on('tool.call', ($, e) => {
      argvs.push(e.command)
      return { result: { stdout: '', stderr: '' }, text: '' }
    })
    await $.prompt.submit(prompt(`$:STRIPE_KEY=${FAKE} go`))
    await $.tool.call({ tool: 'Bash', command: 'echo "$STRIPE_KEY" > .env' })
    expect(items.get('STRIPE_KEY')).toBe(FAKE)
    expect(argvs.join('\n')).toContain(system === 'Darwin' ? 'security -i' : 'secret-tool store')
    expect(argvs.join('\n')).toContain('export STRIPE_KEY=')
    expect(argvs.join('\n')).not.toContain(FAKE)
  })
}

test('a value too short to mask is refused and nothing is stored', async ($, on) => {
  const items = fakeKeychain(on, 'Darwin')
  passThroughPrompts(on)
  const out = await $.prompt.submit(prompt('$:PIN=1234 hi'))
  expect(out.drop).toContain('too short')
  expect(items.size).toBe(0)
})

test('a reserved name is refused', async ($, on) => {
  fakeKeychain(on, 'Darwin')
  passThroughPrompts(on)
  const out = await $.prompt.submit(prompt(`$:PATH=${FAKE}`))
  expect(out.drop).toContain('reserved')
})

test('a keychain failure drops the prompt instead of sending the value', async ($, on) => {
  fakeKeychain(on, 'Darwin', new Map(), { broken: true })
  passThroughPrompts(on)
  const out = await $.prompt.submit(prompt(`$:STRIPE_KEY=${FAKE} go`))
  expect(out.drop).toContain('was not sent')
})

test('a stored value is masked in any tool result, not just Bash', async ($, on) => {
  fakeKeychain(on, 'Darwin', new Map([['STRIPE_KEY', FAKE]]))
  on('tool.call', () => ({ result: { file: { content: `KEY=${FAKE}\n` } }, text: `KEY=${FAKE}` }))
  const out = await $.tool.call({ tool: 'Read', file_path: '.env' })
  expect(out.result.file.content).toBe('KEY=$STRIPE_KEY\n')
})

test('commands that never name a secret run unchanged', async ($, on) => {
  fakeKeychain(on, 'Darwin', new Map([['STRIPE_KEY', FAKE]]))
  let ran = ''
  on('tool.call', ($, e) => {
    ran = e.command
    return { result: { stdout: 'ok', stderr: '' }, text: 'ok' }
  })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ran).toBe('ls')
})

test('/safekeys lists names only, and rm removes one', async ($, on) => {
  const items = fakeKeychain(on, 'Darwin', new Map([['A_KEY', FAKE], ['B_KEY', FAKE + 'b']]))
  const listed = await $.command.run({ command: 'safekeys', args: 'list' })
  expect(listed.text).toBe('$A_KEY\n$B_KEY')
  const removed = await $.command.run({ command: 'safekeys', args: 'rm A_KEY' })
  expect(removed.text).toBe('Removed $A_KEY')
  expect([...items.keys()]).toEqual(['B_KEY'])
})
