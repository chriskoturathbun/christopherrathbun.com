# ⌚ Claude Code → Apple Watch approvals

Approve or deny Claude Code permission prompts from your Apple Watch.

When Claude Code needs your OK to run something (a shell command, a file
write, a web fetch) while you're away from the keyboard, this bridge pushes
a notification to your iPhone with **Approve** and **Deny** buttons. iOS
mirrors the notification — buttons included — to your Apple Watch, so a tap
on your wrist unblocks (or blocks) Claude.

```
Claude Code ──PreToolUse hook──▶ ntfy.sh ──push──▶ iPhone ──mirror──▶ Apple Watch
     ▲                                                                    │
     └────────────── hook polls response topic ◀──── tap Approve/Deny ────┘
```

No app to build, no Apple developer account: it rides on
[ntfy](https://ntfy.sh) (free, open-source push notifications) and Claude
Code's built-in [hooks](https://code.claude.com/docs/en/hooks).

## Install (on the machine where you run Claude Code)

```bash
cd tools/watch-approve
./setup.sh
```

The installer:

1. generates two random ntfy topic names (request + response) — these act
   as the shared secret, so don't post them anywhere public;
2. installs the hook and the `away` toggle to `~/.claude/watch-approve/`;
3. adds a `PreToolUse` hook to `~/.claude/settings.json` (a timestamped
   backup of your settings is made first);
4. sends a test notification.

Then on your **iPhone**: install the free **ntfy** app from the App Store,
subscribe to the topic the installer printed, and allow notifications. Your
**Apple Watch** needs no setup — iOS mirrors iPhone alerts to the watch by
default (check Watch app → Notifications → Mirror iPhone Alerts → ntfy).

Restart Claude Code so it loads the hook.

## Use

```bash
~/.claude/watch-approve/away on     # heading out — route approvals to the watch
~/.claude/watch-approve/away off    # back at the desk — normal prompts
~/.claude/watch-approve/away status
```

With away mode **on**, whenever Claude Code wants to run a matched tool
(`Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch`, `WebSearch`) your
watch buzzes with the tool name and a summary (the shell command, the file
path, the URL). On the watch, tap the notification to reveal the buttons:

- **Approve** → the tool runs immediately.
- **Deny** → the tool call is blocked and Claude is told it was denied.
- **No response within 4 minutes** → falls back to the normal terminal
  prompt, exactly as if this bridge weren't installed.

With away mode **off**, the hook exits instantly and Claude Code behaves
completely normally.

## Easier toggling

**Shell alias** — add to `~/.zshrc`:

```bash
alias away="$HOME/.claude/watch-approve/away"
```

**Fully automatic (macOS)** — away mode follows your screen lock:

```bash
./setup-auto-away.sh            # install; ./setup-auto-away.sh uninstall to remove
```

This installs a LaunchAgent that polls the lock state every 10 s: lock the
Mac → away mode turns on; unlock → it turns off. If you set away mode on
*manually*, unlocking won't turn it off — the agent only clears what it
set itself. Expect up to ~10 s after locking before approvals start
routing to the watch.

## Configuration

`~/.claude/watch-approve/config.json`:

| Key | Default | Meaning |
|-----|---------|---------|
| `server` | `https://ntfy.sh` | ntfy server (point at your own for self-hosting) |
| `topic` | random | topic your phone subscribes to |
| `response_topic` | random | topic the Approve/Deny buttons publish to |
| `timeout_seconds` | `240` | how long to wait for a tap before falling back |

If you raise `timeout_seconds`, also raise the hook `timeout` in
`~/.claude/settings.json` (it must stay larger, currently 300 s).

To change **which tools** ping your watch, edit the `matcher` regex on the
hook entry in `~/.claude/settings.json`. Add `|mcp__.*` to cover MCP tools.

## Security notes

- The topic names are the only secret. They're 16 random hex chars each —
  unguessable in practice — but anyone who learns the response topic could
  approve on your behalf, and each approval message carries a per-request
  random ID so replays of old taps don't approve new requests. For a
  stronger setup, self-host ntfy with [access control](https://docs.ntfy.sh/config/#access-control)
  and put credentials in `config.json`'s `server` URL.
- In away mode, an **Approve** bypasses the permission prompt for that one
  tool call only; nothing is added to any allowlist.
- The hook fails safe: if ntfy is unreachable, config is missing, or
  anything errors, Claude Code falls back to its normal permission flow.

## Heads-up

- The hook runs before Claude Code's own permission rules, so in away mode
  even tool calls you've allowlisted (e.g. `git status`) will ping your
  watch. That's the price of "ask me for everything while I'm out" — turn
  away mode off when you're back.
- This works for Claude Code running on your own machine (CLI/desktop).
  Claude Code **web** sessions run in Anthropic's cloud where you approve
  from the claude.ai web/mobile UI — those pushes already reach your watch
  via the Claude iOS app's notifications.
