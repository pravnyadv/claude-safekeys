# safekeys

Give Claude Code your API keys and passwords without putting them in the chat.

```
$:STRIPE_KEY=sk_live_abc123 add this to .env
```

The key goes to your OS keychain before the prompt is sent or saved. Claude only sees `$STRIPE_KEY add this to .env`, uses it like a normal environment variable, and sees `$STRIPE_KEY` wherever the key shows up in output. The key never reaches the model, the transcript or your prompt history.

## Install

In Claude Code v2.1.287 or newer:

```
/plugin marketplace add pravnyadv/claude-plugins
/plugin install safekeys@pravnyadv
```

Then run `/reload-plugins`. macOS works as is. On Linux, install `secret-tool` (`sudo apt install libsecret-tools`) and run a keyring such as GNOME Keyring.

## Use

| Type | Claude sees |
|---|---|
| `$:STRIPE_KEY=sk_live_abc123` | `$STRIPE_KEY` |
| `$:sk_live_abc123` | `$SK_7F3A` (random name) |
| `$:PHRASE="has some spaces"` | `$PHRASE` |
| `$STRIPE_KEY` | uses a key you saved earlier, in any session |

```
/safekeys list         # names, never values
/safekeys rm STRIPE_KEY
/safekeys clear
/safekeys ignore       # tools whose quoted $: history is let through (below)
/safekeys bindings     # whether key limits are checked (below)
```

To write about the `$:` syntax without storing anything, end the prompt with `$;`.

A bare value ends at the first space, minus a trailing `, . ; : ? ) ] }` that prose puts after it (a trailing `!` stays). Quote a value that really ends in one of those: `$:PW="secret."`.

`$:` is also Ruby's load path, so the shapes Ruby writes it in are left alone: `$:.unshift x`, `$:.include?(x)`, `$:<<` and `$:[0]`. Without this, pasting Ruby into a prompt would store a piece of code as a key. A bare value shaped like those, such as `$:.word` followed by a space, needs a name or quotes: `$:PW=.word` or `$:".word"`. Generated passwords almost never take that shape, and the named form is never affected.

## Tools that read past conversations

Some tools send your old conversations back through `claude -p`, for example to learn from them. A `$:` quoted in that history is not a key being handed over, so safekeys must neither store it nor refuse the prompt. Such a tool marks its calls with an environment variable, and safekeys lets those prompts through as written (stored values in them are still masked):

| Mark | Set by |
|---|---|
| `SAFEKEYS_IGNORE=1` | any tool, or a wrapper you put around one |
| `CLAUDE_SMART_INTERNAL=1` | [claude-smart](https://github.com/ReflexioAI/claude-smart)'s learning calls (recognized as is) |

For a tool that sets no mark, wrap the command it runs: `SAFEKEYS_IGNORE=1 exec claude "$@"`. A mark only counts for prompts sent through `claude -p` or the SDK; what you type in a session is always guarded, even with the variable exported.

```
/safekeys ignore                              # the marks and whether each is honored
/safekeys ignore off CLAUDE_SMART_INTERNAL    # guard those prompts like any other again
/safekeys ignore on CLAUDE_SMART_INTERNAL
```

## Limit where a key can go (optional)

Add `@` and the allowed places after the name:

```
$:GH_TOKEN@api.github.com=ghp_...        only that host
$:VIRA_SUDO@ssh:vira.com=...             only over ssh/scp/rsync to vira.com
$:SUDO_PW@local=...                      never leaves this machine (localhost is fine)
$:KEY@api.example.com,ssh:box=...        any of these
$:QA_PW@ssh:*.niswey.net=...             over ssh to any host under niswey.net
```

Already saved a key without a limit? Add one without retyping the key: `$:GH_TOKEN@api.github.com` (no `=`). The same form changes an existing limit.

If a command would send a bound key anywhere else, safekeys asks you before it runs. Keys without a limit aren't checked.

A question stops whatever you're running, so safekeys only asks about a destination the command shows: a URL, an ssh/scp/rsync target (also behind `sudo`, `sshpass` or `VAR=value`), or a bare host given to a network tool such as `curl`, `nc` or `mysql`. Dotted names like `mysql.user` or `nginx.service`, `$(...)`, and `localhost` never ask. Whatever a command runs on an allowed ssh host is that host's business and isn't checked.

To stop the questions for every key at once, keep the limits saved but switch them off:

```
/safekeys bindings off    # bound keys go anywhere without asking; masking is unchanged
/safekeys bindings on
```

## How it works

- Prompts are rewritten before Claude Code saves or sends them, so the key is replaced with `$NAME`.
- Commands that use `$NAME` load the real value from the keychain as they run; the value never appears in the command.
- Every tool result is masked before Claude reads it, including encoded copies (hex, also as `xxd` and `od` print it, base64, upper case, escaped and so on) and long pieces of a key. A tool call that would write a key of 12 or more characters is refused. A shorter key is masked only as a whole word and never refuses a call: `root` as a password is also the user name in the same command.

## Limits

- It prevents accidental leaks. It can't stop a session that an attacker already controls.
- Auto mode may still refuse a command that writes a key to a file. That's auto mode's decision; run that step yourself if needed.
- The key is visible in your input box until you press Enter.
- A destination held in a variable (`curl "$API_URL"`) or run by a script can't be seen, so it isn't checked.

## Develop

```
claude --plugin-dir ./safekeys        # run locally
cd safekeys && claude plugin test     # tests
```

[MIT](LICENSE)
