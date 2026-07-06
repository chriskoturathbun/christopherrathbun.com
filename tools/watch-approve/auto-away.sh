#!/usr/bin/env bash
# Auto-toggle away mode with the macOS screen lock.
# Locked screen  -> away mode ON  (approvals go to your watch)
# Unlocked       -> away mode OFF (normal terminal prompts)
#
# Runs as a LaunchAgent (see setup-auto-away.sh). Polls the lock state
# every POLL seconds via IORegistry. If you turned away mode on manually
# with `away on`, unlocking will NOT turn it off — the agent only clears
# the flag when it was the one who set it.
set -u

DIR="${CLAUDE_WATCH_DIR:-$HOME/.claude/watch-approve}"
FLAG="$DIR/away-mode-on"
AUTO_MARK="$DIR/.away-set-by-auto"
POLL="${CLAUDE_WATCH_LOCK_POLL:-10}"

screen_locked() {
  ioreg -n Root -d1 -a 2>/dev/null | grep -q CGSSessionScreenIsLocked
}

while true; do
  if screen_locked; then
    if [ ! -f "$FLAG" ]; then
      mkdir -p "$DIR"
      touch "$AUTO_MARK" "$FLAG"
    fi
  else
    if [ -f "$AUTO_MARK" ]; then
      rm -f "$FLAG" "$AUTO_MARK"
    fi
  fi
  sleep "$POLL"
done
