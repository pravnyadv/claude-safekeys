# safekeys

Give Claude Code an API key without the key ever entering the conversation.

Type the key into your prompt with a `$:` prefix:

```
$:STRIPE_KEY=sk_live_abc123 add this to .env as STRIPE_KEY
```

Before the prompt goes anywhere, safekeys saves `sk_live_abc123` to your OS keychain and swaps it for a reference. Claude, the API, the session transcript and your prompt history all get this instead:

```
$STRIPE_KEY add this to .env as STRIPE_KEY
```

Claude then uses `$STRIPE_KEY` like any environment variable, and the real value lands in your `.env`. If the value ever shows up in a tool's output (`cat .env`, a log line, an error), Claude sees `$STRIPE_KEY` there too.

## Install

safekeys is a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview), so it needs Claude Code v2.1.287 or later. It was tested with v2.1.312.

```
/plugin marketplace add pravnyadv/claude-safekeys
/plugin install safekeys@safekeys
```

On Linux you also need `secret-tool` (Debian and Ubuntu: `sudo apt install libsecret-tools`) and a running Secret Service such as GNOME Keyring or KWallet. macOS uses the built-in Keychain. Windows isn't supported yet.

## Usage

| You type | Claude sees |
|---|---|
| `$:STRIPE_KEY=sk_live_abc123` | `$STRIPE_KEY` |
| `$:sk_live_abc123` | `$SK_7F3A` (a random name) |
| `$:PHRASE="correct horse battery staple"` | `$PHRASE` |

A bare value runs up to the next space. If a value contains spaces, wrap it in double quotes, or everything after the first space goes out with the rest of your prompt. Values shorter than 6 characters are refused, because masking anything that short would mangle ordinary output.

To manage what you've stored, run:

```
/safekeys list        # names only, never values
/safekeys rm STRIPE_KEY
/safekeys clear       # remove every safekeys secret
```

All values sit under one keychain service, `claude_safekeys`, so they never mix with your other passwords. You can also wipe them from outside Claude Code:

```
# macOS: repeat until it reports nothing found
security delete-generic-password -s claude_safekeys
# Linux
secret-tool clear service claude_safekeys
```

## How it works

A mod's `prompt.submit` hook can rewrite a prompt before Claude Code stores or sends it. safekeys uses three hooks:

1. **Prompt:** finds `$:` tokens, stores each value in the keychain (over stdin, so it never shows up in `ps`), replaces the token with `$NAME`, and tells Claude what the reference means. If storing fails for any reason, the prompt is dropped and stays in your input box. A raw value is never sent as a fallback.
2. **Bash:** when a command mentions a stored name, safekeys prefixes it with an `export NAME="$(security find-generic-password ...)"` line (`secret-tool lookup` on Linux). The value is fetched from the keychain at run time, so it never appears in the command text.
3. **Every tool result:** any stored value in the output is replaced with its `$NAME` before Claude reads it. If that check itself fails, the result is withheld.

Every save or removal rewrites a small stamp file, `~/.claude/safekeys.stamp` (under `CLAUDE_CONFIG_DIR` if you set one). It holds a random token, never a key. Each session checks the stamp before using its list of keys and reloads from the keychain when it has changed. A key you store in one session is therefore usable and masked in every other open session straight away, with no reload.

## Limits

Read these before you rely on it:

- **It stops accidents. It doesn't defend against Claude acting on purpose.** Claude could run the keychain command itself. Masking only catches the value as stored, so output that has been encoded, split or partly printed won't be masked.
- **The key is visible in your input box** until you press Enter. Nothing writes it to disk before then, but anyone who can see your screen can read it.
- **Slash commands are not rewritten.** Claude Code doesn't let a mod change a slash command's line, so a `$:` token after a slash command is refused.
- **Your permission rules see the prefixed command.** A Bash allow rule written for the bare command may not match once the `export` line is added in front.
- **Files Claude writes hold the real value.** That's the point of writing a `.env`. safekeys masks the value when it's read back into the conversation, but the file itself is plain text, the same as any `.env`.
- **Stored values persist** until you remove them with `/safekeys rm` or `/safekeys clear`.

## Development

```
claude --plugin-dir ./safekeys          # run it with hot reload
cd safekeys && claude plugin test       # unit tests, no keychain or network
claude plugin validate ./safekeys
```

The tests fake `security` and `secret-tool`, so they cover the macOS and Linux paths on any machine.

## License

MIT
