#!/usr/bin/env python3
"""
Sprint runner — orchestrates the full SDLC pipeline for one or more sprints
from `mvp-prd/sprint-planning/`.

Pipeline per sprint:
    branch -> research -> plan -> build (per spec, with /commit)
    -> test (with patch loop) -> e2e (with patch loop)
    -> review (with patch loop) -> document
    -> push + PR + merge (with conflict-resolution agent)

Sprints run sequentially. Failure in any sprint stops the whole run.

Run:
    python tools/sprint_runner.py --sprint 03
    python tools/sprint_runner.py --sprint 03-08
    python tools/sprint_runner.py --sprint 03,07,11
    python tools/sprint_runner.py --resume <run_id>
    python tools/sprint_runner.py --list-sprints
    python tools/sprint_runner.py --sprint 03 --dry-run

State and logs land in `.developer/sprint-runs/<run_id>/`.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import io
import json
import os
import queue
import random
import re
import shutil
import signal
import socket
import subprocess
import sys
import textwrap
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Iterable, Optional

# ─── Paths ─────────────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).resolve().parents[1]
SPRINT_DIR = REPO_ROOT / "mvp-prd" / "sprint-planning"
RESEARCH_DIR = REPO_ROOT / "research"
SPECS_DIR = REPO_ROOT / "specs"
PATCH_SPECS_DIR = SPECS_DIR / "patch"
AI_DOCS_DIR = REPO_ROOT / "ai_docs"
E2E_DIR = REPO_ROOT / ".claude" / "commands" / "e2e"
RUNS_DIR = REPO_ROOT / ".developer" / "sprint-runs"
LEARNINGS_FILE = REPO_ROOT / ".developer" / "merge-learnings.jsonl"

CLAUDE_BIN = "claude"
PLAN_MODEL = "claude-opus-4-7[1m]"       # research + plan + merge-conflict
EXECUTE_MODEL = "sonnet"                 # build/test/e2e/review/document/commit (200K)
CLAUDE_MODEL = PLAN_MODEL                # deprecated alias — resolves to PLAN_MODEL
DEFAULT_MAX_TURNS = 120
BUILD_MAX_TURNS = 200
E2E_MAX_TURNS = 300
MERGE_AGENT_MAX_TURNS = 80
E2E_PATCH_MAX_CYCLES = 5
REVIEW_PATCH_MAX_CYCLES = 5
TEST_PATCH_MAX_CYCLES = 6

MAX_TRANSIENT_RETRIES = 5
TRANSIENT_BACKOFF_BASE = 120   # seconds
TRANSIENT_BACKOFF_CAP  = 300

# ─── Idle timeouts ─────────────────────────────────────────────────────────
# How long _invoke_once will wait between stream-json events from claude
# before declaring the agent hung and killing it. These are *idle* timeouts
# (no progress), not total wall-clock budgets — a phase that streams events
# steadily is allowed to take as long as it needs.
IDLE_TIMEOUT_DEFAULT_S = 600       # 10 min — fast phases (commit, review, document)
IDLE_TIMEOUT_BUILD_S   = 1800      # 30 min — generous ceiling; Sentinel has no
                                   # transpile/compile step (ESM .mjs runs direct).
                                   # Most builds are just file edits + small tests.
IDLE_TIMEOUT_E2E_S     = 1800      # 30 min — generous ceiling; Sentinel E2E (if any)
                                   # is a scripted Claude Code session, not a UI runner.
IDLE_TIMEOUT_TEST_S    = 1800      # 30 min — generous ceiling; `make validate` +
                                   # `node --test tests/` typically completes in
                                   # seconds. The agent must still call BashOutput
                                   # every 30–60 s per CLAUDE.md so a true hang is
                                   # caught well before this ceiling.

BUGFIX_PLAN_MAX_TURNS = 150            # Opus 1M classifies + writes plan
BUGFIX_IMPLEMENT_MAX_TURNS = 200       # same as BUILD_MAX_TURNS
STAGNATION_THRESHOLD = 2
MAX_TEST_ESCALATIONS_PER_SPRINT = 1    # default; CLI can override

# ─── Utility ───────────────────────────────────────────────────────────────

def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def log(msg: str) -> None:
    ts = dt.datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def fail(msg: str, code: int = 1) -> "NoReturn":
    log(f"FATAL: {msg}")
    sys.exit(code)


_TRANSIENT_MSG_RE = re.compile(
    r"(?i)api error:\s*5\d\d|overloaded|rate[_ -]?limit|timeout"
)

_TRANSIENT_STATUS_CODES = {429, 500, 502, 503, 504}


def classify_claude_error(evt: dict) -> "tuple[str, Optional[int]]":
    """Classify a Claude result event as 'transient', 'fatal', or 'ok'.

    Returns (kind, api_error_status).
    """
    if evt.get("type") != "result":
        return ("ok", None)
    if not evt.get("is_error"):
        return ("ok", None)
    status = evt.get("api_error_status")
    result_text = evt.get("result", "") or ""
    if status in _TRANSIENT_STATUS_CODES or _TRANSIENT_MSG_RE.search(result_text):
        return ("transient", status)
    return ("fatal", status)


def run_cmd(
    *args: str,
    cwd: Path = REPO_ROOT,
    check: bool = True,
    capture: bool = True,
    env: Optional[dict] = None,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        list(args),
        cwd=cwd,
        capture_output=capture,
        text=True,
        check=check,
        env=env,
    )


# ─── Run lock ──────────────────────────────────────────────────────────────

class RunLock:
    """Heartbeat file a dashboard uses to tell live runs from abandoned ones.

    Writes `<run_dir>/RUNNING.lock` with {pid, host, started_at, heartbeat_at}
    and refreshes `heartbeat_at` every HEARTBEAT_INTERVAL seconds from a
    daemon thread. Deletes the file on clean exit (context-manager `__exit__`
    runs even when the run raises or `sys.exit`s). A true crash — SIGKILL,
    host reboot, Python segfault — leaves the file behind with a stale
    heartbeat, which is the signal the dashboard uses to mark it abandoned.
    """

    HEARTBEAT_INTERVAL = 5  # seconds

    def __init__(self, run_dir: Path):
        self.path = run_dir / "RUNNING.lock"
        self.started_at = now_iso()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def __enter__(self) -> "RunLock":
        self._write(self.started_at)
        self._thread = threading.Thread(
            target=self._heartbeat_loop, name="run-lock-heartbeat", daemon=True
        )
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self.HEARTBEAT_INTERVAL + 1)
        try:
            self.path.unlink(missing_ok=True)
        except OSError:
            pass

    def _write(self, heartbeat_at: str) -> None:
        payload = {
            "pid": os.getpid(),
            "host": socket.gethostname(),
            "started_at": self.started_at,
            "heartbeat_at": heartbeat_at,
        }
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(payload))
        tmp.replace(self.path)

    def _heartbeat_loop(self) -> None:
        while not self._stop.wait(self.HEARTBEAT_INTERVAL):
            try:
                self._write(now_iso())
            except OSError:
                # A transient filesystem error must not crash the run.
                pass


# ─── State ─────────────────────────────────────────────────────────────────

class State:
    """Atomic JSON state file. Reload on every read; write atomically."""

    def __init__(self, path: Path):
        self.path = path
        self.data: dict[str, Any] = {}
        if path.exists():
            self.data = json.loads(path.read_text())

    def save(self) -> None:
        self.data["updated_at"] = now_iso()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.data, indent=2, default=str))
        tmp.replace(self.path)

    def sprint(self, sprint_id: str) -> dict:
        for s in self.data.setdefault("sprints", []):
            if s["sprint_id"] == sprint_id:
                return s
        raise KeyError(sprint_id)

    def init_sprint(self, sprint_id: str, defaults: dict) -> dict:
        sprints = self.data.setdefault("sprints", [])
        for s in sprints:
            if s["sprint_id"] == sprint_id:
                return s
        sprints.append(defaults)
        self.save()
        return defaults


# ─── Claude headless runner ────────────────────────────────────────────────

@dataclasses.dataclass
class ClaudeResult:
    exit_code: int
    duration_seconds: float
    last_assistant_text: str
    log_path: Path
    cost_usd: float
    num_turns: int
    error: Optional[str] = None
    error_kind: Optional[str] = None
    api_error_status: Optional[int] = None
    transient_retries: int = 0

    @property
    def succeeded(self) -> bool:
        return self.exit_code == 0 and not self.error


class ClaudeRunner:
    def __init__(self, log_dir: Path, dry_run: bool = False):
        self.log_dir = log_dir
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.dry_run = dry_run

    def _invoke_once(
        self,
        prompt: str,
        step_name: str,
        max_turns: int,
        log_path: Path,
        prompt_path: Path,
        model: str,
        idle_timeout_seconds: int = IDLE_TIMEOUT_DEFAULT_S,
    ) -> ClaudeResult:
        """Single subprocess invocation of claude. Callers handle retries.

        Reads claude's stream-json stdout via a background thread feeding a
        queue, so the main loop can enforce an idle timeout: if no event
        arrives for `idle_timeout_seconds`, the entire claude process group
        is killed and the result is marked error_kind="hung". This guards
        against deadlocks inside the agent (e.g. a `tail -f | grep | head`
        pipeline whose follow stream never closes).
        """
        prompt_path.write_text(prompt)

        cmd = [
            CLAUDE_BIN,
            "-p", prompt,
            "--model", model,
            "--dangerously-skip-permissions",
            "--output-format", "stream-json",
            "--verbose",
            "--max-turns", str(max_turns),
        ]

        start = time.monotonic()
        last_text = ""
        cost = 0.0
        num_turns = 0
        error: Optional[str] = None
        error_kind: Optional[str] = None
        api_error_status: Optional[int] = None
        exit_code = 0

        proc: Optional[subprocess.Popen] = None
        EOF = object()  # sentinel pushed by reader when stdout closes

        def _reader(stdout, q: "queue.Queue"):
            try:
                for line in stdout:
                    q.put(line)
            finally:
                q.put(EOF)

        def _kill_group(p: subprocess.Popen) -> None:
            try:
                pgid = os.getpgid(p.pid)
            except ProcessLookupError:
                return
            try:
                os.killpg(pgid, signal.SIGTERM)
            except ProcessLookupError:
                return
            try:
                p.wait(timeout=5)
                return
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                return
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass

        try:
            with log_path.open("w") as logf:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    cwd=REPO_ROOT,
                    text=True,
                    bufsize=1,
                    start_new_session=True,
                )
                assert proc.stdout is not None
                q: "queue.Queue" = queue.Queue()
                reader = threading.Thread(
                    target=_reader, args=(proc.stdout, q), daemon=True
                )
                reader.start()

                while True:
                    try:
                        item = q.get(timeout=idle_timeout_seconds)
                    except queue.Empty:
                        log(
                            f"      ⏱ {step_name} idle timeout "
                            f"({idle_timeout_seconds}s with no claude event) — "
                            f"killing process group"
                        )
                        _kill_group(proc)
                        error = (
                            f"idle timeout: no claude event for "
                            f"{idle_timeout_seconds}s"
                        )
                        error_kind = "hung"
                        exit_code = 124
                        break
                    if item is EOF:
                        proc.wait()
                        exit_code = proc.returncode
                        break
                    line = item
                    logf.write(line)
                    logf.flush()
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        evt = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    et = evt.get("type")
                    if et == "assistant":
                        for blk in evt.get("message", {}).get("content", []):
                            if blk.get("type") == "text":
                                last_text = blk.get("text", "")
                    elif et == "result":
                        cost = float(evt.get("total_cost_usd") or 0.0)
                        num_turns = int(evt.get("num_turns") or 0)
                        # Each result event is the authoritative outcome of the most
                        # recent Claude turn batch. The CLI emits multiple result events
                        # when a run hits --max-turns and then continues; the final event
                        # reflects the true terminal state. Reset prior diagnostic state
                        # so it cannot survive into a later success.
                        error = None
                        error_kind = None
                        api_error_status = None
                        sub = evt.get("subtype")
                        if sub and sub != "success":
                            error = f"result.subtype={sub}"
                        if evt.get("is_error"):
                            error = (error or "") + " is_error=true"
                            error_kind, api_error_status = classify_claude_error(evt)
                        result_text = evt.get("result")
                        if result_text:
                            last_text = result_text
        except KeyboardInterrupt:
            if proc is not None:
                proc.send_signal(signal.SIGINT)
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    _kill_group(proc)
            raise
        except Exception as e:
            exit_code = 1
            error = repr(e)
            if proc is not None and proc.poll() is None:
                _kill_group(proc)

        duration = time.monotonic() - start
        log(
            f"      ← {step_name} exit={exit_code} turns={num_turns} "
            f"cost=${cost:.3f} dur={duration:.1f}s model={model}"
        )
        return ClaudeResult(
            exit_code=exit_code,
            duration_seconds=duration,
            last_assistant_text=last_text,
            log_path=log_path,
            cost_usd=cost,
            num_turns=num_turns,
            error=error,
            error_kind=error_kind,
            api_error_status=api_error_status,
        )

    def run(
        self,
        prompt: str,
        step_name: str,
        max_turns: int = DEFAULT_MAX_TURNS,
        attempt: int = 1,
        model: str = PLAN_MODEL,
        idle_timeout_seconds: int = IDLE_TIMEOUT_DEFAULT_S,
    ) -> ClaudeResult:
        suffix = f"-attempt-{attempt}" if attempt > 1 else ""
        base_log_path = self.log_dir / f"{step_name}{suffix}.jsonl"
        base_prompt_path = self.log_dir / f"{step_name}{suffix}.prompt.txt"

        if self.dry_run:
            base_prompt_path.write_text(prompt)
            base_log_path.write_text(
                json.dumps({"dry_run": True, "step": step_name, "prompt_chars": len(prompt), "model": model}) + "\n"
            )
            return ClaudeResult(0, 0.0, "[dry run]", base_log_path, 0.0, 0)

        for retry in range(MAX_TRANSIENT_RETRIES + 1):
            if retry == 0:
                log_path = base_log_path
                prompt_path = base_prompt_path
            else:
                # Insert -retry-M before the .jsonl / .prompt.txt extension.
                stem = f"{step_name}{suffix}-retry-{retry}"
                log_path = self.log_dir / f"{stem}.jsonl"
                prompt_path = self.log_dir / f"{stem}.prompt.txt"

            log(f"      → claude {step_name} (max_turns={max_turns}, attempt={attempt}"
                + (f", inner_retry={retry}" if retry else "") + ")")

            result = self._invoke_once(
                prompt, step_name, max_turns, log_path, prompt_path, model,
                idle_timeout_seconds=idle_timeout_seconds,
            )

            if result.error_kind != "transient" or retry >= MAX_TRANSIENT_RETRIES:
                result.transient_retries = retry
                return result

            # Transient error and we have retries left — extract request_id if present.
            req_id_m = re.search(r"request_id[=:\s]+(\S+)", result.last_assistant_text or "")
            req_id = req_id_m.group(1) if req_id_m else "unknown"
            backoff = min(
                TRANSIENT_BACKOFF_BASE + (2 ** retry) * 30 + random.random() * 60,
                TRANSIENT_BACKOFF_CAP,
            )
            log(
                f"      ⚠ transient API error ({result.api_error_status}) — "
                f"retry {retry + 1}/{MAX_TRANSIENT_RETRIES} in {backoff:.0f}s "
                f"(req_id={req_id})"
            )
            log(
                f"      ↻ retrying {step_name} "
                f"(inner retry {retry + 1}/{MAX_TRANSIENT_RETRIES}, caller attempt {attempt})"
            )
            time.sleep(backoff)

        # Unreachable — loop always returns, but satisfy type checker.
        result.transient_retries = MAX_TRANSIENT_RETRIES
        return result


# ─── Sprint parsing & discovery ────────────────────────────────────────────

@dataclasses.dataclass
class Sprint:
    id: str            # "03"
    slug: str          # "expense-data-model"
    path: Path         # absolute
    title: str
    band: Optional[str]
    blocked_by: list[str]

    @classmethod
    def from_path(cls, p: Path) -> "Sprint":
        body = p.read_text()
        m = re.match(r"^(\d+)-(.+)\.md$", p.name)
        if not m:
            raise ValueError(f"Unexpected sprint filename: {p.name}")
        sprint_id, slug = m.group(1), m.group(2)

        h1 = re.search(r"^#\s+(?:Sprint\s+\d+\s*[:\-]\s*)?(.+)$", body, re.M)
        title = h1.group(1).strip() if h1 else slug

        band_m = re.search(r"\*\*Band\*\*:\s*([^·\n]+)", body)
        band = band_m.group(1).strip() if band_m else None

        blocked_m = re.search(r"\*\*Blocked by\*\*:\s*([^·\n]+)", body)
        blocked_by: list[str] = []
        if blocked_m:
            tok = blocked_m.group(1).strip().rstrip("·").strip()
            if tok and tok.lower() not in ("—", "nothing", "none", "-"):
                blocked_by = [t.strip() for t in re.split(r"[,\s]+", tok) if t.strip()]
        return cls(sprint_id, slug, p.resolve(), title, band, blocked_by)

    @property
    def specs_dir(self) -> Path:
        return SPECS_DIR / f"sprint-{self.id}-{self.slug}"

    @property
    def branch(self) -> str:
        return f"sprint/{self.id}-{self.slug}"

    @property
    def e2e_test_path(self) -> Path:
        return E2E_DIR / f"test_sprint_{self.id}_{self.slug.replace('-', '_')}.md"


def parse_sprint_selector(selector: str) -> list[str]:
    """'03' / '03-08' / '03,07,11' -> ['03', '04', ...]"""
    out: list[str] = []
    for token in selector.split(","):
        token = token.strip()
        if not token:
            continue
        if "-" in token and re.match(r"^\d+-\d+$", token):
            lo, hi = token.split("-")
            for i in range(int(lo), int(hi) + 1):
                out.append(f"{i:02d}")
        else:
            out.append(f"{int(token):02d}")
    return out


def parse_resume_from(value: str) -> "tuple[str, Optional[str], Optional[str]]":
    """Parse --resume-from RUN[:SPRINT[:STEP]] into (run_id, sprint_id, step)."""
    parts = value.split(":")
    if not 1 <= len(parts) <= 3:
        fail(f"--resume-from expects RUN[:SPRINT[:STEP]], got {value!r}")
    run_id = parts[0]
    sprint_id = f"{int(parts[1]):02d}" if len(parts) >= 2 else None
    step = parts[2] if len(parts) == 3 else None
    valid = {"branch", "research", "plan", "build", "test",
             "e2e", "review", "document", "publish"}
    if step and step not in valid:
        fail(f"--resume-from step must be one of {sorted(valid)}, got {step!r}")
    return run_id, sprint_id, step


def discover_sprints(selector: str) -> list[Sprint]:
    files = sorted(SPRINT_DIR.glob("*.md"))
    files = [f for f in files if not f.name.startswith("00-")]
    by_id: dict[str, Path] = {}
    for f in files:
        m = re.match(r"^(\d+)-", f.name)
        if m:
            by_id[m.group(1)] = f
    selected_ids = parse_sprint_selector(selector)
    out: list[Sprint] = []
    for sid in selected_ids:
        if sid not in by_id:
            fail(f"sprint {sid} not found in {SPRINT_DIR}")
        out.append(Sprint.from_path(by_id[sid]))
    return out


# ─── Filesystem snapshots ──────────────────────────────────────────────────

def snapshot(dirs: Iterable[Path], pattern: str = "**/*.md") -> set[Path]:
    out: set[Path] = set()
    for d in dirs:
        if d.exists():
            for p in d.glob(pattern):
                if p.is_file():
                    out.add(p.resolve())
    return out


def newly_created(before: set[Path], dirs: Iterable[Path], pattern: str = "**/*.md") -> list[Path]:
    after = snapshot(dirs, pattern)
    return sorted(after - before)


# ─── Git helpers ───────────────────────────────────────────────────────────

def git(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return run_cmd("git", *args, check=check)


def current_branch() -> str:
    return git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()


def head_sha() -> str:
    return git("rev-parse", "HEAD").stdout.strip()


def working_tree_clean(ignore: Optional[Path] = None) -> bool:
    lines = [l for l in git("status", "--porcelain").stdout.splitlines() if l.strip()]
    if ignore is not None:
        rel = str(ignore.resolve().relative_to(REPO_ROOT))
        lines = [l for l in lines if not l[3:].strip().startswith(rel)]
    return not lines


def branch_exists(name: str) -> bool:
    res = git("rev-parse", "--verify", "--quiet", name, check=False)
    return res.returncode == 0


def ensure_main_clean(ignore: Optional[Path] = None) -> None:
    if not working_tree_clean(ignore=ignore):
        fail("working tree is dirty — commit or stash before running the sprint runner")


def checkout_or_create_branch(branch: str) -> None:
    if current_branch() == branch:
        return
    if branch_exists(branch):
        log(f"  · checkout existing branch {branch}")
        git("checkout", branch)
    else:
        log(f"  · create branch {branch} from main")
        git("checkout", "main")
        git("pull", "--ff-only")
        git("checkout", "-b", branch)


# ─── Output parsing helpers ────────────────────────────────────────────────

def extract_marker_lines(text: str, marker: str) -> list[str]:
    """Return values for lines like 'MARKER: <value>'."""
    out: list[str] = []
    for line in text.splitlines():
        if line.strip().startswith(marker + ":"):
            out.append(line.split(":", 1)[1].strip().strip("`"))
    return out


def read_json_file(p: Path) -> Optional[dict]:
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


_SPEC_REF_RE = re.compile(r"\(spec\s+(\d+)\s*([a-z0-9\-]+)?\)", re.IGNORECASE)
_TEST_NAME_RE = re.compile(r"\b(test[A-Z]\w+)\b")


def compute_failure_fingerprint(result: dict) -> dict:
    """Return a stable fingerprint of a /test cycle's failure.

    Inputs: the dict parsed from test-result-attempt-N.json. Output keys:
      hash       — sha1 of normalized (test_name, assertion_core, spec_ref)
      test_name  — first XCTest method name found, or None
      spec_ref   — (ordinal, slug) tuple parsed from "(spec NN slug)", or None
      summary    — raw result["summary"], capped at 240 chars
    """
    summary = (result.get("summary") or "")[:240]
    errors = result.get("errors") or []
    blob = summary + " " + " ".join((e.get("message") or "") for e in errors)

    test_name = None
    m = _TEST_NAME_RE.search(blob)
    if m: test_name = m.group(1)

    spec_ref = None
    m = _SPEC_REF_RE.search(blob)
    if m: spec_ref = (m.group(1), (m.group(2) or "").lower())

    # Normalize: strip absolute paths, hex addrs, line numbers, timestamps
    norm = re.sub(r"/[\w./-]+", "", blob)
    norm = re.sub(r"\b0x[0-9a-f]+\b", "", norm)
    norm = re.sub(r":\d+", "", norm)
    norm = re.sub(r"\d{4}-\d{2}-\d{2}T[\d:.+-]+", "", norm)
    norm = re.sub(r"\s+", " ", norm).strip().lower()

    h = hashlib.sha1(norm.encode("utf-8")).hexdigest()[:16]
    return {
        "hash": h,
        "test_name": test_name,
        "spec_ref": spec_ref,
        "summary": summary,
    }


def is_stagnant(fingerprints: list, threshold: int = 2) -> bool:
    if len(fingerprints) < threshold: return False
    tail = [fp["hash"] for fp in fingerprints[-threshold:]]
    return len(set(tail)) == 1


# ─── Step executor ─────────────────────────────────────────────────────────

STEP_ORDER = ["branch", "research", "plan", "build", "test",
              "e2e", "review", "document", "publish"]


def reset_sprint_from(s: dict, step: str) -> None:
    """In-place: clear all state at or after `step` in sprint dict `s`."""
    idx = STEP_ORDER.index(step)
    downstream = set(STEP_ORDER[idx:])
    s["steps"] = [r for r in s.get("steps", []) if r["name"] not in downstream]
    s["status"] = "pending"
    s["completed_at"] = None
    if "plan" in downstream:
        s["specs"] = []
        s["e2e_test_path"] = None
    if "build" in downstream:
        for spec in s.get("specs", []):
            spec["build"] = {"status": "pending", "started_at": None,
                             "completed_at": None, "duration_seconds": None,
                             "cost_usd": 0.0, "attempts": 0,
                             "log_path": None, "error": None, "summary": None}
            spec["commit"] = {"status": "pending", "sha": None, "message": None,
                              "log_path": None, "error": None}
    if "test" in downstream:
        s["tests"] = None
    if "e2e" in downstream:
        s["e2e"] = None
    if "review" in downstream:
        s["review"] = None
    if "document" in downstream:
        for spec in s.get("specs", []):
            spec["documentation"] = None
        s["documentation"] = []
    if "publish" in downstream:
        s["pr"] = None


class SprintExecutor:
    def __init__(
        self,
        sprint: Sprint,
        run_state: State,
        run_log_dir: Path,
        dry_run: bool = False,
        force_step: Optional[str] = None,
        plan_model: str = PLAN_MODEL,
        execute_model: str = EXECUTE_MODEL,
        max_test_escalations: int = MAX_TEST_ESCALATIONS_PER_SPRINT,
        no_test_escalation: bool = False,
    ):
        self.sprint = sprint
        self.state = run_state
        self.dry_run = dry_run
        self.force_step = force_step
        self.plan_model = plan_model
        self.execute_model = execute_model
        self.max_test_escalations = max_test_escalations
        self.no_test_escalation = no_test_escalation
        self.run_dir = run_log_dir
        self.log_dir = run_log_dir / sprint.id
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.claude = ClaudeRunner(self.log_dir, dry_run=dry_run)
        self.s = self.state.init_sprint(
            sprint.id,
            {
                "sprint_id": sprint.id,
                "slug": sprint.slug,
                "title": sprint.title,
                "sprint_file": str(sprint.path.relative_to(REPO_ROOT)),
                "branch": sprint.branch,
                "status": "pending",
                "started_at": None,
                "completed_at": None,
                "duration_seconds": None,
                "step_executions": {},
                "steps": [],
                "specs": [],
                "research_doc": None,
                "e2e_test_path": None,
                "tests": None,
                "e2e": None,
                "review": None,
                "documentation": [],
                "pr": None,
                "errors": [],
                "test_failure_fingerprints": [],
                "test_escalations": [],
            },
        )

    # ── housekeeping ────────────────────────────────────────────────────

    def _begin_step(self, name: str) -> dict:
        rec = next((s for s in self.s["steps"] if s["name"] == name), None)
        if rec is None:
            rec = {
                "name": name,
                "status": "pending",
                "started_at": None,
                "completed_at": None,
                "duration_seconds": None,
                "attempts": 0,
                "exit_code": None,
                "cost_usd": 0.0,
                "log_path": None,
                "error": None,
            }
            self.s["steps"].append(rec)
        rec["status"] = "in_progress"
        rec["started_at"] = rec["started_at"] or now_iso()
        rec["attempts"] += 1
        self.s["step_executions"][name] = self.s["step_executions"].get(name, 0) + 1
        self.state.save()
        return rec

    def _end_step(self, rec: dict, success: bool, *, error: Optional[str] = None,
                  cr: Optional[ClaudeResult] = None, log_path: Optional[Path] = None) -> None:
        rec["status"] = "completed" if success else "failed"
        rec["completed_at"] = now_iso()
        if rec["started_at"]:
            try:
                t0 = dt.datetime.fromisoformat(rec["started_at"])
                t1 = dt.datetime.fromisoformat(rec["completed_at"])
                rec["duration_seconds"] = (t1 - t0).total_seconds()
            except Exception:
                pass
        if cr is not None:
            rec["exit_code"] = cr.exit_code
            rec["cost_usd"] = round(rec.get("cost_usd", 0.0) + cr.cost_usd, 4)
            rec["log_path"] = str(cr.log_path.relative_to(REPO_ROOT))
            rec["transient_retries"] = cr.transient_retries
        elif log_path is not None:
            rec["log_path"] = str(log_path.relative_to(REPO_ROOT))
        rec["error"] = error
        self.state.save()

    def _step_completed(self, name: str) -> bool:
        if self.force_step == name:
            return False
        rec = next((s for s in self.s["steps"] if s["name"] == name), None)
        return bool(rec and rec["status"] == "completed")

    # ── 0. branch ───────────────────────────────────────────────────────

    def step_branch(self) -> None:
        if self._step_completed("branch") and current_branch() == self.sprint.branch:
            log("  ✓ branch (already on it)")
            return
        rec = self._begin_step("branch")
        if self.dry_run:
            log(f"  ✓ branch ({self.sprint.branch}) [dry-run]")
            self._end_step(rec, success=True)
            return
        try:
            ensure_main_clean(ignore=self.run_dir)
            checkout_or_create_branch(self.sprint.branch)
            self._end_step(rec, success=True)
            log(f"  ✓ branch ({self.sprint.branch})")
        except subprocess.CalledProcessError as e:
            self._end_step(rec, success=False, error=f"git: {e.stderr or e}")
            raise

    # ── 1. research ─────────────────────────────────────────────────────

    def step_research(self) -> None:
        if self._step_completed("research") and self.s.get("research_doc"):
            log(f"  ✓ research (cached: {self.s['research_doc']})")
            return
        rec = self._begin_step("research")
        before = snapshot([RESEARCH_DIR])
        prompt = self._prompt_research()
        cr = self.claude.run(prompt, "research", max_turns=DEFAULT_MAX_TURNS,
                             attempt=rec["attempts"], model=self.plan_model)

        # Detect the research doc: prefer marker, fall back to mtime diff.
        marker = extract_marker_lines(cr.last_assistant_text, "RESEARCH_PATH")
        candidates = [Path(m) for m in marker if Path(m).exists()]
        if not candidates:
            candidates = newly_created(before, [RESEARCH_DIR])
        success = bool(candidates) and cr.succeeded
        if success:
            doc = candidates[0]
            self.s["research_doc"] = str(doc.relative_to(REPO_ROOT))
            self.state.save()
            log(f"  ✓ research → {self.s['research_doc']}")
        else:
            err = cr.error or "no research doc detected"
            self.s["errors"].append({"step": "research", "error": err})
            log(f"  ✗ research failed: {err}")
        self._end_step(rec, success=success, error=None if success else (cr.error or "no research doc"), cr=cr)
        if not success:
            raise StepFailed("research", cr.error or "no research doc produced")

    def _prompt_research(self) -> str:
        return textwrap.dedent(f"""\
            /research-codebase

            Read the sprint document at `{self.sprint.path}` and produce a research document for it.

            ENFORCEMENT — sub-agent delegation is NOT optional:
              Your FIRST real action (after reading the sprint file named above)
              MUST be a single message that invokes the Task tool at least TWICE
              in parallel:
                • subagent_type="codebase-locator"   — find WHERE relevant files live
                • subagent_type="codebase-analyzer"  — document HOW the current code works
              Add a third parallel Task with subagent_type="codebase-pattern-finder"
              whenever existing patterns/conventions are in scope (usually yes).

              Do NOT call Read, Grep, Glob, or Bash on source files in the main
              context to answer the research question. The only files you read
              yourself are the sprint file above, README.md, and
              .claude/commands/conditional-docs.md. Everything else goes through
              the sub-agents.

              If you synthesize without having called Task, the run is invalid.
              Prior sprint runs skipped this step and produced research that
              missed architectural context — do not repeat that mistake.

            CRITICAL — your research document MUST conclude with a section titled
            `## Recommended Specs` that decomposes this sprint into the smallest
            independently-buildable specs. For each recommended spec, include:
              - A short kebab-case name (e.g. `expense-model`, `expense-form-view`)
              - One-paragraph scope
              - Dependencies on prior specs in the sprint
              - The minimum acceptance bar (what does "done" look like?)

            SPEC SIZE BUDGET — each recommended spec must be small enough that a
            200K-context model can execute it: the spec itself plus any files the
            builder needs to open must fit well under 200K tokens. Guidelines:
              - If a single spec would require the builder to load more than ~5–8
                `.mjs` source files plus their tests, decompose it further.
              - Prefer more, smaller specs (3–6 phases, one module per spec) over
                fewer large ones.
              - Target ≤ 250 lines per produced spec file (sprint-10 specs are a
                good reference).
              - Note: --opus-only mode relaxes this constraint, but you cannot know
                which flag the runner will use — always optimise for the Sonnet
                200K case so the specs are universally executable.

            Specs in this sprint will be built sequentially in the order you list them.

            Write the research document to:
              `research/{dt.date.today().isoformat()}-sprint-{self.sprint.id}-{self.sprint.slug}.md`

            On the FINAL line of your final message, output exactly:
              RESEARCH_PATH: <absolute path to the research doc you created>
            """)

    # ── 2. plan ─────────────────────────────────────────────────────────

    def step_plan(self) -> None:
        if self._step_completed("plan") and self.s.get("specs"):
            log(f"  ✓ plan (cached: {len(self.s['specs'])} specs)")
            return
        rec = self._begin_step("plan")
        before_specs = snapshot([self.sprint.specs_dir])
        before_e2e = snapshot([E2E_DIR])
        prompt = self._prompt_plan()
        cr = self.claude.run(prompt, "plan", max_turns=DEFAULT_MAX_TURNS,
                             attempt=rec["attempts"], model=self.plan_model)

        spec_paths = [Path(p) for p in extract_marker_lines(cr.last_assistant_text, "SPEC_PATH")]
        spec_paths = [p for p in spec_paths if p.exists()]
        if not spec_paths:
            spec_paths = newly_created(before_specs, [self.sprint.specs_dir])

        e2e_marker = extract_marker_lines(cr.last_assistant_text, "E2E_PATH")
        e2e_path: Optional[Path] = None
        if e2e_marker:
            cand = Path(e2e_marker[0])
            if cand.exists():
                e2e_path = cand
        if e2e_path is None:
            new_e2e = newly_created(before_e2e, [E2E_DIR])
            e2e_path = new_e2e[0] if new_e2e else None

        success = bool(spec_paths) and cr.succeeded
        if success:
            self.s["specs"] = [
                {
                    "id": f"sprint-{self.sprint.id}-{i+1:02d}",
                    "path": str(p.relative_to(REPO_ROOT)),
                    "title": _spec_title(p),
                    "build": {"status": "pending", "started_at": None, "completed_at": None,
                              "duration_seconds": None, "cost_usd": 0.0, "attempts": 0,
                              "log_path": None, "error": None, "summary": None},
                    "commit": {"status": "pending", "sha": None, "message": None,
                               "log_path": None, "error": None},
                    "documentation": None,
                }
                for i, p in enumerate(sorted(spec_paths))
            ]
            self.s["e2e_test_path"] = str(e2e_path.relative_to(REPO_ROOT)) if e2e_path else None
            self.state.save()
            log(f"  ✓ plan → {len(spec_paths)} specs, e2e={self.s['e2e_test_path']}")
        else:
            err = cr.error or "no specs produced"
            self.s["errors"].append({"step": "plan", "error": err})
            log(f"  ✗ plan failed: {err}")
        self._end_step(rec, success=success, error=None if success else (cr.error or "no specs"), cr=cr)
        if not success:
            raise StepFailed("plan", cr.error or "no specs produced")

    def _prompt_plan(self) -> str:
        research_path = REPO_ROOT / self.s["research_doc"]
        return textwrap.dedent(f"""\
            /feature sprint-{self.sprint.id} {research_path}

            Use the research document at `{research_path}` as the source of truth.

            CRITICAL INSTRUCTIONS:

            1. Read the research document FULLY. Pay close attention to the
               `## Recommended Specs` section — it is your authoritative
               decomposition.

            2. Produce ONE spec file per recommended spec. Place all specs in:
                 `specs/sprint-{self.sprint.id}-{self.sprint.slug}/`
               File naming: `spec-NN-<descriptive-kebab>.md` (NN = 01, 02, ...
               in build order).

            3. Each spec MUST follow the standard Plan Format from
               `.claude/commands/feature.md`. No `<placeholder>` left
               unfilled. Validation Commands must be the **Sentinel** stack
               commands: `make validate`, `node --test tests/`, and
               `node src/sentinel/hook.mjs --self-test`. Do NOT emit
               xcodebuild / pytest / uv / pnpm / tsc commands — this is a
               Node ≥ 20.10 ESM project with zero runtime dependencies.

               INLINE CODE REQUIREMENT — under each `### Changes Required`
               section, include enough concrete code (signatures, struct
               definitions, switch arms, migration bodies) that the executor
               does not need to open unrelated files to figure out the shape.
               Treat the spec as the builder's working memory. `file:line`
               pointers are still required for the anchor points — where the
               new code attaches to existing code — but do not rely on the
               builder reading adjacent files to infer intent. Point at
               specific locations; inline the shape of the change.

            4. CONTEXT MANAGEMENT — MANDATORY, non-negotiable:

               a. DO NOT use the Read tool on source files (`src/sentinel/`,
                  `tests/`, `hooks/`, `agents/`, `commands/`).
                  All source file analysis MUST be delegated to subagents
                  (codebase-locator, codebase-analyzer, codebase-pattern-finder).
                  Reading source files inline will exhaust your context before
                  all specs are written.

               b. DO NOT use the Write tool to write spec files inline.
                  For each spec, spawn a `builder` subagent passing it the
                  spec brief and the research doc path. The subagent reads
                  source files and writes the spec in its own isolated context.
                  Collect only the returned file path — never the content.

               c. Spawn ALL spec-writer subagents in ONE parallel batch after
                  research completes. Your context at the end should contain
                  only: the research doc, subagent summaries, and the final
                  SPEC_PATH/E2E_PATH markers.

            5. In addition, create EXACTLY ONE sprint-level E2E test at:
                 `.claude/commands/e2e/test_sprint_{self.sprint.id}_{self.sprint.slug.replace('-', '_')}.md`
               This single E2E must exercise every user-visible change
               introduced by the sprint as a whole. Sentinel has no web
               UI, so a sprint-level E2E for this project is typically a
               scripted Claude Code session that drives the plugin through
               representative scenarios (e.g. attempt `cat .env` → assert
               `deny` decision; attempt install of a non-existent package
               → assert `deny`; verify the audit log entries via
               `/sentinel-review recent`). If the sprint adds no
               user-visible behaviour (pure scaffolding / library work),
               you MAY skip the E2E and instead emit a single line
               `E2E_PATH: SKIP` on the final message.

            6. On the FINAL message, output the absolute paths in build order,
               one per line:
                 SPEC_PATH: /absolute/path/to/spec-01-...md
                 SPEC_PATH: /absolute/path/to/spec-02-...md
                 ...
                 E2E_PATH: /absolute/path/to/.claude/commands/e2e/test_sprint_{self.sprint.id}_*.md
            """)

    # ── 3. build (per spec, with /commit per spec) ──────────────────────

    def step_build(self) -> None:
        for i, spec in enumerate(self.s["specs"]):
            self._build_one(i, spec)

    def _build_one(self, i: int, spec: dict) -> None:
        spec_path = REPO_ROOT / spec["path"]
        step_name = f"build:{spec['id']}"

        if spec["build"]["status"] == "completed" and spec["commit"]["status"] == "completed" \
                and self.force_step != "build":
            log(f"  ✓ build [{i+1}/{len(self.s['specs'])}] {spec['id']} (cached)")
            return

        # ── implement ──
        if spec["build"]["status"] != "completed" or self.force_step == "build":
            spec["build"]["attempts"] += 1
            spec["build"]["status"] = "in_progress"
            spec["build"]["started_at"] = spec["build"]["started_at"] or now_iso()
            self.s["step_executions"]["build"] = self.s["step_executions"].get("build", 0) + 1
            self.state.save()

            log(f"  · build [{i+1}/{len(self.s['specs'])}] {spec['id']}: {spec['title']}")
            prompt = textwrap.dedent(f"""\
                /implement {spec_path}

                Implement the spec phase by phase, exactly as written.
                Validate each Phase's Success Criteria by reading the
                working tree only — file presence, symbol/type
                signatures, scope adherence. Do NOT run `make validate`,
                `make test`, `node --test`, `node src/sentinel/hook.mjs
                --self-test`, or any compile/test command at any point
                during this build step. Direct Bash invocations of
                these commands are forbidden — the runner's separate
                test phase (step_test) owns validation.
                You also MUST NOT run `npm install`: Sentinel has zero
                runtime dependencies and a vendor-only policy for
                utilities (see the spec's Notes).

                REINFORCEMENT — this is not optional: spawn exactly ONE
                `builder` subagent per numbered Phase in the spec. The
                main session coordinates and validates Success Criteria
                structurally (read the working tree); the subagent
                writes the code. Do NOT call Edit, Write, or
                multi-file Read inline in the main session — if you
                catch yourself doing that, stop and delegate. The
                implement.md command details this pattern; follow it.
                Past sprint runs failed this instruction and
                implemented inline, which worked on Opus 1M but will
                blow context on Sonnet 200K.

                BUILDER OVERRIDE — when you spawn each `builder`
                subagent, prepend exactly this block to its task
                prompt:

                  "OVERRIDE for sprint-pipeline use: skip your Step 4
                  Verify Work runs entirely. Do not run `make validate`,
                  `make test`, `node --test`, `node src/sentinel/hook.mjs
                  --self-test`, or any equivalent command. Do not run
                  `npm install`. Report the file changes only. The runner
                  gates validation in a downstream phase (step_test);
                  your verification would be wasted duplicate work."

                This override is mandatory for every builder spawn in
                this build step. Without it, the builder's intrinsic
                Step 4 will run `make validate` (which runs `node --test`
                and the hook self-test) and undo the savings this prompt
                is designed to deliver.

                Do NOT touch git; do NOT commit. Do NOT run /test at
                the end — the runner handles validation in a separate
                step. The runner will handle commits via the /commit
                slash command after this step succeeds.

                On the FINAL line of your final message, output exactly ONE line:
                  BUILD_SUMMARY: <one or two sentences describing what the code
                  change actually does — not what the spec said, but what you
                  implemented>

                This summary is fed directly into the commit-message generator;
                write it like the first line of a good commit message.
                """)
            cr = self.claude.run(prompt, step_name, max_turns=BUILD_MAX_TURNS,
                                 attempt=spec["build"]["attempts"], model=self.execute_model,
                                 idle_timeout_seconds=IDLE_TIMEOUT_BUILD_S)
            spec["build"]["completed_at"] = now_iso()
            spec["build"]["duration_seconds"] = (
                dt.datetime.fromisoformat(spec["build"]["completed_at"])
                - dt.datetime.fromisoformat(spec["build"]["started_at"])
            ).total_seconds()
            spec["build"]["cost_usd"] = round(spec["build"].get("cost_usd", 0.0) + cr.cost_usd, 4)
            spec["build"]["log_path"] = str(cr.log_path.relative_to(REPO_ROOT))
            spec["build"]["status"] = "completed" if cr.succeeded else "failed"
            spec["build"]["error"] = cr.error
            summaries = extract_marker_lines(cr.last_assistant_text, "BUILD_SUMMARY")
            spec["build"]["summary"] = summaries[-1] if summaries else None
            self.state.save()
            if not cr.succeeded:
                raise StepFailed("build", f"{spec['id']}: {cr.error}")

        # Verify there is something to commit (build may be a no-op on resume).
        if working_tree_clean():
            log(f"    · build produced no diff for {spec['id']} — skipping commit")
            spec["commit"]["status"] = "completed"
            spec["commit"]["sha"] = head_sha()
            spec["commit"]["message"] = "(no changes)"
            self.state.save()
            return

        # ── commit via /commit slash command ──
        head_before = head_sha()
        commit_step = f"commit:{spec['id']}"
        log(f"    · /commit {spec['id']}")
        summary = spec.get("build", {}).get("summary") or "(no summary provided by builder)"
        status_out = git("status", "--porcelain").stdout.strip() or "(empty)"
        diff_stat = git("diff", "--stat", "HEAD").stdout.strip() or "(empty)"
        prompt = textwrap.dedent(f"""\
            /commit pipeline feat

            Follow /commit exactly as documented. The enumeration step is
            MANDATORY — every path in the pre-commit snapshot below must
            appear as either `include:` or `exclude:`. The default is
            `include:`; only exclude with a concrete reason (scratch file,
            stale unrelated edit, secret). "Not named in the spec" is NOT
            a valid exclusion reason.

            Context for this commit:

              • Spec ID: {spec['id']}
              • Spec file: {spec['path']}
              • Builder summary (what the build phase says it did):
                  {summary}

            Pre-commit snapshot (authoritative — do not re-derive, work
            from this list):

            git status --porcelain:
            {status_out}

            git diff --stat HEAD:
            {diff_stat}

            The commit message MUST describe the actual code change — read
            `git diff --cached` after staging and summarize the real diff.
            Do NOT copy the spec title into the message; that produces
            misleading history like "add X spec" when the real change is
            a source-file edit.

            After committing, push to origin.
            """)
        cr = self.claude.run(prompt, commit_step, max_turns=DEFAULT_MAX_TURNS,
                             model=self.execute_model)
        self.s["step_executions"]["commit"] = self.s["step_executions"].get("commit", 0) + 1
        new_sha = head_sha()
        if not cr.succeeded or new_sha == head_before:
            spec["commit"]["status"] = "failed"
            spec["commit"]["error"] = cr.error or "no new commit detected"
            spec["commit"]["log_path"] = str(cr.log_path.relative_to(REPO_ROOT))
            self.state.save()
            raise StepFailed("commit", f"{spec['id']}: {spec['commit']['error']}")

        msg = git("log", "-1", "--format=%s", new_sha).stdout.strip()
        spec["commit"]["status"] = "completed"
        spec["commit"]["sha"] = new_sha
        spec["commit"]["message"] = msg
        spec["commit"]["log_path"] = str(cr.log_path.relative_to(REPO_ROOT))
        self.state.save()
        log(f"    ✓ {new_sha[:7]} {msg}")

    # ── 4. test (with patch loop) ───────────────────────────────────────

    def step_test(self) -> None:
        if self._step_completed("test"):
            log("  ✓ test (cached)")
            return
        max_cycles = TEST_PATCH_MAX_CYCLES
        for cycle in range(1, max_cycles + 1):
            rec = self._begin_step("test")
            result_path = self.log_dir / f"test-result-attempt-{cycle}.json"
            prompt = textwrap.dedent(f"""\
                /test

                Run the Sentinel validation sequence:
                  1. `node --version` (must be ≥ 20.10; fail fast if lower)
                  2. `make validate` — runs, in order:
                       a. Manifest JSON parse: `node -e 'JSON.parse(...)'`
                          on `.claude-plugin/plugin.json`
                       b. Hook config JSON parse on `hooks/sentinel.json`
                       c. Hook self-test: `node src/sentinel/hook.mjs
                          --self-test` (replays every fixture in
                          `tests/fixtures/` and asserts expected decision)
                       d. Unit tests: `node --test tests/` (TAP output)
                If `make validate` is not yet wired (early sprints), run
                each step individually using the commands above.
                There is no compile step — `.mjs` runs directly. `npm install`
                is FORBIDDEN: Sentinel has zero runtime dependencies.

                After completion, write a JSON result to:
                  {result_path}
                with this exact shape:
                  {{
                    "build_succeeded": <bool, true iff all four `make validate`
                                       steps exit 0 — for Sentinel, "build"
                                       means JSON parses + self-test pass>,
                    "tests_passed": <bool, true iff `node --test` reports
                                    `# fail 0`>,
                    "tests_executed": <int, total tests run>,
                    "errors_count": <int, sum of failed tests + JSON parse
                                    errors + failed fixtures>,
                    "warnings_count": <int>,
                    "errors": [{{"file": "...", "line": <int>, "message": "..."}}],
                    "summary": "<one-line summary>"
                  }}
                Do NOT modify any source files — only run validate and report.

                Follow the "Long-running shell commands" section of
                `CLAUDE.md` for any command that may exceed 600 s. The
                harness blocks `tail -f`/`watch` at the tool boundary; do
                not attempt to circumvent it.
                """)
            cr = self.claude.run(prompt, "test", max_turns=DEFAULT_MAX_TURNS,
                                 attempt=rec["attempts"], model=self.execute_model,
                                 idle_timeout_seconds=IDLE_TIMEOUT_TEST_S)
            result = read_json_file(result_path) or {}
            passed = (
                bool(result.get("build_succeeded"))
                and bool(result.get("tests_passed", True))
                and cr.succeeded
            )
            self.s["tests"] = result | {"patch_cycles": cycle - 1}
            self.state.save()

            if passed:
                self._end_step(rec, success=True, cr=cr)
                log(f"  ✓ test (cycle {cycle}, build succeeded)")
                return

            err_summary = result.get("summary") or cr.error or "test failed"
            self._end_step(rec, success=False, cr=cr, error=err_summary)
            log(f"  ✗ test failed (cycle {cycle}): {err_summary}")

            if cycle >= max_cycles:
                self.s["errors"].append({
                    "step": "test",
                    "error": "exhausted patch cycles",
                    "last_result": result,
                })
                self.state.save()
                report_path = self._write_test_halt_report(result)
                raise StepFailed(
                    "test",
                    f"Sentinel validation did not succeed after {cycle} cycles",
                )

            # Spawn a focused patch and commit it; next cycle re-runs /test.
            self._test_patch(cycle, result)

    def _test_patch(self, cycle: int, result: dict) -> None:
        fp = compute_failure_fingerprint(result)
        fps = self.s.setdefault("test_failure_fingerprints", [])
        fps.append({"cycle": cycle, **fp})
        self.state.save()

        escalations_used = len(self.s.get("test_escalations", []))
        can_escalate = (
            not self.no_test_escalation
            and escalations_used < self.max_test_escalations
            and is_stagnant(fps, STAGNATION_THRESHOLD)
        )
        if can_escalate:
            log(f"      🔁 stagnation: cycles {cycle-1},{cycle} share fp={fp['hash']} — escalating")
            self._test_bugfix(cycle, result, fp)
            return    # bugfix replaces this cycle's patch; outer loop re-runs /test

        rec = self._begin_step("test_patch")
        PATCH_SPECS_DIR.mkdir(parents=True, exist_ok=True)

        errors_json = json.dumps(result.get("errors", []), indent=2)
        summary = result.get("summary", "") or ""
        spec_paths_str = "\n".join(f"  - {s['path']}" for s in self.s["specs"])

        # Cycle ≥ 2 — point Claude at the prior patch so it doesn't re-propose
        # the same fix. Without this, identical failures tend to produce
        # identical patches.
        prior_note = ""
        if cycle > 1:
            prior_patch = PATCH_SPECS_DIR / f"patch-sprint-{self.sprint.id}-test-{cycle-1}.md"
            if prior_patch.exists():
                prior_note = textwrap.dedent(f"""\

                    PRIOR CYCLE CONTEXT — on cycle {cycle-1} this patch was
                    applied and committed:
                      {prior_patch.relative_to(REPO_ROOT)}
                    /test still fails. Read that patch file first; your new
                    patch MUST differ — different root cause, different
                    files, or a different fix. Repeating the prior approach
                    will not help.
                    """)

        # Heuristic: stale on-disk state in the per-plugin data dir (the
        # registry-check LRU cache or the audit log) can cause repeated test
        # failures that aren't real code bugs. Hint Claude to verify with a
        # clear before producing a patch.
        sim_hint = ""
        combined = (summary + " " + " ".join(
            (e.get("message") or "") for e in (result.get("errors") or [])
        )).lower()
        if re.search(
            r"cache\.json|audit\.jsonl|stale cache|cache hit returns|"
            r"unexpected cache entry|prior run|leftover fixture",
            combined,
        ):
            sim_hint = textwrap.dedent("""\

                STALE-STATE HINT — this failure signature can come from a
                stale on-disk file in the per-plugin data dir (registry
                cache `cache.json` or audit log `audit.jsonl`) left over
                from a prior test run, not a real code bug. Before writing
                a code patch, verify by clearing the dir used by the tests
                (typically `${CLAUDE_PLUGIN_DATA}` or a tmpdir override)
                and re-running `make validate`. If the failure does NOT
                reproduce after the clear, the real fix is to make the
                affected test hermetic (unique tmp path per test) — note
                this in the patch plan and make zero code changes; the
                runner will re-run /test and pass.
                """)

        prompt = textwrap.dedent(f"""\
            The Sentinel test/validate run failed on cycle {cycle}.

            Summary: {summary}

            Errors (from test-result.json, same schema as /test emits):
            {errors_json}
            {prior_note}{sim_hint}
            Use `/patch sprint-{self.sprint.id}-test-{cycle}` to create a
            focused patch plan that addresses ONLY the failures above
            (no scope creep). Then implement the patch following its phases.

            SUBAGENT DELEGATION IS NOT OPTIONAL — spawn exactly ONE `builder`
            subagent per Implementation Step in the patch plan. Pass the step
            text, the Validation commands, and any `file:line` anchors. The
            main session coordinates; it does NOT call Edit, Write, or
            multi-file Read inline. This session runs on Sonnet 200K — doing
            the work inline will exhaust context.

            Sprint context (specs already built this sprint):
            {spec_paths_str}

            Guardrails:
              • Fix code under `src/sentinel/`, `hooks/`, `tests/`,
                `agents/`, or `commands/`. Do NOT mutate spec files under
                `specs/`. Do NOT `npm install` — vendor any new utility as
                a small pure-function module in `src/sentinel/lib/`.
              • After implementing the patch, do NOT commit — the runner
                will /commit before re-running /test.

            Save the patch plan under:
              specs/patch/patch-sprint-{self.sprint.id}-test-{cycle}.md
            """)
        cr = self.claude.run(prompt, f"test-patch-{cycle}",
                             max_turns=BUILD_MAX_TURNS,
                             attempt=rec["attempts"], model=self.execute_model)
        self.s["step_executions"]["test_patch"] = (
            self.s["step_executions"].get("test_patch", 0) + 1
        )

        # Commit any patch diff so the fix survives a --resume even if the
        # next /test cycle itself crashes mid-run.
        if not working_tree_clean():
            commit_prompt = textwrap.dedent(f"""\
                /commit pipeline chore test patch cycle {cycle} for sprint {self.sprint.id}

                Use /commit to create one local commit only — do not push.
                """)
            self.claude.run(commit_prompt, f"test-patch-{cycle}-commit",
                            max_turns=DEFAULT_MAX_TURNS, model=self.execute_model)
            self.s["step_executions"]["commit"] = (
                self.s["step_executions"].get("commit", 0) + 1
            )

        self._end_step(rec, success=cr.succeeded, cr=cr,
                       error=None if cr.succeeded else cr.error)
        if not cr.succeeded:
            raise StepFailed("test_patch", cr.error or "patch attempt failed")

    def _test_bugfix(self, cycle: int, result: dict, fp: dict) -> None:
        spec_paths_str = "\n".join(f"  - {s['path']}" for s in self.s["specs"])

        plan_prompt = textwrap.dedent(f"""\
            /bug sprint-{self.sprint.id}-test-{cycle}-bugfix

            The /test phase has failed {cycle} times with the SAME failure
            fingerprint across the last {STAGNATION_THRESHOLD} cycles. Standard
            patch attempts are not converging — root cause is deeper than a
            small edit can fix.

            Failing test fingerprint:
              hash:      {fp['hash']}
              test:      {fp['test_name']}
              spec_ref:  {fp['spec_ref']}
              summary:   {fp['summary']}

            Full per-cycle failure history:
            {json.dumps(self.s['test_failure_fingerprints'], indent=2)}

            Latest /test result JSON (errors array):
            {json.dumps(result.get('errors', []), indent=2)}

            Sprint specs (the build phase already ran on these):
            {spec_paths_str}

            YOUR TASK — produce a focused bug-fix plan. The plan MUST classify
            the root cause as exactly ONE of:
              • spec_gap   — a spec was not implemented (or only partially);
                             fix by COMPLETING the missing implementation
              • test_bug   — the test itself is wrong (bad fixture, race,
                             un-stubbed `globalThis.fetch`, missing `await`);
                             fix by AMENDING the test
              • impl_bug   — code was built but has a defect; fix the code
            On the FINAL line of your final message, output exactly:
              CLASSIFICATION: <spec_gap|test_bug|impl_bug>

            Save the plan to:
              specs/patch/bugfix-sprint-{self.sprint.id}-test-{cycle}.md

            Use /bug's parallel research pattern. Read the spec doc that
            matches spec_ref above (if present) before classifying. Do NOT
            write code in this step — only the plan.
            """)
        plan_cr = self.claude.run(plan_prompt, f"test-bugfix-{cycle}-plan",
                                  max_turns=BUGFIX_PLAN_MAX_TURNS, model=self.plan_model)

        impl_prompt = textwrap.dedent(f"""\
            /implement specs/patch/bugfix-sprint-{self.sprint.id}-test-{cycle}.md

            Implement the bugfix plan exactly. Use builder subagents per
            Implementation Step (same delegation pattern as test-patch). Do
            NOT commit — the runner handles commit after this step.
            """)
        impl_cr = self.claude.run(impl_prompt, f"test-bugfix-{cycle}-implement",
                                  max_turns=BUGFIX_IMPLEMENT_MAX_TURNS, model=self.execute_model)

        commit_cr = self.claude.run(textwrap.dedent(f"""\
            /commit pipeline chore test bugfix cycle {cycle} for sprint {self.sprint.id}
            Use /commit to create one local commit only — do not push.
            """), f"test-bugfix-{cycle}-commit", max_turns=DEFAULT_MAX_TURNS, model=self.execute_model)

        all_three_succeeded = plan_cr.succeeded and impl_cr.succeeded and commit_cr.succeeded
        classification = (extract_marker_lines(plan_cr.last_assistant_text, "CLASSIFICATION") or [None])[-1]
        self.s["test_escalations"].append({
            "after_cycle": cycle,
            "plan_path": f"specs/patch/bugfix-sprint-{self.sprint.id}-test-{cycle}.md",
            "classification": classification,
            "success": all_three_succeeded,
            "cost_usd": round(plan_cr.cost_usd + impl_cr.cost_usd + commit_cr.cost_usd, 4),
        })
        self.state.save()

    def _write_test_halt_report(self, final_result: dict) -> Path:
        report_path = self.log_dir / "test-halt-report.md"
        fps = self.s.get("test_failure_fingerprints", [])
        escs = self.s.get("test_escalations", [])
        final_fp = fps[-1] if fps else None
        lines = [
            f"# Test halt report — sprint {self.sprint.id}",
            f"Run: {self.run_dir.name}  •  cycles run: {len(fps)}  •  escalations: {len(escs)}",
            "",
            "## Final fingerprint",
            f"- hash: `{final_fp['hash']}`" if final_fp else "- (no fingerprint captured)",
            f"- test: `{final_fp['test_name']}`" if final_fp and final_fp.get('test_name') else "",
            f"- spec_ref: `{final_fp['spec_ref']}`" if final_fp and final_fp.get('spec_ref') else "",
            f"- summary: {final_fp['summary']}" if final_fp else "",
            "",
            "## Cycle history",
            *[f"- cycle {fp['cycle']}: hash `{fp['hash']}` — {fp['summary']}" for fp in fps],
            "",
            "## Escalation outcomes",
            *[f"- after cycle {e['after_cycle']}: classification={e.get('classification')!r}, success={e['success']}, plan={e['plan_path']}" for e in escs],
            "",
            "## Suggested next steps",
            "- Read the latest patch/bugfix plan(s) under `specs/patch/`",
            "- Re-read the spec doc matching the spec_ref above; verify it was actually built",
            "- If the test repeatedly fails on the same assertion, run that single test directly: `node --test tests/path/to/file.test.mjs` (or use `--test-name-pattern='<name>'` to filter)",
        ]
        report_path.write_text("\n".join(l for l in lines if l is not None))
        return report_path

    # ── 5. e2e (with patch loop) ────────────────────────────────────────

    def step_e2e(self) -> None:
        if self._step_completed("e2e"):
            log("  ✓ e2e (cached)")
            return
        e2e_path = self.s.get("e2e_test_path")
        if not e2e_path:
            log("  ⚠ e2e: no sprint-level test was created — skipping")
            rec = self._begin_step("e2e")
            self.s["e2e"] = {"skipped": True, "reason": "no test produced by planner"}
            self._end_step(rec, success=True)
            return

        max_cycles = E2E_PATCH_MAX_CYCLES
        for cycle in range(1, max_cycles + 1):
            rec = self._begin_step("e2e")
            result_path = self.log_dir / f"e2e-result-attempt-{cycle}.json"
            prompt = textwrap.dedent(f"""\
                Read `.claude/commands/test_e2e.md` and execute the sprint-level
                E2E test at `{REPO_ROOT / e2e_path}` against the running app.

                Capture every step's outcome. Take screenshots at the critical
                points and store paths in the result. After completion, write a
                JSON result to:
                  {result_path}
                with this exact shape:
                  {{
                    "passed": <bool>,
                    "failed_steps": [{{"step": "...", "error": "...",
                                      "screenshot": "<abs path or null>"}}],
                    "screenshots": ["<abs path>", ...],
                    "summary": "<one-line summary>"
                  }}
                """)
            cr = self.claude.run(prompt, "e2e", max_turns=E2E_MAX_TURNS,
                                 attempt=rec["attempts"], model=self.execute_model,
                                 idle_timeout_seconds=IDLE_TIMEOUT_E2E_S)
            result = read_json_file(result_path) or {}
            passed = bool(result.get("passed")) and cr.succeeded

            self.s["e2e"] = result | {"patch_cycles": cycle - 1}
            self.state.save()

            if passed:
                self._end_step(rec, success=True, cr=cr)
                log(f"  ✓ e2e (cycle {cycle})")
                return

            self._end_step(rec, success=False, cr=cr,
                           error=result.get("summary") or "e2e failed")

            if cycle >= max_cycles:
                self.s["errors"].append({
                    "step": "e2e", "error": "exhausted patch cycles",
                    "last_result": result,
                })
                self.state.save()
                raise StepFailed("e2e", f"failed after {cycle} cycles")

            # Spawn patch builder.
            self._e2e_patch(cycle, result)

    def _e2e_patch(self, cycle: int, result: dict) -> None:
        rec = self._begin_step("e2e_patch")
        PATCH_SPECS_DIR.mkdir(parents=True, exist_ok=True)
        spec_paths_str = "\n".join(f"  - {s['path']}" for s in self.s["specs"])
        prompt = textwrap.dedent(f"""\
            The sprint-level E2E test failed on cycle {cycle}. Failure details:

            {json.dumps(result.get("failed_steps", []), indent=2)}

            Use `/patch sprint-{self.sprint.id}-e2e-{cycle}` to create a focused
            patch plan that addresses ONLY the failures above (no scope creep).
            Then implement the patch following its phases.

            SUBAGENT DELEGATION IS NOT OPTIONAL — spawn exactly ONE `builder`
            subagent per Implementation Step in the patch plan. Pass the step
            text, the Validation commands, and any `file:line` anchors. The
            main session coordinates; it does NOT call Edit, Write, or
            multi-file Read inline. This session runs on Sonnet 200K — doing
            the work inline will exhaust context.

            Sprint context:
            {spec_paths_str}

            After implementing the patch, do NOT commit. The runner will commit
            via /commit on success of the next E2E cycle.

            Save the patch plan under: specs/patch/patch-sprint-{self.sprint.id}-e2e-{cycle}.md
            """)
        cr = self.claude.run(prompt, f"e2e-patch-{cycle}", max_turns=BUILD_MAX_TURNS,
                             attempt=rec["attempts"], model=self.execute_model,
                             idle_timeout_seconds=IDLE_TIMEOUT_E2E_S)
        self.s["step_executions"]["e2e_patch"] = self.s["step_executions"].get("e2e_patch", 0) + 1
        # Commit any patch changes (even if e2e re-runs after this) so they're
        # not lost on resume. Use /commit with chore class.
        if not working_tree_clean():
            commit_prompt = textwrap.dedent(f"""\
                /commit pipeline chore e2e patch cycle {cycle} for sprint {self.sprint.id}

                Use /commit to create one local commit only — do not push.
                """)
            self.claude.run(commit_prompt, f"e2e-patch-{cycle}-commit",
                            max_turns=DEFAULT_MAX_TURNS, model=self.execute_model)
            self.s["step_executions"]["commit"] = self.s["step_executions"].get("commit", 0) + 1
        self._end_step(rec, success=cr.succeeded, cr=cr,
                       error=None if cr.succeeded else cr.error)
        if not cr.succeeded:
            raise StepFailed("e2e_patch", cr.error or "patch attempt failed")

    # ── 6. review (with optional patch loop) ────────────────────────────

    def step_review(self) -> None:
        if self._step_completed("review"):
            log("  ✓ review (cached)")
            return
        max_cycles = REVIEW_PATCH_MAX_CYCLES
        for cycle in range(1, max_cycles + 1):
            rec = self._begin_step("review")
            result_path = self.log_dir / f"review-result-attempt-{cycle}.json"
            specs_list = "\n".join(f"  - {s['path']}" for s in self.s["specs"])
            prompt = textwrap.dedent(f"""\
                Use the workflow in `.claude/commands/review.md` to review the
                CURRENT sprint implementation against ALL specs below. Treat the
                whole sprint as one unit of review.

                Sprint specs (read every one):
                {specs_list}

                Write the FINAL review JSON to:
                  {result_path}
                using exactly the schema in review.md (`success`,
                `review_summary`, `review_issues`, `screenshots`).
                """)
            cr = self.claude.run(prompt, "review", max_turns=DEFAULT_MAX_TURNS,
                                 attempt=rec["attempts"], model=self.execute_model)
            result = read_json_file(result_path) or {}
            blockers = [
                i for i in result.get("review_issues", [])
                if i.get("issue_severity") == "blocker"
            ]
            success = bool(result.get("success")) and not blockers and cr.succeeded
            self.s["review"] = result | {"patch_cycles": cycle - 1}
            self.state.save()
            if success:
                self._end_step(rec, success=True, cr=cr)
                log(f"  ✓ review (cycle {cycle}, {len(result.get('review_issues', []))} non-blocking)")
                return
            self._end_step(rec, success=False, cr=cr,
                           error=f"{len(blockers)} blocker(s)")
            if cycle >= max_cycles:
                self.s["errors"].append({
                    "step": "review", "error": "exhausted patch cycles",
                    "blockers": blockers,
                })
                self.state.save()
                raise StepFailed("review", f"{len(blockers)} blocker(s) after {cycle} cycles")
            self._review_patch(cycle, blockers)

    def _review_patch(self, cycle: int, blockers: list[dict]) -> None:
        rec = self._begin_step("review_patch")
        prompt = textwrap.dedent(f"""\
            The sprint review found {len(blockers)} blocker issue(s) on cycle
            {cycle}:

            {json.dumps(blockers, indent=2)}

            Use `/patch sprint-{self.sprint.id}-review-{cycle}` to plan a
            focused fix for ONLY these blockers (no scope creep). Then
            implement the patch following its phases. Do NOT commit — the
            runner handles commits.

            SUBAGENT DELEGATION IS NOT OPTIONAL — spawn exactly ONE `builder`
            subagent per Implementation Step in the patch plan. Pass the step
            text, the Validation commands, and any `file:line` anchors. The
            main session coordinates; it does NOT call Edit, Write, or
            multi-file Read inline. This session runs on Sonnet 200K — doing
            the work inline will exhaust context.

            Save the patch plan under:
              specs/patch/patch-sprint-{self.sprint.id}-review-{cycle}.md
            """)
        cr = self.claude.run(prompt, f"review-patch-{cycle}", max_turns=BUILD_MAX_TURNS,
                             attempt=rec["attempts"], model=self.execute_model)
        self.s["step_executions"]["review_patch"] = self.s["step_executions"].get("review_patch", 0) + 1
        if not working_tree_clean():
            commit_prompt = textwrap.dedent(f"""\
                /commit pipeline chore review patch cycle {cycle} for sprint {self.sprint.id}
                """)
            self.claude.run(commit_prompt, f"review-patch-{cycle}-commit",
                            max_turns=DEFAULT_MAX_TURNS, model=self.execute_model)
            self.s["step_executions"]["commit"] = self.s["step_executions"].get("commit", 0) + 1
        self._end_step(rec, success=cr.succeeded, cr=cr,
                       error=None if cr.succeeded else cr.error)
        if not cr.succeeded:
            raise StepFailed("review_patch", cr.error or "patch attempt failed")

    # ── 7. document (per spec) ──────────────────────────────────────────

    def step_document(self) -> None:
        for i, spec in enumerate(self.s["specs"]):
            if spec.get("documentation"):
                log(f"  ✓ document [{i+1}/{len(self.s['specs'])}] {spec['id']} (cached)")
                continue
            step_name = f"document:{spec['id']}"
            self.s["step_executions"]["document"] = self.s["step_executions"].get("document", 0) + 1
            log(f"  · document [{i+1}/{len(self.s['specs'])}] {spec['id']}")
            before = snapshot([AI_DOCS_DIR])
            prompt = textwrap.dedent(f"""\
                /document {spec['id']} {REPO_ROOT / spec['path']}

                Follow .claude/commands/document.md exactly. After writing the
                doc and updating implementation-docs.md, return only the doc
                path on the final line.
                """)
            cr = self.claude.run(prompt, step_name, max_turns=DEFAULT_MAX_TURNS,
                                 model=self.execute_model)
            new_docs = newly_created(before, [AI_DOCS_DIR])
            if cr.succeeded and new_docs:
                spec["documentation"] = str(new_docs[0].relative_to(REPO_ROOT))
                self.s["documentation"].append(spec["documentation"])
                self.state.save()
            elif not cr.succeeded:
                raise StepFailed("document", cr.error or "document step failed")

        # Commit documentation changes (single commit covering all docs).
        if not working_tree_clean():
            log("    · /commit documentation")
            self.s["step_executions"]["commit"] = self.s["step_executions"].get("commit", 0) + 1
            self.claude.run(textwrap.dedent(f"""\
                /commit pipeline docs sprint {self.sprint.id} documentation
                """), "document-commit", max_turns=DEFAULT_MAX_TURNS,
                             model=self.execute_model)

    # ── 8. push + PR + merge (with conflict agent) ──────────────────────

    def step_publish(self) -> None:
        if self._step_completed("publish"):
            log("  ✓ publish (cached)")
            return
        rec = self._begin_step("publish")
        if self.dry_run:
            log("  ✓ publish [dry-run]")
            self._end_step(rec, success=True)
            return
        try:
            log(f"  · push {self.sprint.branch}")
            git("push", "-u", "origin", self.sprint.branch)

            pr = self.s.get("pr") or {}
            if not pr.get("number"):
                title = f"Sprint {self.sprint.id}: {self.sprint.title}"
                body = self._pr_body()
                body_path = self.log_dir / "pr-body.md"
                body_path.write_text(body)
                log(f"  · gh pr create '{title}'")
                res = run_cmd(
                    "gh", "pr", "create",
                    "--title", title,
                    "--body-file", str(body_path),
                    "--base", "main",
                    "--head", self.sprint.branch,
                )
                pr_url = res.stdout.strip().splitlines()[-1]
                pr_num = pr_url.rsplit("/", 1)[-1]
                pr = {"number": pr_num, "url": pr_url, "merged": False, "had_conflicts": False}
                self.s["pr"] = pr
                self.state.save()
                log(f"    ↳ PR #{pr_num}: {pr_url}")

            log(f"  · gh pr merge --merge {pr['number']}")
            merge_res = run_cmd(
                "gh", "pr", "merge", str(pr["number"]),
                "--merge",
                check=False,
            )
            if merge_res.returncode == 0:
                pr["merged"] = True
                self.s["pr"] = pr
                self.state.save()
                self._post_merge_sync_main()
                self._end_step(rec, success=True)
                log(f"  ✓ merged PR #{pr['number']}")
                return

            # Merge failed — likely conflict.
            log(f"  ⚠ merge failed: {merge_res.stderr.strip()[:200]}")
            pr["had_conflicts"] = True
            self.s["pr"] = pr
            self.state.save()
            ok = self._merge_conflict_agent(pr)
            if ok:
                # Re-attempt merge.
                merge_res = run_cmd(
                    "gh", "pr", "merge", str(pr["number"]),
                    "--merge",
                    check=False,
                )
                if merge_res.returncode == 0:
                    pr["merged"] = True
                    self.s["pr"] = pr
                    self.state.save()
                    self._post_merge_sync_main()
                    self._end_step(rec, success=True)
                    log(f"  ✓ merged PR #{pr['number']} (after conflict resolution)")
                    return
            self._end_step(rec, success=False,
                           error="merge conflict requires human attention")
            raise StepFailed("publish", "merge conflict — see MERGE_CONFLICT.md in run logs")
        except subprocess.CalledProcessError as e:
            self._end_step(rec, success=False, error=f"{e.cmd}: {e.stderr or e}")
            raise

    def _post_merge_sync_main(self) -> None:
        """After a successful PR merge, return to main and pull the latest.
        Non-fatal: the PR is already merged, so any failure here is a
        local-workspace nicety, not a correctness issue."""
        try:
            log("  · checkout main + pull --ff-only")
            git("checkout", "main")
            git("pull", "--ff-only")
        except subprocess.CalledProcessError as e:
            log(f"  ⚠ post-merge sync failed (non-fatal): {e.stderr or e}")

    def _pr_body(self) -> str:
        lines = [
            f"## Sprint {self.sprint.id}: {self.sprint.title}",
            "",
            f"**Sprint file**: `{self.sprint.path.relative_to(REPO_ROOT)}`",
            f"**Research**: `{self.s.get('research_doc')}`",
            "",
            "### Specs",
        ]
        for s in self.s["specs"]:
            sha = s["commit"]["sha"][:7] if s["commit"].get("sha") else "—"
            lines.append(f"- `{sha}` {s['title']} (`{s['path']}`)")
        lines += ["", "### E2E", f"- `{self.s.get('e2e_test_path')}`"]
        if self.s.get("documentation"):
            lines += ["", "### Documentation"]
            for d in self.s["documentation"]:
                lines.append(f"- `{d}`")
        lines += ["", "_Generated by `tools/sprint_runner.py`_"]
        return "\n".join(lines)

    def _merge_conflict_agent(self, pr: dict) -> bool:
        rec = self._begin_step("merge_conflict")
        log_path = self.log_dir / "merge-conflict-agent.jsonl"
        outcome_path = self.log_dir / "merge-outcome.json"
        conflict_report = self.log_dir / "MERGE_CONFLICT.md"

        spec_paths_str = "\n".join(f"  - {s['path']}" for s in self.s["specs"])
        prompt = textwrap.dedent(f"""\
            The PR for branch `{self.sprint.branch}` cannot merge into `main`
            because of conflicts.

            Your job, in order:

            1. Pull latest main into the branch:
               git fetch origin
               git checkout {self.sprint.branch}
               git merge origin/main
               (Capture the conflict list from the merge output.)

            2. For EACH conflicted file (`git status --porcelain | grep "^UU"`),
               classify the conflict:
                 - "TRIVIAL" — both sides added non-overlapping content
                   (separate functions, separate imports, separate enum cases,
                   non-overlapping list entries). Auto-resolution preserves both
                   sides without semantic ambiguity.
                 - "SEMANTIC" — overlapping changes to the same code path,
                   schema/migration changes, view logic, model definitions,
                   anything where the correct merge requires understanding
                   business intent.

            3. Read prior conflict resolutions from
               `.developer/merge-learnings.jsonl` (if it exists) — they may
               offer precedent. Do not blindly copy them; apply judgment.

            4. If ALL conflicts are TRIVIAL: resolve them, run
               `make validate`
               to verify the merge still passes (manifest + hook config
               JSON parses, hook self-test, `node --test tests/`), then
               commit the merge with
               `/commit pipeline chore "merge main into sprint-{self.sprint.id}"`,
               push, and exit.

            5. If ANY conflict is SEMANTIC: do NOT resolve. Run `git merge --abort`,
               then write a detailed conflict report to:
                 {conflict_report}
               describing each conflict, files involved, the diff hunks, and
               what context is needed to resolve safely. Do NOT commit anything.

            6. Append your decision to `.developer/merge-learnings.jsonl` as one
               JSON object per line:
                 {{
                   "ts": "<iso ts>", "sprint": "{self.sprint.id}",
                   "branch": "{self.sprint.branch}",
                   "files": ["..."], "classification": "TRIVIAL|SEMANTIC",
                   "auto_resolved": <bool>, "build_passed_after": <bool|null>,
                   "notes": "..."
                 }}
               This file is your team's accumulating playbook — be precise.

            7. Write the final outcome JSON to:
                 {outcome_path}
               with shape:
                 {{ "auto_resolved": <bool>, "build_passed_after": <bool|null>,
                    "files": ["..."], "report_path": "{conflict_report}" or null }}

            Sprint context (specs):
            {spec_paths_str}
            """)
        cr = self.claude.run(prompt, "merge-conflict", max_turns=MERGE_AGENT_MAX_TURNS,
                             attempt=rec["attempts"], model=self.plan_model)
        outcome = read_json_file(outcome_path) or {}
        auto = bool(outcome.get("auto_resolved"))
        build_ok = outcome.get("build_passed_after")
        success = auto and (build_ok is None or bool(build_ok))
        self.s["pr"]["conflict_outcome"] = outcome
        self.state.save()
        self._end_step(rec, success=success, cr=cr,
                       error=None if success else "needs human conflict resolution")
        return success

    # ── orchestrate ─────────────────────────────────────────────────────

    def run(self) -> None:
        self.s["status"] = "in_progress"
        self.s["started_at"] = self.s["started_at"] or now_iso()
        self.state.save()
        log(f"━━━ Sprint {self.sprint.id} ── {self.sprint.title}")
        try:
            self.step_branch()
            self.step_research()
            self.step_plan()
            self.step_build()
            self.step_test()
            self.step_e2e()
            self.step_review()
            self.step_document()
            self.step_publish()
            self.s["status"] = "completed"
            self.s["completed_at"] = now_iso()
            self.s["duration_seconds"] = (
                dt.datetime.fromisoformat(self.s["completed_at"])
                - dt.datetime.fromisoformat(self.s["started_at"])
            ).total_seconds()
            self.state.save()
            log(f"✅ Sprint {self.sprint.id} complete ({self.s['duration_seconds']:.0f}s)")
        except StepFailed as e:
            self.s["status"] = "failed"
            self.s["completed_at"] = now_iso()
            self.s["errors"].append({"step": e.step, "error": e.message})
            self.state.save()
            log(f"❌ Sprint {self.sprint.id} failed at {e.step}: {e.message}")
            if e.step == "test":
                halt_report = self.log_dir / "test-halt-report.md"
                if halt_report.exists():
                    log(f"📄 halt report: {halt_report}")
            raise


# ─── Helpers ───────────────────────────────────────────────────────────────

class StepFailed(Exception):
    def __init__(self, step: str, message: str):
        super().__init__(f"{step}: {message}")
        self.step = step
        self.message = message


def _spec_title(p: Path) -> str:
    try:
        text = p.read_text()
    except Exception:
        return p.stem
    m = re.search(r"^#\s+(.+)$", text, re.M)
    return m.group(1).strip() if m else p.stem


# ─── Top-level ─────────────────────────────────────────────────────────────

def cmd_list_sprints() -> None:
    files = sorted(SPRINT_DIR.glob("*.md"))
    files = [f for f in files if not f.name.startswith("00-")]
    for f in files:
        try:
            s = Sprint.from_path(f)
            band = f"[{s.band}]" if s.band else ""
            blocked = f"(blocked by {','.join(s.blocked_by)})" if s.blocked_by else ""
            print(f"  {s.id}  {s.title}  {band} {blocked}")
        except Exception as e:
            print(f"  {f.name}: ERROR {e}")


def find_resumable_run(run_id: str) -> Path:
    p = RUNS_DIR / run_id / "state.json"
    if not p.exists():
        fail(f"run {run_id} not found at {p}")
    return p


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sprint", help="sprint selector: '03', '03-08', '03,07,11'")
    resume_group = parser.add_mutually_exclusive_group()
    resume_group.add_argument("--resume", help="resume a previous run by id")
    resume_group.add_argument("--resume-from",
                              help="resume at RUN_ID[:SPRINT[:STEP]] "
                                   "(e.g. 20260417-101035:06:plan)")
    parser.add_argument("--run-id", help="explicit run id (default: timestamp)")
    parser.add_argument("--list-sprints", action="store_true")
    parser.add_argument("--dry-run", action="store_true",
                        help="snapshot prompts, do not invoke claude")
    parser.add_argument("--force-step", choices=["research", "plan", "build", "test",
                                                  "e2e", "review", "document", "publish"],
                        help="re-run this step even if cached")
    parser.add_argument(
        "--opus-only",
        action="store_true",
        help="force every phase (including build/test/review/document/commit) "
             "onto Opus 1M — for complex sprints where Sonnet capacity is "
             "insufficient. Costs more of the Claude Max usage cap.",
    )
    parser.add_argument("--max-test-escalations", type=int, default=MAX_TEST_ESCALATIONS_PER_SPRINT,
                        help=f"max bugfix escalations per sprint (default: {MAX_TEST_ESCALATIONS_PER_SPRINT})")
    parser.add_argument("--no-test-escalation", action="store_true",
                        help="disable bugfix escalation; keep current 6-cycle patch loop")
    args = parser.parse_args()

    if args.list_sprints:
        cmd_list_sprints()
        return

    if not args.sprint and not args.resume and not args.resume_from:
        parser.error("provide --sprint, --resume, or --resume-from")

    if args.resume_from:
        run_id, sprint_id, step = parse_resume_from(args.resume_from)
        state_path = find_resumable_run(run_id)
        run_state = State(state_path)
        if sprint_id:
            all_ids = [s["sprint_id"] for s in run_state.data.get("sprints", [])]
            if sprint_id not in all_ids:
                fail(f"sprint {sprint_id} not found in run {run_id}")
            tail = all_ids[all_ids.index(sprint_id):]
            sprint_ids = tail
        else:
            sprint_ids = [s["sprint_id"] for s in run_state.data.get("sprints", [])
                          if s["status"] != "completed"]
        if step and sprint_id:
            reset_sprint_from(run_state.sprint(sprint_id), step)
            run_state.save()
            args.force_step = step
        all_sprints = discover_sprints(",".join(sprint_ids)) if sprint_ids else []
        # Model resolution for resume: prefer recorded values unless --opus-only overrides.
        plan_model = PLAN_MODEL
        if args.opus_only:
            execute_model = PLAN_MODEL
            run_state.data["plan_model"] = plan_model
            run_state.data["execute_model"] = execute_model
            run_state.data["opus_only"] = True
            run_state.save()
        else:
            execute_model = run_state.data.get("execute_model", EXECUTE_MODEL)
            plan_model = run_state.data.get("plan_model", PLAN_MODEL)
    elif args.resume:
        run_id = args.resume
        state_path = find_resumable_run(run_id)
        run_state = State(state_path)
        sprint_ids = [s["sprint_id"] for s in run_state.data.get("sprints", [])
                      if s["status"] != "completed"]
        if args.sprint:
            sprint_ids = parse_sprint_selector(args.sprint)
        # Load sprint objects for the IDs we need to run.
        all_sprints = discover_sprints(",".join(sprint_ids)) if sprint_ids else []
        # Model resolution for resume: prefer recorded values unless --opus-only overrides.
        plan_model = PLAN_MODEL
        if args.opus_only:
            execute_model = PLAN_MODEL
            run_state.data["plan_model"] = plan_model
            run_state.data["execute_model"] = execute_model
            run_state.data["opus_only"] = True
            run_state.save()
        else:
            execute_model = run_state.data.get("execute_model", EXECUTE_MODEL)
            plan_model = run_state.data.get("plan_model", PLAN_MODEL)
    else:
        run_id = args.run_id or dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        run_dir = RUNS_DIR / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        state_path = run_dir / "state.json"
        run_state = State(state_path)
        plan_model = PLAN_MODEL
        execute_model = PLAN_MODEL if args.opus_only else EXECUTE_MODEL
        run_state.data.setdefault("run_id", run_id)
        run_state.data.setdefault("started_at", now_iso())
        run_state.data.setdefault("sprint_selector", args.sprint)
        run_state.data.setdefault("sprints", [])
        run_state.data.setdefault("plan_model", plan_model)
        run_state.data.setdefault("execute_model", execute_model)
        run_state.data.setdefault("opus_only", args.opus_only)
        run_state.save()
        all_sprints = discover_sprints(args.sprint)

    log(f"run_id = {run_id}")
    log(f"models = plan={plan_model}  execute={execute_model}  "
        f"(opus-only override: {'yes' if args.opus_only else 'no'})")
    log(f"state  = {state_path.relative_to(REPO_ROOT)}")
    log(f"sprints to run: {[s.id for s in all_sprints]}")

    run_log_dir = state_path.parent

    # Resume safety guard: ensure clean working tree before resuming.
    if args.resume_from or args.resume:
        if not working_tree_clean(ignore=run_log_dir):
            fail("working tree is dirty — commit or stash before resuming")

    # Clear stale terminal run-status so dashboard reflects in-flight state
    # while this resume is executing. Terminal writes below will overwrite
    # on the next terminal transition.
    if args.resume_from or args.resume:
        run_state.data["status"] = "in_progress"
        run_state.data.pop("completed_at", None)
        run_state.data.pop("duration_seconds", None)
        run_state.save()

    started = time.monotonic()
    with RunLock(run_log_dir):
        try:
            for sprint in all_sprints:
                ex = SprintExecutor(
                    sprint=sprint,
                    run_state=run_state,
                    run_log_dir=run_log_dir,
                    dry_run=args.dry_run,
                    force_step=args.force_step,
                    plan_model=plan_model,
                    execute_model=execute_model,
                    max_test_escalations=args.max_test_escalations,
                    no_test_escalation=args.no_test_escalation,
                )
                ex.run()
        except StepFailed:
            run_state.data["status"] = "failed"
            run_state.data["completed_at"] = now_iso()
            run_state.save()
            log("⛔ stopping: sprint failure (sequential dependencies require halt)")
            sys.exit(2)
        except KeyboardInterrupt:
            run_state.data["status"] = "interrupted"
            run_state.data["completed_at"] = now_iso()
            run_state.save()
            log("interrupted by user")
            sys.exit(130)

        run_state.data["status"] = "completed"
        run_state.data["completed_at"] = now_iso()
        run_state.data["duration_seconds"] = round(time.monotonic() - started, 1)
        run_state.save()
        log(f"✅ run complete ({run_state.data['duration_seconds']}s)")


if __name__ == "__main__":
    main()
