#!/usr/bin/python3
"""Run Omarchy's Fireworks collector and write fireworks.json.

The official script uses urllib with no User-Agent. Cloudflare then
returns 1010, and the collector reports that as a billing-permission
error. Same collector, same OpenCode/firectl key — only the header is
added. If the official write already succeeded, this is a no-op.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import urllib.request
from contextlib import redirect_stdout
from pathlib import Path


def usage_path() -> Path:
  root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
  folder = root / "omarchy" / "agents" / "usage"
  folder.mkdir(parents=True, exist_ok=True)
  return folder / "fireworks.json"


def official_collector() -> Path:
  omarchy = os.environ.get("OMARCHY_PATH", "/usr/share/omarchy")
  path = Path(omarchy) / "bin" / "omarchy-agent-usage-fireworks"
  if path.is_file():
    return path
  found = shutil.which("omarchy-agent-usage-fireworks")
  if found:
    return Path(found)
  raise SystemExit("omarchy-agent-usage-fireworks not found")


def patch_user_agent() -> None:
  original = urllib.request.Request

  class Request(original):
    def __init__(self, *args, **kwargs):
      super().__init__(*args, **kwargs)
      if not self.has_header("User-agent"):
        self.add_header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) OmarchyAgentUsage/1.0")

  urllib.request.Request = Request


def usable(record: dict) -> bool:
  if record.get("ready") is not True:
    return False
  if record.get("todayTotalTokens") or record.get("activeDays"):
    return True
  usage = record.get("modelUsage") or {}
  return isinstance(usage, dict) and len(usage) > 0


def write_json(path: Path, payload: dict) -> None:
  handle_fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
  tmp = Path(tmp_name)
  try:
    with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
      handle.write(json.dumps(payload, separators=(",", ":")) + "\n")
    tmp.chmod(0o644)
    tmp.replace(path)
  except BaseException:
    tmp.unlink(missing_ok=True)
    raise


def main() -> int:
  path = usage_path()
  try:
    existing = json.loads(path.read_text(encoding="utf-8"))
  except Exception:
    existing = {}
  if isinstance(existing, dict) and usable(existing):
    return 0

  patch_user_agent()
  collector = official_collector()
  import runpy

  ns = runpy.run_path(str(collector), run_name="omarchy-agent-usage-fireworks")
  buf = io.StringIO()
  argv = sys.argv
  sys.argv = [str(collector)]
  try:
    with redirect_stdout(buf):
      ns["main"]()
  finally:
    sys.argv = argv

  raw = buf.getvalue().strip()
  try:
    record = json.loads(raw)
  except Exception:
    print("omarchy-agent-usage-fireworks returned no JSON", file=sys.stderr)
    return 1
  if not isinstance(record, dict):
    return 1
  if usable(record):
    record["source"] = "cloudflare-ua"
  write_json(path, record)
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
