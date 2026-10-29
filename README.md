# safekeys

Give Claude Code your API keys without putting them in the chat.

```
$:STRIPE_KEY=sk_live_abc123 add this to .env
```

safekeys moves the key into your OS keychain before the prompt is sent or saved. Claude only ever sees:

```
$STRIPE_KEY add this to .env
```

Claude uses `$STRIPE_KEY` like a normal environment variable, so the real key ends up in your `.env`. If the key ever shows up in command output, Claude sees `$STRIPE_KEY` there too. The key never reaches the model, the transcript, or your prompt history.

## Install

In Claude Code (v2.1.287 or newer):

```
/plugin marketplace add pravnyadv/claude-plugins
/plugin install safekeys@pravnyadv
```

Then run `/reload-plugins` or start a new session.

macOS works out of the box. On Linux, install `secret-tool` (`sudo apt install libsecret-tools`) and have a keyring running (GNOME Keyring or KWallet). Windows isn't supported yet.

## Use it

| Type this | Claude sees |
|---|---|
| `$:STRIPE_KEY=sk_live_abc123` | `$STRIPE_KEY` |
| `$:sk_live_abc123` | `$SK_7F3A` (random name) |
| `$:PHRASE="has some spaces"` | `$PHRASE` |

A key ends at the first space unless you quote it. Keys shorter than 6 characters are refused.

Manage stored keys:

```
/safekeys list          # shows names, never values
/safekeys rm STRIPE_KEY
/safekeys clear         # removes all of them
```

A key you add in one session works in all your open sessions right away.

## How it works

- **Your prompt:** the `$:` value is saved to the keychain under the service `claude_safekeys` and replaced with `$NAME`. If saving fails, the prompt isn't sent.
- **Bash commands:** a command that uses `$NAME` gets the value from the keychain when it runs. The value never appears in the command text.
- **Tool output:** any stored value is replaced with `$NAME` before Claude reads it.

## Good to know

- safekeys prevents accidents. It won't stop a model that deliberately reads your keychain, and it can't mask a key that has been encoded or split.
- The key is visible in your input box until you press Enter.
- `$:` after a slash command isn't supported. Put it in a normal prompt.
- Files Claude writes (like `.env`) contain the real key, as they should.
- If you use Bash permission rules, they see the command with the keychain lookup added in front.

## Develop

```
claude --plugin-dir ./safekeys        # try it locally with hot reload
cd safekeys && claude plugin test     # run the tests
```

## License

[MIT](LICENSE)
