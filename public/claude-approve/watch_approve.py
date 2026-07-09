#!/usr/bin/env python3
"""Claude Code -> Apple Watch approval bridge (PreToolUse hook).

Reads the PreToolUse hook payload from stdin. When away mode is on, pushes
a notification with Approve/Deny action buttons to an ntfy topic, then polls
a response topic for the tap. Emits a permissionDecision for Claude Code:

    Approve tapped  -> allow
    Deny tapped     -> deny
    no answer       -> ask   (falls back to the normal permission prompt)

Fails safe: any error (bad config, network down, malformed input) exits 0
with no output, which leaves Claude Code's normal permission flow untouched.

Python 3 stdlib only. Config lives at ~/.claude/watch-approve/config.json
(override with CLAUDE_WATCH_CONFIG).
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE_DIR = os.environ.get(
    "CLAUDE_WATCH_DIR", os.path.expanduser("~/.claude/watch-approve")
)
CONFIG_PATH = os.environ.get(
    "CLAUDE_WATCH_CONFIG", os.path.join(BASE_DIR, "config.json")
)
AWAY_FLAG = os.path.join(BASE_DIR, "away-mode-on")
POLL_INTERVAL_SECONDS = 3
MAX_DETAIL_CHARS = 400


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)
    if cfg.get("backend") == "worker":
        required = ("worker_url", "worker_secret")
    else:
        required = ("server", "topic", "response_topic")
    for key in required:
        if not cfg.get(key):
            raise ValueError(f"config missing {key!r}")
    if "server" in cfg:
        cfg["server"] = cfg["server"].rstrip("/")
    if "worker_url" in cfg:
        cfg["worker_url"] = cfg["worker_url"].rstrip("/")
    return cfg


def away_mode_on():
    return os.path.exists(AWAY_FLAG) or os.environ.get("CLAUDE_WATCH_ALWAYS") == "1"


def summarize_tool(tool_name, tool_input):
    if not isinstance(tool_input, dict):
        tool_input = {}
    if tool_name == "Bash":
        detail = tool_input.get("command", "")
    elif tool_name in ("Write", "Edit", "NotebookEdit"):
        detail = tool_input.get("file_path") or tool_input.get("notebook_path", "")
    elif tool_name in ("WebFetch", "WebSearch"):
        detail = tool_input.get("url") or tool_input.get("query", "")
    else:
        detail = json.dumps(tool_input, separators=(",", ":"))
    detail = detail.replace("\n", " ⏎ ")
    if len(detail) > MAX_DETAIL_CHARS:
        detail = detail[: MAX_DETAIL_CHARS - 1] + "…"
    return detail


def http_json(url, payload=None, timeout=15, bearer=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def send_request_notification(cfg, request_id, tool_name, detail, cwd):
    respond_url = f"{cfg['server']}/{cfg['response_topic']}"
    message = f"{detail}\n\nin {cwd}" if cwd else detail
    payload = {
        "topic": cfg["topic"],
        "title": f"Claude Code wants to run {tool_name}",
        "message": message,
        "priority": 4,
        "tags": ["robot"],
        "actions": [
            {
                "action": "http",
                "label": "Approve",
                "url": respond_url,
                "method": "POST",
                "body": f"approve {request_id}",
                "clear": True,
            },
            {
                "action": "http",
                "label": "Deny",
                "url": respond_url,
                "method": "POST",
                "body": f"deny {request_id}",
                "clear": True,
            },
        ],
    }
    http_json(cfg["server"] + "/", payload)


def wait_for_response(cfg, request_id, started_at, timeout_seconds):
    """Poll the response topic until an approve/deny for request_id arrives."""
    poll_url = (
        f"{cfg['server']}/{cfg['response_topic']}/json"
        f"?poll=1&since={int(started_at) - 1}"
    )
    deadline = started_at + timeout_seconds
    while time.time() < deadline:
        try:
            body = http_json(poll_url)
        except (urllib.error.URLError, OSError):
            body = ""
        for line in body.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("event") != "message":
                continue
            msg = (event.get("message") or "").strip()
            # Exact-ID match (notification buttons) or a bare approve/deny
            # (e.g. from an Apple Watch Shortcut). Bare messages only count
            # because the poll window starts at this request's start time.
            if msg in (f"approve {request_id}", "approve"):
                return "approve"
            if msg in (f"deny {request_id}", "deny"):
                return "deny"
        time.sleep(POLL_INTERVAL_SECONDS)
    return None


def worker_create_request(cfg, tool_name, detail, cwd):
    body = http_json(
        cfg["worker_url"] + "/requests",
        {"tool": tool_name, "detail": detail, "cwd": cwd},
        bearer=cfg["worker_secret"],
    )
    data = json.loads(body)
    return data["id"], int(data.get("pushed", 0))


def worker_wait_for_response(cfg, request_id, started_at, timeout_seconds):
    """Long-poll the request on the Worker until it's approved/denied.

    ?wait=1 makes the Worker hold each poll open until a decision lands
    (or ~25s), so a tap on the watch unblocks Claude immediately.
    """
    url = f"{cfg['worker_url']}/requests/{request_id}?wait=1"
    deadline = started_at + timeout_seconds
    while time.time() < deadline:
        try:
            body = http_json(url, bearer=cfg["worker_secret"], timeout=35)
            status = json.loads(body).get("status")
        except (urllib.error.URLError, OSError, json.JSONDecodeError, ValueError):
            time.sleep(POLL_INTERVAL_SECONDS)  # back off on errors
            continue
        if status == "approved":
            return "approve"
        if status == "denied":
            return "deny"
        if status == "expired":
            return None
        # Still pending: normally the server held us ~25s, but guard against
        # fast returns (proxies, buffering) so this never becomes a tight loop.
        time.sleep(1)
    return None


def emit_decision(decision, reason):
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": decision,
                    "permissionDecisionReason": reason,
                }
            }
        )
    )


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return

    if not away_mode_on():
        return

    try:
        cfg = load_config()
    except (OSError, ValueError, json.JSONDecodeError):
        return

    tool_name = payload.get("tool_name", "a tool")
    detail = summarize_tool(tool_name, payload.get("tool_input"))
    started_at = time.time()
    timeout_seconds = int(cfg.get("timeout_seconds", 240))

    if cfg.get("backend") == "worker":
        try:
            request_id, pushed = worker_create_request(
                cfg, tool_name, detail, payload.get("cwd", "")
            )
        except (urllib.error.URLError, OSError, json.JSONDecodeError, KeyError, ValueError):
            return  # can't reach the Worker: fall back to the normal prompt
        if pushed == 0:
            return  # no device can receive the push — don't block for nothing
        decision = worker_wait_for_response(cfg, request_id, started_at, timeout_seconds)
    else:
        request_id = uuid.uuid4().hex[:12]
        try:
            send_request_notification(cfg, request_id, tool_name, detail, payload.get("cwd", ""))
        except (urllib.error.URLError, OSError):
            return  # can't reach ntfy: fall back to the normal prompt
        decision = wait_for_response(cfg, request_id, started_at, timeout_seconds)

    if decision == "approve":
        emit_decision("allow", "Approved from Apple Watch")
    elif decision == "deny":
        emit_decision("deny", "Denied from Apple Watch")
    else:
        emit_decision("ask", "No response from watch — asking at the terminal")


if __name__ == "__main__":
    main()
