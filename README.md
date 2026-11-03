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
```

To write about the `$:` syntax without storing anything, end the prompt with `$;`.

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
$:SUDO_PW@local=...                      never leaves this machine
$:KEY@api.example.com,ssh:box=...        any of these
```

Already saved a key without a limit? Add one without retyping the key: `$:GH_TOKEN@api.github.com` (no `=`). The same form changes an existing limit.

If a command would send a bound key anywhere else, safekeys asks you before it runs. Keys without a limit aren't checked.

## How it works

- Prompts are rewritten before Claude Code saves or sends them, so the key is replaced with `$NAME`.
- Commands that use `$NAME` load the real value from the keychain as they run; the value never appears in the command.
- Every tool result is masked before Claude reads it, including encoded copies (hex, base64 and so on) and long pieces of a key. A tool call that would write a key is refused.

## Limits

- It prevents accidental leaks. It can't stop a session that an attacker already controls.
- Auto mode may still refuse a command that writes a key to a file. That's auto mode's decision; run that step yourself if needed.
- The key is visible in your input box until you press Enter.

## Develop

```
claude --plugin-dir ./safekeys        # run locally
cd safekeys && claude plugin test     # tests
```

[MIT](LICENSE)
