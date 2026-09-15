#!/usr/bin/python3
"""Collect Hermes Agent usage and write hermes.json.

Reads the SQLite state Hermes Agent maintains at ~/.hermes/state.db:
`sessions` carries cumulative per-session token counters and timestamps and
`session_model_usage` carries per-model buckets with cost estimates. The
collector opens the database read-only and never writes to it.

The record shape matches the other usage records in
~/.local/state/omarchy/agents/usage/ (the contract Agent.qml consumes):
per-model modelUsage buckets, recentDays token totals, today totals, and
prompt/session/activity counts. Ranking lives in Model.js; this file only
owns the numbers.

Usage attribution: a session's tokens land on the local calendar date it
started; per-model usage lands on the local date of its first API call.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import NoReturn

USAGE_DIR = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "omarchy/agents/usage"
DB_PATH = Path(os.environ.get("HERMES_DB", Path.home() / ".hermes/state.db"))
RECORD_PATH = USAGE_DIR / "hermes.json"
LOCK_PATH = USAGE_DIR / ".hermes-collect.lock"
RECENT_DAYS = 7
SCHEMA_VERSION = 1


def fail(message: str) -> NoReturn:
  print(f"collect-hermes: {message}", file=sys.stderr)
  raise SystemExit(1)


def local_date(ts: float) -> str:
  """Local calendar date (YYYY-MM-DD) for a unix timestamp."""
  return datetime.fromtimestamp(ts, timezone.utc).astimezone().strftime("%Y-%m-%d")


def local_midnight(now: datetime) -> datetime:
  return now.astimezone().replace(hour=0, minute=0, second=0, microsecond=0)


def recent_day_keys(now: datetime) -> list[str]:
  today = local_midnight(now)
  return [(today - timedelta(days=offset)).strftime("%Y-%m-%d") for offset in range(RECENT_DAYS - 1, -1, -1)]


def bucket_from_row(row: sqlite3.Row) -> dict:
  """Bucket in the shape Model.js's tokenBucketTotal() reads."""
  return {
    "inputTokens": int(row["input_tokens"] or 0),
    "outputTokens": int(row["output_tokens"] or 0) + int(row["reasoning_tokens"] or 0),
    "cacheReadInputTokens": int(row["cache_read_tokens"] or 0),
    "cacheCreationInputTokens": int(row["cache_write_tokens"] or 0),
    "apiCalls": int(row["api_call_count"] or 0),
  }


def bucket_total(bucket: dict) -> int:
  return (bucket["inputTokens"] + bucket["outputTokens"]
          + bucket["cacheReadInputTokens"] + bucket["cacheCreationInputTokens"])


def open_db_readonly() -> sqlite3.Connection:
  if not DB_PATH.exists():
    fail(f"no Hermes state database at {DB_PATH}")
  conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
  conn.row_factory = sqlite3.Row
  return conn


def model_key(model: str) -> str:
  """Normalized key: lowercase, keeping any provider prefix (z-ai/glm-...)."""
  return str(model or "").strip().lower()


def collect(now: datetime) -> dict:
  day_keys = recent_day_keys(now)
  today_key = day_keys[-1]
  today_start = local_midnight(now).timestamp()
  week_start = (local_midnight(now) - timedelta(days=RECENT_DAYS - 1)).timestamp()

  conn = open_db_readonly()
  try:
    sessions = conn.execute(
      "SELECT id, model, started_at, last_activity_at, message_count, input_tokens,"
      " output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,"
      " api_call_count FROM sessions"
    ).fetchall()
    model_rows = conn.execute(
      "SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,"
      " reasoning_tokens, api_call_count, first_seen, estimated_cost_usd, actual_cost_usd"
      " FROM session_model_usage"
    ).fetchall()
    prompts_by_day = conn.execute(
      "SELECT timestamp FROM messages WHERE role = 'user'"
    ).fetchall()
  except sqlite3.OperationalError as exc:
    fail(f"Hermes schema mismatch ({exc}); the collector needs sessions,"
         " session_model_usage and messages tables")

  tokens_by_day = {key: 0 for key in day_keys}
  model_tokens_by_day: dict[str, dict[str, int]] = {}
  model_usage: dict[str, dict] = {}
  today_by_model: dict[str, int] = {}
  active_dates: set[str] = set()
  total_tokens = 0

  for row in sessions:
    started = row["started_at"] or 0
    if started <= 0:
      continue
    date = local_date(started)
    active_dates.add(date)
    tokens = bucket_total(bucket_from_row(row))
    total_tokens += tokens
    if date in tokens_by_day:
      tokens_by_day[date] += tokens

  for row in model_rows:
    key = model_key(row["model"])
    if not key:
      continue
    bucket = bucket_from_row(row)
    tokens = bucket_total(bucket)
    if tokens <= 0:
      continue
    entry = model_usage.setdefault(key, {
      "inputTokens": 0, "outputTokens": 0,
      "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0, "apiCalls": 0,
    })
    for field in entry:
      entry[field] += int(bucket[field] or 0)
    first_seen = row["first_seen"] or 0
    if first_seen > 0:
      date = local_date(first_seen)
      if date in day_keys:
        model_tokens_by_day.setdefault(key, {})
        model_tokens_by_day[key][date] = model_tokens_by_day[key].get(date, 0) + tokens
      if date == today_key:
        today_by_model[key] = today_by_model.get(key, 0) + tokens
  conn.close()

  prompts_total = 0
  prompts_today = 0
  for row in prompts_by_day:
    ts = row["timestamp"] or 0
    if ts <= 0:
      continue
    prompts_total += 1
    if ts >= today_start:
      prompts_today += 1

  today_total = tokens_by_day.get(today_key, 0)
  week_total = sum(tokens_by_day.values())

  return {
    "schemaVersion": SCHEMA_VERSION,
    "id": "hermes",
    "name": "Hermes",
    "updatedAt": now.astimezone().isoformat(),
    "ready": True,
    "hasLocalStats": True,
    "todayPrompts": prompts_today,
    "todaySessions": _sessions_today(sessions, today_start),
    "todayTotalTokens": today_total,
    "todayTokensByModel": today_by_model,
    "recentDays": [{"date": key, "messageCount": tokens_by_day[key]} for key in day_keys],
    "weekTotalTokens": week_total,
    "totalPrompts": prompts_total,
    "totalSessions": len(sessions),
    "activeDays": len(active_dates),
    "activeDates": sorted(active_dates),
    "modelUsage": model_usage,
    "estimatedCostUsd": round(sum(float(r["estimated_cost_usd"] or 0) for r in model_rows), 6),
    "actualCostUsd": round(sum(float(r["actual_cost_usd"] or 0) for r in model_rows), 6),
  }


def _sessions_today(sessions, today_start: float) -> int:
  return sum(1 for row in sessions if (row["started_at"] or 0) >= today_start)


def write_record(record: dict) -> None:
  USAGE_DIR.mkdir(parents=True, exist_ok=True)
  handle, tmp_name = tempfile.mkstemp(dir=USAGE_DIR, prefix=".hermes-", suffix=".tmp")
  try:
    with os.fdopen(handle, "w", encoding="utf-8") as f:
      json.dump(record, f, indent=2, sort_keys=True)
      f.write("\n")
    os.replace(tmp_name, RECORD_PATH)
  except BaseException:
    try:
      os.unlink(tmp_name)
    except OSError:
      pass
    raise


def main() -> int:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--print", action="store_true", help="print the record instead of writing it")
  parser.add_argument("--now", type=float, default=None, help=argparse.SUPPRESS)
  args = parser.parse_args()

  now = datetime.fromtimestamp(args.now, timezone.utc) if args.now else datetime.now(timezone.utc)

  # One writer at a time (refresh timer + manual refresh can race).
  USAGE_DIR.mkdir(parents=True, exist_ok=True)
  lock = open(LOCK_PATH, "w")
  try:
    fcntl.flock(lock, fcntl.LOCK_EX)
    record = collect(now)
  finally:
    fcntl.flock(lock, fcntl.LOCK_UN)
    lock.close()

  if args.print:
    print(json.dumps(record, indent=2, sort_keys=True))
  else:
    write_record(record)
    print(f"wrote {RECORD_PATH}")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
