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
import statistics
import subprocess
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

app = FastAPI(title="InterSystems Programming Challenge: GAIA")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

# Projects live one level up from frontend-app/ (…/Projects/Gaia/<project>/).
PROJECTS_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = "/home/irisowner/dev/data/out/challenge_output.csv"


def _running_containers():
    """Set of currently-running container names."""
    proc = subprocess.run(
        ["docker", "ps", "--format", "{{.Names}}"],
        capture_output=True, text=True, timeout=30,
    )
    return set(proc.stdout.split()) if proc.returncode == 0 else set()


def _container_for(project):
    """docker-compose names containers `<dir>-<service>-1`; the service is `iris`."""
    return f"{project}-iris-1"


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
    """Run `do ^RunScript` in the container; return (raw_stdout, wall_seconds)."""
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
    """Cat the result CSV out of the container and parse it."""
    proc = subprocess.run(
        ["docker", "exec", container, "cat", CSV_PATH],
        capture_output=True, text=True, timeout=60,
    )
    if proc.returncode != 0:
        raise HTTPException(500, "could not read result CSV from container")
    reader = csv.reader(io.StringIO(proc.stdout))
    header = next(reader, [])
    rows = list(reader)
    return header, rows


@app.get("/projects")
def projects():
    return {"projects": discover_projects()}


@app.get("/status")
def status(project: str):
    """Whether the container for a chosen folder is running."""
    return _resolve(project)


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
