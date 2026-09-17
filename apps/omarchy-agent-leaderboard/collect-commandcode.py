#!/usr/bin/python3
"""Collect Command Code usage and write commandcode.json.

Scans Command Code session transcripts under ~/.commandcode/projects/ and
compiles per-model and per-day token usage, matching the record contract
shared by the claude and codex collectors.

Each session is one JSONL file: a `session` header line ({ id, timestamp,
cwd }) followed by `message` lines. Assistant messages carry the model id
plus a per-request `usage` block of { inputTokens, outputTokens,
cacheReadTokens, cacheWriteTokens }; user messages carry either a `text`
prompt or `tool_result` blocks answering an earlier `tool_use`. Model
attribution is read off each message, so switching models mid-session is
handled correctly.

Command Code is subscription-billed with no rate-limit API, so "limits" is
always empty. The leaderboard still prices the tokens: model ids like
"meta/muse-spark-1.3-contributor" prefix-match the built-in "muse-spark"
rate table, which turns the record into an estimate of what the same work
would have cost on a hosted API. That is the point — it makes local
subscription inference comparable to the metered agents — but it is a
notional figure, not money spent, and usageStatusText says so.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

AGENT_ID = "commandcode"
AGENT_NAME = "Command Code"


def commandcode_dir() -> Path:
  return Path(os.environ.get("COMMANDCODE_CONFIG_DIR", Path.home() / ".commandcode"))


def sessions_root() -> Path:
  return commandcode_dir() / "projects"


def usage_dir() -> Path:
  root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
  folder = root / "omarchy" / "agents" / "usage"
  folder.mkdir(parents=True, exist_ok=True)
  return folder


def write_json(path: Path, payload: dict) -> None:
  handle_fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
  tmp = Path(tmp_name)
  try:
    with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
      handle.write(json.dumps(payload, indent=2) + "\n")
    tmp.chmod(0o644)
    tmp.replace(path)
  except BaseException:
    tmp.unlink(missing_ok=True)
    raise


def iter_entries(path: Path) -> Iterator[dict]:
  """Yield the parsed entries of one session file, skipping bad lines.

  A truncated final line is normal while Command Code is mid-write, so a
  parse failure never aborts the scan."""
  try:
    with open(path, encoding="utf-8") as handle:
      for line in handle:
        line = line.strip()
        if not line:
          continue
        try:
          entry = json.loads(line)
        except ValueError:
          continue
        if isinstance(entry, dict):
          yield entry
  except OSError:
    return


def iso_day(timestamp: Any) -> str | None:
  """Local YYYY-MM-DD for an ISO-8601 timestamp."""
  if not isinstance(timestamp, str) or not timestamp:
    return None
  try:
    parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
  except ValueError:
    return None
  if parsed.tzinfo is None:
    parsed = parsed.replace(tzinfo=timezone.utc)
  return parsed.astimezone().date().isoformat()


def new_bucket() -> dict[str, int]:
  return {
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheReadInputTokens": 0,
    "cacheCreationInputTokens": 0,
  }


def add_usage(bucket: dict[str, int], usage: dict) -> int:
  """Add one message's usage to a bucket; return the message's total."""
  fields = (
    ("inputTokens", "inputTokens"),
    ("outputTokens", "outputTokens"),
    ("cacheReadTokens", "cacheReadInputTokens"),
    ("cacheWriteTokens", "cacheCreationInputTokens"),
  )
  total = 0
  for src, dst in fields:
    try:
      value = int(usage.get(src) or 0)
    except (TypeError, ValueError):
      value = 0
    bucket[dst] += value
    total += value
  return total


def model_key(entry: dict) -> str:
  model = entry.get("model")
  if isinstance(model, str) and model.strip():
    return model.strip()
  return "unknown"


def is_prompt(message: dict) -> bool:
  """A user message only counts as a prompt when it carries real text.

  Command Code keeps tool output under its own "tool_result" blocks, so this
  mostly filters out empty or result-only turns."""
  if message.get("role") != "user":
    return False
  content = message.get("content")
  if isinstance(content, str):
    return content.strip() != ""
  if isinstance(content, list):
    return any(isinstance(block, dict) and block.get("type") == "text" for block in content)
  return False


def is_tool_result_only(message: dict) -> bool:
  if message.get("role") != "user":
    return False
  content = message.get("content")
  if not isinstance(content, list) or not content:
    return False
  return all(isinstance(block, dict) and block.get("type") == "tool_result" for block in content)


def empty_record(ready: bool) -> dict[str, Any]:
  return {
    "id": AGENT_ID,
    "name": AGENT_NAME,
    "schemaVersion": 1,
    "ready": ready,
    "hasLocalStats": ready,
    "hasPromptStats": ready,
    "todayPrompts": 0,
    "todaySessions": 0,
    "todayTotalTokens": 0,
    "todayTokensByModel": {},
    "recentDays": [],
    "totalPrompts": 0,
    "totalSessions": 0,
    "activeDays": 0,
    "activeDates": [],
    "modelUsage": {},
    "limits": [],
    "tierLabel": "Subscription",
    "usageStatusText": (
      "Subscription inference — no quota and no API spend. Any cost shown is "
      "an estimate of the same tokens at hosted API rates."
    ) if ready else "",
    "authHelpText": "" if ready else "Run Command Code at least once to track usage.",
    "updatedAt": datetime.now(timezone.utc).isoformat(),
  }


def collect_metrics() -> dict[str, Any]:
  root = sessions_root()
  transcripts = sorted(root.glob("*/*.jsonl")) if root.is_dir() else []
  transcripts = [p for p in transcripts if not p.name.endswith(".checkpoints.jsonl")]
  record = empty_record(bool(transcripts))
  if not transcripts:
    return record

  today = datetime.now().date()
  week_start = today - timedelta(days=6)
  model_usage: dict[str, dict[str, int]] = {}
  today_by_model: dict[str, dict[str, int]] = {}
  day_tokens: dict[str, int] = {}

  for transcript in transcripts:
    session_day: str | None = None
    counted_session = False

    for entry in iter_entries(transcript):
      kind = entry.get("type")

      if kind == "session":
        if counted_session:
          continue
        counted_session = True
        session_day = iso_day(entry.get("timestamp"))
        record["totalSessions"] += 1
        if session_day == today.isoformat():
          record["todaySessions"] += 1
        continue

      if kind != "message":
        continue
      message = entry.get("message")
      if not isinstance(message, dict):
        continue

      day = iso_day(entry.get("timestamp")) or session_day

      # One assistant message can fan out into several blocks (text plus a
      # tool_use each), but every block shares the message's per-request
      # usage — count it exactly once.
      if message.get("role") == "assistant":
        usage = entry.get("usage")
        if isinstance(usage, dict):
          model = model_key(entry)
          total = add_usage(model_usage.setdefault(model, new_bucket()), usage)
          if total > 0 and day is not None:
            day_tokens[day] = day_tokens.get(day, 0) + total
            if day == today.isoformat():
              record["todayTotalTokens"] += total
              add_usage(today_by_model.setdefault(model, new_bucket()), usage)
        continue

      if is_tool_result_only(message):
        continue
      if is_prompt(message):
        record["totalPrompts"] += 1
        if day == today.isoformat():
          record["todayPrompts"] += 1

  # A model the harness only ever failed against contributes an all-zero
  # bucket; keeping it just adds an empty row to the leaderboard.
  record["modelUsage"] = {
    model: bucket for model, bucket in model_usage.items() if sum(bucket.values()) > 0
  }
  record["todayTokensByModel"] = {model: bucket for model, bucket in today_by_model.items() if sum(bucket.values()) > 0}
  record["recentDays"] = [
    {"date": (week_start + timedelta(days=offset)).isoformat(),
     "messageCount": day_tokens.get((week_start + timedelta(days=offset)).isoformat(), 0)}
    for offset in range(7)
  ]
  record["activeDates"] = sorted(day for day, tokens in day_tokens.items() if tokens > 0)
  record["activeDays"] = len(record["activeDates"])
  return record


def main() -> int:
  parser = argparse.ArgumentParser(description="Collect Command Code usage")
  parser.add_argument("--force", action="store_true", help="accepted for interface parity")
  parser.add_argument("--limits-only", action="store_true", help="accepted for interface parity")
  parser.add_argument("--cache-seconds", type=float, default=10.0, help="accepted for interface parity")
  parser.add_argument("--print", action="store_true", help="print JSON output")
  args, _ = parser.parse_known_args()

  record = collect_metrics()
  write_json(usage_dir() / "commandcode.json", record)

  if not sys.stdout.isatty() or args.print:
    print(json.dumps(record, indent=2))
  return 0


if __name__ == "__main__":
  sys.exit(main())
