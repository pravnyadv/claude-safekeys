# safekeys

A Claude Code plugin for giving Claude an API key or password without pasting it into the chat.

```
$:STRIPE_KEY=sk_live_abc123 add this to .env
```

The key goes into your OS keychain before the prompt is saved or sent. Claude sees `$STRIPE_KEY add this to .env`, uses `$STRIPE_KEY` like any environment variable, and sees `$STRIPE_KEY` again wherever the real value would show up in command output. The key doesn't end up in the model's context, the saved transcript or your prompt history.

## Install

You need Claude Code v2.1.287 or newer.

```
/plugin marketplace add pravnyadv/claude-plugins
/plugin install safekeys@pravnyadv
```

Then run `/reload-plugins`. macOS works out of the box. On Linux, install `secret-tool` (`sudo apt install libsecret-tools`) and have a keyring running, such as GNOME Keyring.

## Use

| You type | Claude sees |
|---|---|
| `$:STRIPE_KEY=sk_live_abc123` | `$STRIPE_KEY` |
| `$:sk_live_abc123` | `$SK_7F3A` (a random name) |
| `$:PHRASE="has some spaces"` | `$PHRASE` |
| `$STRIPE_KEY` | a key you saved earlier, in any session |

```
/safekeys list         # names only, never values
/safekeys rm STRIPE_KEY
/safekeys clear
/safekeys ignore       # tools whose quoted $: history is let through (see Details)
/safekeys bindings     # whether key limits are checked (see below)
```

To write about the `$:` syntax without storing anything, end the prompt with `$;`.

## Check it yourself

Don't take my word for it. Send a throwaway value in Claude Code:

```
$:DEMO_KEY=sk_live_test_1234567890abcdef   say hello
```

Then search everything Claude Code saved, from a normal terminal:

```
grep -rl "sk_live_test_1234567890abcdef" ~/.claude/projects ~/.claude/history.jsonl
```

Nothing should match. On 0.5.5 the saved prompt reads `$DEMO_KEY say hello`, and a later command containing the value, or a piece of it, was blocked. Clean up with `/safekeys rm DEMO_KEY`.

## Limiting where a key can go

You can pin a key to the places it's allowed to be sent by adding `@` after the name:

```
$:GH_TOKEN@api.github.com=ghp_...        only that host
$:VIRA_SUDO@ssh:vira.com=...             only over ssh/scp/rsync to vira.com
$:SUDO_PW@local=...                      never leaves this machine (localhost is fine)
$:KEY@api.example.com,ssh:box=...        any of these
$:QA_PW@ssh:*.niswey.net=...             over ssh to any host under niswey.net
```

If you saved a key without a limit, add one without retyping it: `$:GH_TOKEN@api.github.com` (no `=`). The same form changes an existing limit.

When a command would send a bound key somewhere else, safekeys asks you before it runs. Keys with no limit are never checked.

Asking interrupts whatever Claude is doing, so safekeys only asks about a destination it can actually see in the command: a URL, an ssh/scp/rsync target (including behind `sudo`, `sshpass` or `VAR=value`), or a bare host given to a network tool like `curl`, `nc` or `mysql`. Dotted names such as `mysql.user` or `nginx.service`, `$(...)`, and `localhost` never ask. What runs on an allowed ssh host is that host's business and isn't checked.

To stop the questions for every key without losing the saved limits:

```
/safekeys bindings off    # bound keys go anywhere without asking; masking is unchanged
/safekeys bindings on
```

## How it works

- A hook rewrites your prompt before Claude Code saves or sends it, swapping the key for `$NAME`.
- When Claude runs a command that mentions `$NAME`, the hook reads the real value from the keychain and exports it for that command. The value never appears in the command text.
- Every tool result is masked before Claude reads it. That covers encoded copies (hex, including how `xxd` and `od` print it, base64, upper case, escaped forms) and long pieces of a key.
- A tool call that would write a key of 12 or more characters is refused. Shorter keys are masked only as whole words and never refuse a call, because `root` as a password is also the user name in the same command.

## What it covers, and what it doesn't

It covers three places Claude Code keeps things: the prompt you type (so the key isn't in the saved transcript or `~/.claude/history.jsonl`), tool output, and tool input that would write the key out.

It doesn't cover:

- A key Claude saw before you installed safekeys, or one you pasted without `$:`.
- Your shell history, other tools' logs, or a key you type into a file yourself.
- Keys shorter than 12 characters in tool output. They're masked as whole words only.
- Windows. It supports macOS (Keychain) and Linux (`secret-tool`) only.

## Known limits

- It guards against accidents. A session an attacker already controls is out of reach.
- Your key is visible in the input box until you press Enter.
- A destination hidden in a variable (`curl "$API_URL"`) or inside a script can't be seen, so it isn't checked.
- Auto mode can refuse the first run of a command that uses a stored key. safekeys adds a line to the front of the command, and auto mode then says a hook changed the command after it reviewed it. Claude can send the rewritten command again and it goes through, but a model sometimes gives up instead. If yours does, approve the command yourself or switch out of auto mode for that step. It's the same for a command that writes a key into a file.

## Why not a .env file?

A `.env` file keeps the key out of your prompt, but you still have to tell Claude about it. Once you paste the key or ask Claude to read the file, the value is in the conversation and the saved transcript. Exporting it in your shell has the same gap. safekeys works on the prompt itself, so the value is replaced before anything is stored, and it also masks keys that turn up in command output.

## Details

A bare value ends at the first space, minus any trailing `, . ; : ? ) ] }` that ordinary prose puts after it. A trailing `!` stays. If the value really ends in one of those characters, quote it: `$:PW="secret."`.

`$:` is also Ruby's load path, so the shapes Ruby writes it in are left alone: `$:.unshift x`, `$:.include?(x)`, `$:<<` and `$:[0]`. Without this, pasting Ruby into a prompt would store a piece of code as a key. A bare value that looks like one of those, such as `$:.word` followed by a space, needs a name or quotes: `$:PW=.word` or `$:".word"`. Generated passwords almost never look like that, and the named form is never affected.

### Tools that replay old conversations

Some tools feed your old conversations back through `claude -p`, for example to learn from them. A `$:` quoted in that history isn't a key being handed over, so safekeys shouldn't store it or refuse the prompt. Such a tool sets an environment variable, and safekeys lets those prompts through as written (stored values in them are still masked):

| Variable | Set by |
|---|---|
| `SAFEKEYS_IGNORE=1` | any tool, or a wrapper you put around one |
| `CLAUDE_SMART_INTERNAL=1` | [claude-smart](https://github.com/ReflexioAI/claude-smart)'s learning calls (recognized as is) |

If a tool sets nothing, wrap the command it runs: `SAFEKEYS_IGNORE=1 exec claude "$@"`. The variable only counts for prompts sent through `claude -p` or the SDK. What you type in a session is always guarded, even with the variable exported.

```
/safekeys ignore                              # the variables, and whether each is honored
/safekeys ignore off CLAUDE_SMART_INTERNAL    # guard those prompts like any other again
/safekeys ignore on CLAUDE_SMART_INTERNAL
```

## Develop

```
claude --plugin-dir ./safekeys        # run locally
cd safekeys && claude plugin test     # tests
```

[MIT](LICENSE)
