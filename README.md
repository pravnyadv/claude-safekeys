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
| `$:STRIPE_KEY` (already saved) | `$STRIPE_KEY`, using the saved key; nothing new is stored |

A key ends at the first space unless you quote it; trailing punctuation like `,` or `.` isn't part of it. Keys must be 4 or more plain ASCII characters, with no line breaks. One prompt can hold several keys, and if any of them is refused, none are stored.

Once a key is saved, just write `$STRIPE_KEY` in any prompt, in any session, and Claude knows it's a saved key. If you paste a saved key's raw value into a prompt by mistake, it's swapped for `$STRIPE_KEY` too.

To talk about the `$:` syntax without storing anything, end the prompt with `$;`. safekeys then reads no `$:` in it and removes the `$;` before sending, though any key you've already saved is still masked. When safekeys refuses a prompt, your text goes back to the input box and the message tells you what to do.

A `$:` inside backticks is refused rather than skipped, because people often paste real keys in backticks. If it's only an example, add `$;`.

Manage stored keys:

```
/safekeys list          # names and bindings, never values
/safekeys rm STRIPE_KEY
/safekeys clear         # removes all of them
```

A key you add in one session works in all your open sessions right away.

## Say where a key may go (optional)

A key can carry a binding: the places it's allowed to go. Add `@` and a list after the name.

| Type this | The key may go |
|---|---|
| `$:GH_TOKEN@api.github.com=ghp_...` | only to `api.github.com` |
| `$:GEMINI@generativelanguage.googleapis.com=AIza...` | only to that host |
| `$:WEB@*.example.com=...` | to `example.com`'s subdomains |
| `$:VIRA_SUDO@ssh:vira.com=...` | only over `ssh`, `scp` or `rsync` to `vira.com` |
| `$:VIRA_SUDO@ssh:vira-box=...` | to an SSH alias from `~/.ssh/config` (it also matches the host the alias points to) |
| `$:SUDO_PW@local=...` | nowhere: it must not leave this machine (`sudo -S` locally is fine) |
| `$:A@api.example.com,ssh:vira.com=...` | any of the listed places |
| `$:K@any=...` | anywhere: same as no binding |
| `$:GH_TOKEN@api.github.com` | (no `=`) changes the binding of a saved key, without retyping it |

When Claude runs a command that uses a bound key, safekeys reads where the command would send it: web hosts in URLs or arguments, and the target of `ssh`, `scp`, `sftp` and `rsync`. If every destination is allowed, nothing changes. If the command would send the key somewhere else, or runs code safekeys can't read (`$(...)`, `eval`), safekeys stops and asks you before it runs. Saying no refuses the command. Saying yes lets it run once, and your normal permission checks, including auto mode's classifier, still apply on top.

Several keys can share a host. Three Gemini keys from three accounts can all be bound to the same API host; pick the account by the key's name, like `$GEMINI_WORK`. Bind exact hosts rather than whole domains: a big domain such as `googleapis.com` also serves other people's content, so allowing all of it would allow a key to be sent to a stranger's bucket on the same domain.

Keys without a binding aren't checked, so nothing changes unless you opt in.

What a binding is for: it catches a key heading somewhere you didn't intend, by mistake or because Claude followed an instruction it read in a web page, an issue or an API response. What it can't do: stop a session that is already fully under an attacker's control, which can read the keychain directly without ever naming the key. The protection against that is Claude Code's own (its model, auto mode's classifier, the sandbox and your permission rules). A binding also can't judge what a request does at an allowed host.

If you quote a binding example such as `$:NAME@host` and no key by that name exists, safekeys refuses it rather than storing the text as a key.

## How it works

- **Your prompt:** the `$:` value is saved to the keychain under the service `claude_safekeys` and replaced with `$NAME`. If saving fails, the prompt isn't sent.
- **Bash commands:** a command that uses `$NAME` gets a `. safekeys-env NAME` line in front. That small script ships with the plugin (in `bin/`, which Claude Code puts on the shell's `PATH`) and reads the value from the keychain as the command runs, so the value never appears in the command text. Keeping the keychain read inside the script also means auto mode's classifier no longer sees a raw keychain lookup in every command. It can still refuse a command that writes a key into a file or sends it out ("Credential Leakage"); that is its call to make, and you can run such a step yourself or add a permission rule for it.
- **Tool output:** a stored value is replaced with `$NAME` before Claude reads it, in every field of the result (an Edit keeps the whole original file, for example). That covers the plain value and also hex, base64, URL- or JSON-escaped and reversed copies, plus any piece of 12 characters or more, even with colour codes mixed in.
- **Tool input:** a tool call whose input contains a stored value, or any of those forms, is refused before it runs. So is a command that prints part or a changed copy of a key, like `${KEY:0:8}` or `${KEY^^}`. Claude can't write a key into a file, a command or a web request by itself.
- **`@` mentions:** mentioning a file that holds a saved key (`@.env`) is refused with a notice. Ask Claude to read the file instead; that output is masked.

## Good to know

- safekeys stops keys leaking by accident or through a casual command. It can't stop a determined attempt to pull a key out a few characters at a time (asking whether it contains a digit, printing it in pieces under 12 characters, and so on), and it doesn't stop a command from sending `$NAME` to a server. A model that can use a key can always learn something about it.
- Keys under 8 characters are masked anywhere in output, but in commands and prompts only where they stand as a whole word. A short key that is also an ordinary word, like `main`, will block every command containing that word, so give short keys something unusual.
- In sessions where your organisation manages Claude Code (Team or Enterprise login, or managed settings), Claude Code doesn't let a mod rewrite the "this file changed" reminders it sends Claude. If Claude has read a file holding a key and the file then changes, that reminder can include the key.
- The key is visible in your input box until you press Enter.
- `$:` in a slash command isn't supported. Put it in a normal prompt.
- Files Claude writes (like `.env`) contain the real key, as they should.
- If you use Bash permission rules, they see the command with the keychain lookup added in front.

## Develop

```
claude --plugin-dir ./safekeys        # try it locally with hot reload
cd safekeys && claude plugin test     # run the tests
```

## License

[MIT](LICENSE)
