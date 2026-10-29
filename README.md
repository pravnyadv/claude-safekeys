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
```

To write about the `$:` syntax without storing anything, end the prompt with `$;`.

## Limit where a key can go (optional)

Add `@` and the allowed places after the name:

```
$:GH_TOKEN@api.github.com=ghp_...        only that host
$:VIRA_SUDO@ssh:vira.com=...             only over ssh/scp/rsync to vira.com
$:SUDO_PW@local=...                      never leaves this machine
$:KEY@api.example.com,ssh:box=...        any of these
$:GH_TOKEN@api.github.com                change a saved key's binding
```

If a command would send a bound key anywhere else, safekeys asks you before it runs. Keys without a binding aren't checked.

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
