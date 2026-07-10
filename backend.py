"""Backend for 'InterSystems Programming Challenge: GAIA'.

Discovers the challenge projects that live next to this app (any sibling
directory with a docker-compose file and a `src/RunScript.mac`), and runs the
selected one inside its already-running IRIS container. `/run` executes it once
and returns the parsed result CSV; `/benchmark` runs it N times and streams live
timing statistics (SSE).
"""
import csv
import io
import json
import os
import re
import shutil
import statistics
import subprocess
import threading
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI(title="InterSystems Programming Challenge: GAIA")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

# Global lock so that at most one `do ^RunScript` executes at a time across ALL
# projects and requests. The frontend opens a concurrent SSE stream per project,
# but IRIS runs share the same 16 cores — letting two overlap would make every
# timing contend for CPU (measured ~+50% for just two at once). Serializing
# guarantees each run gets the full machine, so a project's time is the same
# whether it's compared against 1 project or 10.
_run_lock = threading.Lock()

# Projects live one level up from frontend-app/ (…/Projects/Gaia/<project>/).
PROJECTS_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = "/home/irisowner/dev/data/out"
# column names to use for headerless result CSVs (the challenge's fixed schema)
DEFAULT_COLUMNS = ["source_id", "bp_min_flux", "bp_max_flux",
                   "rp_min_flux", "rp_max_flux", "percentage_change"]

# non-code artifacts excluded from the lines/characters count (mirrors the UI)
_SKIP_EXT = {".so", ".pyc", ".pyo", ".o", ".a", ".dll", ".dylib", ".bin",
             ".png", ".jpg", ".jpeg", ".gif", ".ico", ".zip", ".gz"}


def _count_source(project_dir):
    """Lines + characters of the code under <project>/src, excluding RunScript,
    dotfiles, __pycache__, and compiled/binary artifacts (mirrors the UI)."""
    src = os.path.join(project_dir, "src")
    lines = chars = 0
    for root, dirs, names in os.walk(src):
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith(".")]
        for name in names:
            if name.startswith(".") or os.path.splitext(name)[1].lower() in _SKIP_EXT:
                continue
            if re.match(r"runscript(\.mac)?$", name, re.I):
                continue
            try:
                with open(os.path.join(root, name), encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except OSError:
                continue
            chars += len(text)
            lines += text.count("\n") + (0 if text.endswith("\n") or text == "" else 1)
    return lines, chars


def _running_containers():
    """Set of currently-running container names."""
    proc = subprocess.run(
        ["docker", "ps", "--format", "{{.Names}}"],
        capture_output=True, text=True, timeout=30,
    )
    return set(proc.stdout.split()) if proc.returncode == 0 else set()


def _container_for(project):
    """docker-compose names containers `<project>-<service>-1`, where the project
    name is the directory name normalized by Compose: lowercased, with any
    character outside [a-z0-9_-] stripped. The service is `iris`."""
    normalized = re.sub(r"[^a-z0-9_-]", "", project.lower())
    return f"{normalized}-iris-1"


def discover_projects():
    """Sibling dirs that look like a runnable challenge project."""
    running = _running_containers()
    projects = []
    for name in sorted(os.listdir(PROJECTS_ROOT)):
        path = os.path.join(PROJECTS_ROOT, name)
        if not os.path.isdir(path):
            continue
        has_compose = any(
            os.path.exists(os.path.join(path, f))
            for f in ("docker-compose.yml", "docker-compose.yaml", "compose.yml")
        )
        has_runscript = os.path.exists(os.path.join(path, "src", "RunScript.mac"))
        if not (has_compose and has_runscript):
            continue
        container = _container_for(name)
        projects.append({
            "name": name,
            "path": path,
            "container": container,
            "running": container in running,
        })
    return projects


def _resolve(project):
    """Map a folder name to its container. The folder is chosen (and its
    RunScript validated) in the browser, so we don't require it to be one of the
    pre-discovered projects — we only derive the container and report if it's up."""
    if not project or "/" in project or ".." in project:
        raise HTTPException(400, "invalid project name")
    container = _container_for(project)
    return {"name": project, "container": container, "running": container in _running_containers()}


def _run_in_container(container):
    """Run `do ^RunScript` in the container; return (raw_stdout, wall_seconds).

    Serialized by `_run_lock` so no two runs overlap — each gets the full CPU.
    The clock starts only after the lock is acquired, so time spent waiting for
    another run to finish is never counted against this one's measured time."""
    with _run_lock:
        started = time.time()
        proc = subprocess.run(
            ["docker", "exec", "-i", container, "iris", "session", "iris"],
            input="do ^RunScript\nhalt\n",
            capture_output=True, text=True, timeout=180,
        )
        wall = time.time() - started
    if proc.returncode != 0:
        raise HTTPException(500, f"container run failed: {proc.stderr[-400:]}")
    return proc.stdout, wall


def _elapsed(stdout, wall):
    """Prefer the elapsed time the routine prints; else the measured wall time."""
    match = re.search(r"Elapsed time:\s*([\d.]+)", stdout)
    return float(match.group(1)) if match else wall


def _read_csv(container):
    """Read the result CSV out of the container's data/out and parse it.

    The output filename is author-specific (e.g. challenge_output.csv,
    result.csv), so we read the most recently modified *.csv in data/out
    rather than assume a fixed name."""
    # newest-first listing of *.csv by mtime; pick the first line
    find = subprocess.run(
        ["docker", "exec", container, "sh", "-c",
         f"ls -t {OUT_DIR}/*.csv 2>/dev/null | head -1"],
        capture_output=True, text=True, timeout=60,
    )
    path = find.stdout.strip()
    if not path:
        raise HTTPException(500, "no result CSV was produced in data/out")
    proc = subprocess.run(
        ["docker", "exec", container, "cat", path],
        capture_output=True, text=True, timeout=60,
    )
    if proc.returncode != 0:
        raise HTTPException(500, "could not read result CSV from container")
    all_rows = list(csv.reader(io.StringIO(proc.stdout)))
    if not all_rows:
        return DEFAULT_COLUMNS, []
    # Some solutions omit the header row (e.g. write only data). Only treat the
    # first line as a header if its first cell is non-numeric (a real column
    # name like "source_id"); otherwise it's a data row and we keep it.
    first = all_rows[0]
    first_cell = first[0].strip() if first else ""
    is_header = not re.match(r"^-?\d", first_cell)  # data rows start with a digit
    if is_header:
        return first, all_rows[1:]
    return DEFAULT_COLUMNS, all_rows


@app.get("/projects")
def projects():
    return {"projects": discover_projects()}


@app.get("/status")
def status(project: str):
    """Whether the container for a chosen folder is running."""
    return _resolve(project)


class CloneRequest(BaseModel):
    url: str


# github.com/owner/repo  |  https://github.com/owner/repo(.git)  |  git@github.com:owner/repo.git
_GH_RE = re.compile(
    r"^(?:(?:https?://)?github\.com/|git@github\.com:)([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", re.I
)


def _compose_cmd():
    """`docker compose` (v2) if available, else `docker-compose` (v1)."""
    if shutil.which("docker-compose"):
        return ["docker-compose"]
    return ["docker", "compose"]


@app.post("/clone")
def clone(req: CloneRequest):
    """Clone a public GitHub repo into PROJECTS_ROOT, verify it's a runnable
    challenge project, build + start its container, and return the project."""
    m = _GH_RE.match(req.url.strip())
    if not m:
        raise HTTPException(400, "Not a GitHub repo URL (expected github.com/owner/repo).")
    owner, repo = m.group(1), m.group(2)
    folder = repo  # docker-compose derives the container name from the dir name
    dest = os.path.join(PROJECTS_ROOT, folder)
    https_url = f"https://github.com/{owner}/{repo}.git"

    # reject anything that would escape PROJECTS_ROOT
    if not os.path.abspath(dest).startswith(os.path.abspath(PROJECTS_ROOT) + os.sep):
        raise HTTPException(400, "invalid repository name")

    # clone fresh (or refresh an existing checkout). `we_cloned` tracks whether
    # THIS call created the directory, so cleanup on later failure only removes
    # dirs we made — never a pre-existing checkout the user already had.
    we_cloned = False
    if os.path.isdir(os.path.join(dest, ".git")):
        pull = subprocess.run(["git", "-C", dest, "pull", "--ff-only"],
                              capture_output=True, text=True, timeout=120)
        if pull.returncode != 0:
            raise HTTPException(502, f"git pull failed: {pull.stderr[-300:]}")
    else:
        if os.path.exists(dest):
            raise HTTPException(409, f'"{folder}" already exists but is not a git checkout.')
        cl = subprocess.run(["git", "clone", "--depth", "1", https_url, dest],
                            capture_output=True, text=True, timeout=180)
        if cl.returncode != 0:
            err = cl.stderr.lower()
            if "not found" in err or "repository not found" in err or "authentication" in err:
                raise HTTPException(404, "Repository not found or not public.")
            raise HTTPException(502, f"git clone failed: {cl.stderr[-300:]}")
        we_cloned = True

    def _cleanup():
        """Remove a directory this call created — leave pre-existing ones alone."""
        if we_cloned:
            shutil.rmtree(dest, ignore_errors=True)

    # must be a runnable challenge project
    has_runscript = os.path.exists(os.path.join(dest, "src", "RunScript.mac"))
    has_compose = any(os.path.exists(os.path.join(dest, f))
                      for f in ("docker-compose.yml", "docker-compose.yaml", "compose.yml"))
    if not has_runscript:
        _cleanup()
        raise HTTPException(422, f'"{repo}" has no src/RunScript.mac — not a challenge project.')
    if not has_compose:
        _cleanup()
        raise HTTPException(422, f'"{repo}" has no docker-compose file.')

    # build + start the container (detached)
    up = subprocess.run(_compose_cmd() + ["up", "--build", "-d"],
                        cwd=dest, capture_output=True, text=True, timeout=1200)
    if up.returncode != 0:
        # the image/container build failed (e.g. the repo's Dockerfile is broken);
        # tear down anything compose partially created, then remove our clone.
        subprocess.run(_compose_cmd() + ["down", "-v", "--remove-orphans"],
                       cwd=dest, capture_output=True, text=True, timeout=120)
        _cleanup()
        tail = (up.stderr or up.stdout or "").strip()[-400:]
        raise HTTPException(502, f"Build failed for '{repo}'. Its Dockerfile did not build:\n{tail}")

    lines, chars = _count_source(dest)
    container = _container_for(folder)
    return {
        "name": folder,
        "container": container,
        "running": container in _running_containers(),
        "lines": lines,
        "chars": chars,
    }


@app.get("/result")
def result(project: str):
    """Read the CSV the project last produced (no new run)."""
    p = _resolve(project)
    header, rows = _read_csv(p["container"])
    return {"project": project, "columns": header, "total_rows": len(rows), "rows": rows}


@app.get("/run")
def run(project: str):
    p = _resolve(project)
    if not p["running"]:
        raise HTTPException(409, f"container '{p['container']}' is not running")

    stdout, wall = _run_in_container(p["container"])
    elapsed = _elapsed(stdout, wall)
    header, rows = _read_csv(p["container"])
    return {
        "project": project,
        "elapsed_seconds": round(elapsed, 3),
        "wall_seconds": round(wall, 3),
        "total_rows": len(rows),
        "columns": header,
        "rows": rows,
    }


BIN_WIDTH = 0.05  # 50 ms histogram bins


def _stats(times):
    ordered = sorted(times)
    n = len(ordered)

    def pct(p):
        k = (n - 1) * p
        lo = int(k)
        hi = min(lo + 1, n - 1)
        return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)

    # histogram as list of {lo, count} in ascending bin order
    counts = {}
    for x in times:
        b = round(x // BIN_WIDTH * BIN_WIDTH, 2)
        counts[b] = counts.get(b, 0) + 1
    histogram = [{"lo": b, "hi": round(b + BIN_WIDTH, 2), "count": counts[b]}
                 for b in sorted(counts)]

    return {
        "count": n,
        "min": round(min(times), 3),
        "max": round(max(times), 3),
        "mean": round(statistics.mean(times), 3),
        "median": round(statistics.median(times), 3),
        "p95": round(pct(0.95), 3),
        "histogram": histogram,
    }


@app.get("/benchmark")
def benchmark(project: str, runs: int = 1000):
    """Run the project `runs` times, streaming a live stats update per run (SSE)."""
    p = _resolve(project)
    if not p["running"]:
        raise HTTPException(409, f"container '{p['container']}' is not running")
    runs = max(1, min(runs, 5000))

    def event_stream():
        times = []
        for i in range(1, runs + 1):
            stdout, wall = _run_in_container(p["container"])
            times.append(_elapsed(stdout, wall))
            payload = {"run": i, "total": runs, **_stats(times)}
            yield f"data: {json.dumps(payload)}\n\n"
        yield f"event: done\ndata: {json.dumps({'total': runs})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/health")
def health():
    return {"status": "ok", "projects": [p["name"] for p in discover_projects()]}
