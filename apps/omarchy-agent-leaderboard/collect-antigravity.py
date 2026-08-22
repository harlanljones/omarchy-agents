#!/usr/bin/python3
"""Collect Antigravity CLI usage and write antigravity.json.

Scans Antigravity sessions, prompt history, and conversation transcripts
under ~/.gemini/antigravity-cli/ and compiles context-weighted usage metrics
and usage limits (Session and Weekly) matching Claude Code.

Model attribution is derived per-step by parsing USER_SETTINGS_CHANGE events
in each transcript, so switching models mid-session is handled correctly.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

BASE_SYSTEM_OVERHEAD = 16000  # System instructions, tool definitions, active skills overhead

# Maps lowercased display names (without parenthetical suffixes) to API-style keys.
MODEL_NAME_MAP: dict[str, str] = {
    "gemini 3.7 flash":        "gemini-3.7-flash",
    "gemini 3.7 flash medium": "gemini-3.7-flash",
    "gemini 3.7 pro":          "gemini-3.7-pro",
    "gemini 2.5 pro":          "gemini-2.5-pro",
    "gemini 2.5 flash":        "gemini-2.5-flash",
    "claude sonnet 4.6":       "claude-sonnet-4-6",
    "claude sonnet 4.5":       "claude-sonnet-4-5",
    "claude opus 4.6":         "claude-opus-4-6",
    "claude opus 4.5":         "claude-opus-4-5",
    "claude haiku 4.5":        "claude-haiku-4-5",
    "claude haiku 4.6":        "claude-haiku-4-6",
}

FALLBACK_MODEL = "gemini-3.7-flash"

# Default usage limits matching Claude Code structure
DEFAULT_SESSION_HOURS = 5
DEFAULT_WEEKLY_DAYS = 7
DEFAULT_GEMINI_SESSION_TOKEN_LIMIT = 150_000_000  # 150M context-weighted tokens per 5h window
DEFAULT_GEMINI_WEEKLY_TOKEN_LIMIT = 500_000_000   # 500M context-weighted tokens per 7d window
DEFAULT_CLAUDE_GPT_SESSION_TOKEN_LIMIT = 40_000_000   # 40M context-weighted tokens per 5h window
DEFAULT_CLAUDE_GPT_WEEKLY_TOKEN_LIMIT = 150_000_000   # 150M context-weighted tokens per 7d window
DEFAULT_TIER = "Pro"


def normalize_model(label: str) -> str:
  """Convert a user-facing model display name to an API-style key."""
  if not label:
    return FALLBACK_MODEL
  clean = re.sub(r"\s*\([^)]*\)\s*", " ", label).strip().lower()
  clean = re.sub(r"\s+", " ", clean)
  return MODEL_NAME_MAP.get(clean, re.sub(r"[^a-z0-9]+", "-", clean).strip("-") or FALLBACK_MODEL)


def model_category(model: str) -> str:
  """Categorize model into 'gemini' or 'claude_gpt'."""
  m = model.lower()
  if "claude" in m or "gpt" in m:
    return "claude_gpt"
  return "gemini"


def current_model_from_settings(agy_dir: Path) -> str:
  """Read the currently configured model from settings.json."""
  try:
    with open(agy_dir / "settings.json", encoding="utf-8") as f:
      data = json.load(f)
    return normalize_model(data.get("model", ""))
  except Exception:
    return FALLBACK_MODEL


def load_user_config() -> dict[str, Any]:
  """Load user override configuration from ~/.config/omarchy/agents/antigravity.json if present."""
  config_path = Path.home() / ".config" / "omarchy" / "agents" / "antigravity.json"
  if config_path.exists():
    try:
      with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f)
    except Exception:
      pass
  return {}


def usage_dir() -> Path:
  root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
  folder = root / "omarchy" / "agents" / "usage"
  folder.mkdir(parents=True, exist_ok=True)
  return folder


def cache_root() -> Path:
  root = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "omarchy" / "agent-usage"
  root.mkdir(parents=True, exist_ok=True)
  return root


def scan_cache_paths() -> tuple[Path, Path]:
  root = cache_root()
  return root / "antigravity-scan.json", root / "antigravity-scan.lock"


def limits_cache_paths() -> tuple[Path, Path]:
  root = cache_root()
  return root / "antigravity-limits.json", root / "antigravity-limits.lock"


def read_fresh_json(path: Path, max_age_seconds: float) -> dict[str, Any] | None:
  if max_age_seconds <= 0 or not path.exists():
    return None
  try:
    if time.time() - path.stat().st_mtime <= max_age_seconds:
      return json.loads(path.read_text(encoding="utf-8"))
  except Exception:
    return None
  return None


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


def probe_authoritative_limits() -> list[dict[str, Any]] | None:
  """Fetch live authoritative quota limits from Antigravity CLI."""
  try:
    import subprocess
    p = subprocess.run(
        ["agy", "--output-format", "json", "--print", "/usage"],
        capture_output=True,
        text=True,
        timeout=8,
    )
    if p.returncode != 0 or not p.stdout.strip():
      return None

    data = json.loads(p.stdout)
    groups = data.get("command", {}).get("data", {}).get("groups", [])
    if not groups:
      return None

    parsed_limits: dict[str, dict[str, Any]] = {}
    for g in groups:
      g_name = str(g.get("name", ""))
      for b in g.get("buckets", []):
        b_id = str(b.get("id", ""))
        rem = float(b.get("remaining_fraction", 1.0))
        used = max(0.0, min(1.0, 1.0 - rem))
        reset_time = str(b.get("reset_time", "") or "")
        if rem >= 0.9999 and "5h" in b_id:
          reset_time = ""

        if "gemini" in b_id or "Gemini" in g_name:
          if "5h" in b_id or b.get("window") == "5h":
            key = "gemini_session"
            title = "Gemini Session"
            label = "Gemini Session (5-hour)"
          else:
            key = "gemini_weekly"
            title = "Gemini Weekly"
            label = "Gemini Weekly (7-day)"
        else:
          if "5h" in b_id or b.get("window") == "5h":
            key = "claude_gpt_session"
            title = "Claude/GPT Session"
            label = "Claude/GPT Session (5-hour)"
          else:
            key = "claude_gpt_weekly"
            title = "Claude/GPT Weekly"
            label = "Claude/GPT Weekly (7-day)"

        parsed_limits[key] = {
            "label": label,
            "title": title,
            "percent": round(used, 4),
            "resetsAt": reset_time,
        }

    desired_order = ["gemini_session", "gemini_weekly", "claude_gpt_session", "claude_gpt_weekly"]
    result = [parsed_limits[k] for k in desired_order if k in parsed_limits]
    return result if len(result) == 4 else None
  except Exception:
    return None


def collect_authoritative_limits(force: bool = False, max_age_seconds: float = 30.0) -> list[dict[str, Any]] | None:
  cache_file, lock_file = limits_cache_paths()
  scan_age = 0.0 if force else max_age_seconds

  cached = read_fresh_json(cache_file, scan_age)
  if cached is not None and isinstance(cached.get("limits"), list):
    return cached["limits"]

  with lock_file.open("w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    cached = read_fresh_json(cache_file, scan_age)
    if cached is not None and isinstance(cached.get("limits"), list):
      return cached["limits"]

    limits = probe_authoritative_limits()
    if limits is not None:
      write_json(cache_file, {"limits": limits})
      return limits
  return None


# Regex to extract model changes from USER_SETTINGS_CHANGE content blocks.
_MODEL_CHANGE_RE = re.compile(
    r"Model Selection[^\n]*?from\s+(.+?)\s+to\s+(.+?)\.\s+No\b",
    re.DOTALL,
)


def collect_metrics(force: bool = False, limits_only: bool = False, max_age_seconds: float = 10.0) -> dict[str, Any]:
  agy_dir = Path.home() / ".gemini/antigravity-cli"
  history_file = agy_dir / "history.jsonl"
  brain_dir = agy_dir / "brain"

  scan_age = 0.0 if force else (900.0 if limits_only else max_age_seconds)
  cache_file, lock_file = scan_cache_paths()

  cached = read_fresh_json(cache_file, scan_age)
  if cached is not None:
    # If limits-only or force, refresh limits
    auth_limits = collect_authoritative_limits(force=force or limits_only)
    if auth_limits:
      cached["limits"] = auth_limits
    return cached

  with lock_file.open("w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    cached = read_fresh_json(cache_file, scan_age)
    if cached is not None:
      auth_limits = collect_authoritative_limits(force=force or limits_only)
      if auth_limits:
        cached["limits"] = auth_limits
      return cached

    cfg = load_user_config()
    session_hours = int(cfg.get("sessionHours", DEFAULT_SESSION_HOURS))
    weekly_days = int(cfg.get("weeklyDays", DEFAULT_WEEKLY_DAYS))

    gemini_session_limit = int(cfg.get("geminiSessionTokenLimit", cfg.get("geminiSessionLimit", DEFAULT_GEMINI_SESSION_TOKEN_LIMIT)))
    gemini_weekly_limit = int(cfg.get("geminiWeeklyTokenLimit", cfg.get("geminiWeeklyLimit", DEFAULT_GEMINI_WEEKLY_TOKEN_LIMIT)))
    claude_gpt_session_limit = int(cfg.get("claudeGptSessionTokenLimit", cfg.get("claudeGptSessionLimit", DEFAULT_CLAUDE_GPT_SESSION_TOKEN_LIMIT)))
    claude_gpt_weekly_limit = int(cfg.get("claudeGptWeeklyTokenLimit", cfg.get("claudeGptWeeklyLimit", DEFAULT_CLAUDE_GPT_WEEKLY_TOKEN_LIMIT)))
    tier_label = str(cfg.get("tier", DEFAULT_TIER))

    global_model = current_model_from_settings(agy_dir)
    now = datetime.now()
    now_utc = datetime.now(timezone.utc)
    today_str = now.strftime("%Y-%m-%d")
    recent_dates = [(now - timedelta(days=offset)).strftime("%Y-%m-%d") for offset in range(6, -1, -1)]

    session_window_start = now_utc - timedelta(hours=session_hours)
    weekly_window_start = now_utc - timedelta(days=weekly_days)

    prompts_by_day: dict[str, int] = {}
    sessions_by_day: dict[str, set[str]] = {}
    tokens_by_day: dict[str, int] = {}

    model_tokens_by_day: dict[str, dict[str, int]] = {}
    model_input: dict[str, int] = {}
    model_output: dict[str, int] = {}
    model_cache_read: dict[str, int] = {}

    total_prompts = 0
    all_sessions: set[str] = set()

    # Category tracking for Gemini Models and Claude and GPT Models
    category_tokens_today: dict[str, int] = {"gemini": 0, "claude_gpt": 0}
    category_session_tokens: dict[str, int] = {"gemini": 0, "claude_gpt": 0}
    category_weekly_tokens: dict[str, int] = {"gemini": 0, "claude_gpt": 0}
    category_oldest_session: dict[str, datetime | None] = {"gemini": None, "claude_gpt": None}
    category_oldest_weekly: dict[str, datetime | None] = {"gemini": None, "claude_gpt": None}

    def add_model_tokens(model: str, day: str, n: int) -> None:
      model_tokens_by_day.setdefault(model, {})
      model_tokens_by_day[model][day] = model_tokens_by_day[model].get(day, 0) + n

    # 1. Parse transcript logs; track active model per-step and calculate usage + limits
    if brain_dir.exists():
      for t_path in brain_dir.glob("*/.system_generated/logs/transcript.jsonl"):
        conv_id = t_path.parents[2].name
        all_sessions.add(conv_id)
        running_context = BASE_SYSTEM_OVERHEAD
        active_model = global_model

        try:
          with open(t_path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
              line = line.strip()
              if not line:
                continue
              try:
                step = json.loads(line)
                created = step.get("created_at")
                if created:
                  try:
                    if created.endswith("Z"):
                      dt_utc = datetime.fromisoformat(created[:-1] + "+00:00").astimezone(timezone.utc)
                    else:
                      dt_utc = datetime.fromisoformat(created).astimezone(timezone.utc)
                    dt_local = dt_utc.astimezone()
                    d_str = dt_local.strftime("%Y-%m-%d")
                  except Exception:
                    dt_utc = datetime.fromtimestamp(t_path.stat().st_mtime, timezone.utc)
                    d_str = dt_utc.astimezone().strftime("%Y-%m-%d")
                else:
                  dt_utc = datetime.fromtimestamp(t_path.stat().st_mtime, timezone.utc)
                  d_str = dt_utc.astimezone().strftime("%Y-%m-%d")

                sessions_by_day.setdefault(d_str, set()).add(conv_id)

                content = str(step.get("content", ""))
                step_type = step.get("type", "")

                # Detect model switches embedded in USER_INPUT steps
                if step_type == "USER_INPUT":
                  prompts_by_day[d_str] = prompts_by_day.get(d_str, 0) + 1
                  total_prompts += 1
                  if "Model Selection" in content:
                    for m in _MODEL_CHANGE_RE.finditer(content):
                      new_model = normalize_model(m.group(2).strip())
                      if new_model:
                        active_model = new_model

                if step_type == "PLANNER_RESPONSE":
                  thinking = str(step.get("thinking", "") or "")
                  tool_calls = json.dumps(step.get("tool_calls")) if step.get("tool_calls") else ""
                  out_chars = len(content) + len(thinking) + len(tool_calls)
                  payload_tokens = max(1, out_chars // 4)

                  step_total = running_context + payload_tokens
                  model_output[active_model] = model_output.get(active_model, 0) + payload_tokens
                  model_cache_read[active_model] = model_cache_read.get(active_model, 0) + running_context
                  running_context += payload_tokens
                else:
                  payload_tokens = max(1, len(content) // 4)
                  step_total = payload_tokens
                  if step_type == "USER_INPUT":
                    model_input[active_model] = model_input.get(active_model, 0) + payload_tokens
                  running_context += payload_tokens

                tokens_by_day[d_str] = tokens_by_day.get(d_str, 0) + step_total
                add_model_tokens(active_model, d_str, step_total)

                cat = model_category(active_model)
                if d_str == today_str:
                  category_tokens_today[cat] += step_total

                # Check rolling limits windows per category
                if dt_utc >= session_window_start:
                  category_session_tokens[cat] += step_total
                  if category_oldest_session[cat] is None or dt_utc < category_oldest_session[cat]:
                    category_oldest_session[cat] = dt_utc

                if dt_utc >= weekly_window_start:
                  category_weekly_tokens[cat] += step_total
                  if category_oldest_weekly[cat] is None or dt_utc < category_oldest_weekly[cat]:
                    category_oldest_weekly[cat] = dt_utc

              except Exception:
                continue
        except Exception:
          continue

    # 2. Fallback to history.jsonl if no transcripts found
    if total_prompts == 0 and history_file.exists():
      try:
        with open(history_file, "r", encoding="utf-8", errors="ignore") as f:
          for line in f:
            line = line.strip()
            if not line:
              continue
            try:
              item = json.loads(line)
              if item.get("type") == "slash_command":
                continue
              ts = item.get("timestamp", 0) / 1000.0
              dt_loc = datetime.fromtimestamp(ts)
              d_str = dt_loc.strftime("%Y-%m-%d")
              prompts_by_day[d_str] = prompts_by_day.get(d_str, 0) + 1
              total_prompts += 1
              conv_id = item.get("conversationId")
              if conv_id:
                sessions_by_day.setdefault(d_str, set()).add(conv_id)
                all_sessions.add(conv_id)
            except Exception:
              continue
      except Exception:
        pass

    # 3. Assemble limits: prefer authoritative probe from Google Antigravity servers
    auth_limits = collect_authoritative_limits(force=force or limits_only)
    if auth_limits:
      limits = auth_limits
    else:
      gemini_session_percent = min(1.0, round(category_session_tokens["gemini"] / gemini_session_limit, 4)) if gemini_session_limit > 0 else 0.0
      gemini_weekly_percent = min(1.0, round(category_weekly_tokens["gemini"] / gemini_weekly_limit, 4)) if gemini_weekly_limit > 0 else 0.0
      claude_gpt_session_percent = min(1.0, round(category_session_tokens["claude_gpt"] / claude_gpt_session_limit, 4)) if claude_gpt_session_limit > 0 else 0.0
      claude_gpt_weekly_percent = min(1.0, round(category_weekly_tokens["claude_gpt"] / claude_gpt_weekly_limit, 4)) if claude_gpt_weekly_limit > 0 else 0.0

      def make_reset_str(tokens: int, oldest_dt: datetime | None, delta: timedelta) -> str:
        if tokens > 0 and oldest_dt is not None:
          return (oldest_dt + delta).isoformat()
        return ""

      limits = [
          {
              "label": f"Gemini Session ({session_hours}-hour)",
              "title": "Gemini Session",
              "percent": gemini_session_percent,
              "resetsAt": make_reset_str(category_session_tokens["gemini"], category_oldest_session["gemini"], timedelta(hours=session_hours)),
          },
          {
              "label": f"Gemini Weekly ({weekly_days}-day)",
              "title": "Gemini Weekly",
              "percent": gemini_weekly_percent,
              "resetsAt": make_reset_str(category_weekly_tokens["gemini"], category_oldest_weekly["gemini"], timedelta(days=weekly_days)),
          },
          {
              "label": f"Claude/GPT Session ({session_hours}-hour)",
              "title": "Claude/GPT Session",
              "percent": claude_gpt_session_percent,
              "resetsAt": make_reset_str(category_session_tokens["claude_gpt"], category_oldest_session["claude_gpt"], timedelta(hours=session_hours)),
          },
          {
              "label": f"Claude/GPT Weekly ({weekly_days}-day)",
              "title": "Claude/GPT Weekly",
              "percent": claude_gpt_weekly_percent,
              "resetsAt": make_reset_str(category_weekly_tokens["claude_gpt"], category_oldest_weekly["claude_gpt"], timedelta(days=weekly_days)),
          },
      ]

    # 4. Assemble output
    today_tokens = tokens_by_day.get(today_str, 0)
    active_dates = sorted(set(list(prompts_by_day.keys()) + list(tokens_by_day.keys())))
    recent_days = [{"date": d, "messageCount": tokens_by_day.get(d, 0)} for d in recent_dates]

    all_models = set(model_input) | set(model_output) | set(model_cache_read)
    if not all_models:
      all_models = {global_model}

    model_usage: dict[str, dict] = {}
    for m in sorted(all_models):
      model_usage[m] = {
          "inputTokens": model_input.get(m, 0),
          "outputTokens": model_output.get(m, 0),
          "cacheReadInputTokens": model_cache_read.get(m, 0),
          "cacheCreationInputTokens": BASE_SYSTEM_OVERHEAD * max(len(all_sessions), 1),
      }

    today_by_model: dict[str, int] = {
        m: model_tokens_by_day.get(m, {}).get(today_str, 0)
        for m in all_models
        if model_tokens_by_day.get(m, {}).get(today_str, 0) > 0
    }
    if not today_by_model and today_tokens > 0:
      today_by_model = {global_model: today_tokens}

    record = {
        "id": "antigravity",
        "name": "Antigravity",
        "schemaVersion": 1,
        "ready": True,
        "hasLocalStats": True,
        "hasPromptStats": True,
        "todayTotalTokens": today_tokens,
        "todayPrompts": prompts_by_day.get(today_str, 0),
        "todaySessions": len(sessions_by_day.get(today_str, set())),
        "totalPrompts": total_prompts,
        "totalSessions": max(len(all_sessions), 1),
        "activeDates": active_dates,
        "activeDays": len(active_dates),
        "recentDays": recent_days,
        "modelUsage": model_usage,
        "todayTokensByModel": today_by_model,
        "categories": {
            "gemini": {
                "name": "Gemini Models",
                "models": [m for m in all_models if model_category(m) == "gemini"],
                "todayTokens": category_tokens_today["gemini"],
                "sessionTokens": category_session_tokens["gemini"],
                "weeklyTokens": category_weekly_tokens["gemini"],
            },
            "claude_gpt": {
                "name": "Claude and GPT Models",
                "models": [m for m in all_models if model_category(m) == "claude_gpt"],
                "todayTokens": category_tokens_today["claude_gpt"],
                "sessionTokens": category_session_tokens["claude_gpt"],
                "weeklyTokens": category_weekly_tokens["claude_gpt"],
            },
        },
        "limits": limits,
        "tierLabel": tier_label,
        "usageStatusText": "",
        "authHelpText": "",
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }

    write_json(cache_file, record)
    return record


def main() -> int:
  parser = argparse.ArgumentParser(description="Collect Antigravity CLI usage")
  parser.add_argument("--force", action="store_true", help="force re-scan")
  parser.add_argument("--limits-only", action="store_true", help="refresh limits")
  parser.add_argument("--cache-seconds", type=float, default=10.0, help="cache max age")
  parser.add_argument("--print", action="store_true", help="print JSON output")
  args, _ = parser.parse_known_args()

  record = collect_metrics(force=args.force, limits_only=args.limits_only, max_age_seconds=args.cache_seconds)
  target = usage_dir() / "antigravity.json"
  write_json(target, record)

  if not sys.stdout.isatty() or args.print:
    print(json.dumps(record, indent=2))
  return 0


if __name__ == "__main__":
  sys.exit(main())



