"""Backend for 'InterSystems Programming Challenge: GAIA'.

Discovers the challenge projects that live next to this app (any sibling
directory with a docker-compose file), and runs the selected one inside its
already-running IRIS container via a configurable launch command (default
`do ^RunScript`). `/run` executes it once and returns the parsed result CSV;
`/benchmark` runs it N times and streams live timing statistics (SSE).
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
# marker file written into repos the evaluator clones, so cleanup only ever
# deletes evaluator-managed checkouts — never a project the user placed here.
CLONE_MARKER = ".evaluator-clone"
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


def _compose_uses_underscore():
    """Compose v1 names containers with underscores (proj_iris_1); Compose v2
    uses hyphens (proj-iris-1). Detect which is installed by parsing the version.
    Cached so we probe the CLI at most once."""
    if _compose_uses_underscore.cached is not None:
        return _compose_uses_underscore.cached
    underscore = False
    try:
        out = subprocess.run(_compose_cmd() + ["version", "--short"],
                             capture_output=True, text=True, timeout=15).stdout.strip()
        # e.g. "v2.29.1" (v2, hyphen) vs "1.29.2" (v1, underscore)
        major = re.match(r"v?(\d+)", out)
        underscore = bool(major) and int(major.group(1)) < 2
    except Exception:
        underscore = False  # default to modern v2 hyphen naming
    _compose_uses_underscore.cached = underscore
    return underscore
_compose_uses_underscore.cached = None


def _candidate_containers(project):
    """The container names Compose could have created for this project folder,
    across v1 (underscore) and v2 (hyphen) naming. Project name is lowercased
    with characters outside [a-z0-9_-] stripped, as Compose does. Service=iris."""
    normalized = re.sub(r"[^a-z0-9_-]", "", project.lower())
    return [f"{normalized}-iris-1", f"{normalized}_iris_1"]


def _container_for(project, running=None):
    """Resolve the container name for a project folder. If a set of running
    container names is given, return whichever candidate actually exists;
    otherwise fall back to the naming for the installed Compose version."""
    candidates = _candidate_containers(project)
    if running is not None:
        for c in candidates:
            if c in running:
                return c
    return candidates[1] if _compose_uses_underscore() else candidates[0]


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
        if not has_compose:
            continue
        container = _container_for(name, running)
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
    running = _running_containers()
    container = _container_for(project, running)
    return {"name": project, "container": container, "running": container in running}


DEFAULT_COMMAND = "do ^RunScript"


def _run_in_container(container, command=DEFAULT_COMMAND):
    """Run an ObjectScript command (default `do ^RunScript`) in the container;
    return (raw_stdout, wall_seconds).

    Serialized by `_run_lock` so no two runs overlap — each gets the full CPU.
    The clock starts only after the lock is acquired, so time spent waiting for
    another run to finish is never counted against this one's measured time."""
    command = (command or DEFAULT_COMMAND).strip()
    with _run_lock:
        started = time.time()
        proc = subprocess.run(
            ["docker", "exec", "-i", container, "iris", "session", "iris"],
            input=f"{command}\nhalt\n",
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
        # No CSV in the expected output dir — e.g. a project that writes its
        # result elsewhere, or hasn't run yet. Return an empty result rather than
        # 500 so the UI shows "no output" gracefully instead of an error.
        return DEFAULT_COLUMNS, []
    proc = subprocess.run(
        ["docker", "exec", container, "cat", path],
        capture_output=True, text=True, timeout=60,
    )
    if proc.returncode != 0:
        return DEFAULT_COLUMNS, []
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


# Match owner/repo from any GitHub URL form and ignore trailing path/query/
# fragment (e.g. /tree/main): with/without scheme or www, https, or SSH.
#   github.com/owner/repo · https://www.github.com/owner/repo/tree/x · git@github.com:owner/repo.git
_GH_RE = re.compile(
    r"github\.com[/:]([\w.-]+)/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$", re.I
)


def _require_host_tool(tool, hint=""):
    """Ensure a CLI the backend shells out to is on the host PATH; else 503."""
    if shutil.which(tool) is None:
        msg = f"'{tool}' was not found on the server's PATH."
        if hint:
            msg += " " + hint
        raise HTTPException(503, msg)


def _compose_cmd():
    """`docker compose` (v2) if available, else `docker-compose` (v1)."""
    if shutil.which("docker-compose"):
        return ["docker-compose"]
    return ["docker", "compose"]


@app.post("/clone")
def clone(req: CloneRequest):
    """Clone a public GitHub repo into PROJECTS_ROOT, verify it's a runnable
    challenge project, build + start its container, and return the project."""
    # cloning + building need git and docker on the host PATH
    _require_host_tool("git", "Install Git and ensure it is on the server's PATH.")
    _require_host_tool("docker", "Install Docker and ensure it is on the server's PATH.")
    m = _GH_RE.search(req.url.strip())
    if not m:
        raise HTTPException(400, "Not a GitHub repo URL (expected github.com/owner/repo).")
    owner, repo = m.group(1), m.group(2)
    folder = repo  # docker-compose derives the container name from the dir name
    dest = os.path.join(PROJECTS_ROOT, folder)
    https_url = f"https://github.com/{owner}/{repo}.git"

    # reject anything that would escape PROJECTS_ROOT
    if not os.path.abspath(dest).startswith(os.path.abspath(PROJECTS_ROOT) + os.sep):
        raise HTTPException(400, "invalid repository name")

    # clone fresh (or refresh an existing checkout)
    if os.path.isdir(os.path.join(dest, ".git")):
        # Refresh to exactly match the remote. Use fetch + hard reset rather than
        # `pull --ff-only`, so a force-pushed / rewritten upstream (non-fast-
        # forward history) still updates cleanly instead of aborting. This is a
        # throwaway checkout we only run, so discarding local state is fine.
        fetch = subprocess.run(["git", "-C", dest, "fetch", "--depth", "1", "origin"],
                               capture_output=True, text=True, timeout=120)
        if fetch.returncode != 0:
            raise HTTPException(502, f"git fetch failed: {fetch.stderr[-300:]}")
        # figure out the remote's default branch (origin/HEAD), fall back to main
        head = subprocess.run(
            ["git", "-C", dest, "rev-parse", "--abbrev-ref", "origin/HEAD"],
            capture_output=True, text=True, timeout=30,
        )
        ref = head.stdout.strip() or "origin/main"
        if "/" not in ref:
            ref = "origin/main"
        reset = subprocess.run(["git", "-C", dest, "reset", "--hard", ref],
                               capture_output=True, text=True, timeout=60)
        if reset.returncode != 0:
            raise HTTPException(502, f"git reset failed: {reset.stderr[-300:]}")
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

    # Mark this as an evaluator-managed clone so /remove can safely delete it
    # (and never a project the user placed here themselves).
    try:
        open(os.path.join(dest, CLONE_MARKER), "w").close()
    except OSError:
        pass

    # The repo is cloned regardless of whether it can run. Anything that stops
    # it from being runnable becomes a *warning* the UI surfaces on hover,
    # instead of rejecting the import outright.
    warnings = []
    lines, chars = _count_source(dest)
    container = _container_for(folder)

    has_compose = any(os.path.exists(os.path.join(dest, f))
                      for f in ("docker-compose.yml", "docker-compose.yaml", "compose.yml"))
    if not has_compose:
        warnings.append("No docker-compose file — there is no container to build or run.")
    else:
        # build + start the container (detached)
        up = subprocess.run(_compose_cmd() + ["up", "--build", "-d"],
                            cwd=dest, capture_output=True, text=True, timeout=1200)
        if up.returncode != 0:
            # build failed (e.g. the repo's Dockerfile is broken) — tear down any
            # partial state, keep the clone, and record why as a warning.
            subprocess.run(_compose_cmd() + ["down", "-v", "--remove-orphans"],
                           cwd=dest, capture_output=True, text=True, timeout=120)
            tail = (up.stderr or up.stdout or "").strip()[-600:]
            warnings.append(f"Docker build failed:\n{tail}")

    running = container in _running_containers()
    if has_compose and not running and not warnings:
        warnings.append(f"Container '{container}' did not start after build.")

    # A repo that uses a non-standard entry point (no src/RunScript.mac and no
    # top-level run script) may need its run command changed in settings.
    has_runscript = os.path.exists(os.path.join(dest, "src", "RunScript.mac"))
    has_runsh = any(os.path.exists(os.path.join(dest, f))
                    for f in ("RunChallenge.sh", "run.sh", "RunScript.sh"))
    if running and not has_runscript:
        if has_runsh:
            warnings.append(
                "No src/RunScript.mac. This repo appears to run via a host shell "
                "script (e.g. ./RunChallenge.sh), which this evaluator does not "
                "execute — it runs an in-container command. Set a working command "
                "in settings, or expect no result.")
        else:
            warnings.append(
                "No src/RunScript.mac — the default `do ^RunScript` command may "
                "not work. Set the correct launch command in settings.")

    return {
        "name": folder,
        "container": container,
        "running": running,
        "lines": lines,
        "chars": chars,
        "warnings": warnings,
    }


class RemoveRequest(BaseModel):
    project: str


@app.post("/remove")
def remove(req: RemoveRequest):
    """Tear down and delete an evaluator-cloned project: stop/remove its
    container + volumes, then delete the checkout. Only touches directories the
    evaluator itself created (marked with CLONE_MARKER); refuses anything else."""
    project = req.project
    if not project or "/" in project or ".." in project:
        raise HTTPException(400, "invalid project name")
    dest = os.path.join(PROJECTS_ROOT, project)
    if not os.path.abspath(dest).startswith(os.path.abspath(PROJECTS_ROOT) + os.sep):
        raise HTTPException(400, "invalid project name")

    # only remove evaluator-managed clones — never a user's own project dir
    if not os.path.exists(os.path.join(dest, CLONE_MARKER)):
        raise HTTPException(
            403, f'"{project}" was not cloned by the evaluator; refusing to delete it.')

    # stop + remove the container and its volumes (ignore if already down)
    if any(os.path.exists(os.path.join(dest, f))
           for f in ("docker-compose.yml", "docker-compose.yaml", "compose.yml")):
        subprocess.run(_compose_cmd() + ["down", "-v", "--remove-orphans"],
                       cwd=dest, capture_output=True, text=True, timeout=180)
    shutil.rmtree(dest, ignore_errors=True)
    return {"removed": project}


@app.get("/result")
def result(project: str):
    """Read the CSV the project last produced (no new run)."""
    p = _resolve(project)
    header, rows = _read_csv(p["container"])
    return {"project": project, "columns": header, "total_rows": len(rows), "rows": rows}


@app.get("/run")
def run(project: str, command: str = DEFAULT_COMMAND):
    p = _resolve(project)
    if not p["running"]:
        raise HTTPException(409, f"container '{p['container']}' is not running")

    stdout, wall = _run_in_container(p["container"], command)
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
def benchmark(project: str, runs: int = 1000, command: str = DEFAULT_COMMAND):
    """Run the project `runs` times, streaming a live stats update per run (SSE)."""
    p = _resolve(project)
    if not p["running"]:
        raise HTTPException(409, f"container '{p['container']}' is not running")
    runs = max(1, min(runs, 5000))

    def event_stream():
        times = []
        for i in range(1, runs + 1):
            # Once the stream has started we can't raise an HTTPException, so a
            # per-run failure is emitted as an SSE `error` event and the stream
            # ends cleanly instead of crashing the ASGI response.
            try:
                stdout, wall = _run_in_container(p["container"], command)
            except HTTPException as e:
                yield f"event: error\ndata: {json.dumps({'detail': str(e.detail)})}\n\n"
                return
            except Exception as e:
                yield f"event: error\ndata: {json.dumps({'detail': f'run failed: {e}'})}\n\n"
                return
            times.append(_elapsed(stdout, wall))
            payload = {"run": i, "total": runs, **_stats(times)}
            yield f"data: {json.dumps(payload)}\n\n"
        yield f"event: done\ndata: {json.dumps({'total': runs})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/health")
def health():
    return {"status": "ok", "projects": [p["name"] for p in discover_projects()]}


def _sweep_clones():
    """Remove every evaluator-managed clone (marked with CLONE_MARKER): stop its
    container + volumes, then delete the checkout. Marker-guarded, so it only
    ever touches dirs the evaluator created — never a project the user placed
    alongside it. Returns the list of removed project names."""
    removed = []
    for name in sorted(os.listdir(PROJECTS_ROOT)):
        path = os.path.join(PROJECTS_ROOT, name)
        if not os.path.isdir(path) or not os.path.exists(os.path.join(path, CLONE_MARKER)):
            continue
        if any(os.path.exists(os.path.join(path, f))
               for f in ("docker-compose.yml", "docker-compose.yaml", "compose.yml")):
            subprocess.run(_compose_cmd() + ["down", "-v", "--remove-orphans"],
                           cwd=path, capture_output=True, text=True, timeout=180)
        shutil.rmtree(path, ignore_errors=True)
        removed.append(name)
    if removed:
        print(f"[sweep] removed {len(removed)} evaluator clone(s): {', '.join(removed)}")
    return removed


@app.post("/sweep")
def sweep():
    """Tear down and delete all evaluator-cloned projects. Called by the frontend
    on load, so a page reload starts from a clean slate."""
    return {"removed": _sweep_clones()}


@app.on_event("startup")
def _on_startup():
    _sweep_clones()
