# InterSystems Programming Challenge: GAIA — Evaluator

A web app to run and compare GAIA challenge submissions side by side.

You paste a GitHub repo URL; the app clones it, builds its container, runs it, and
plots how fast it went and what it produced. Add several repos and compare them on
one chart.

## What happens to a submission

Every repo you add goes through the exact same steps, in the same order:

1. **Clone** — the public GitHub repo is cloned as-is. Nothing in it is edited.
2. **Build** — its own `docker-compose` file and `Dockerfile` build its container.
   The submission defines its own environment; the evaluator only presses "build".
3. **Run** — the app runs one command inside the container (by default
   `do ^RunScript`, editable per project in ⚙ settings) and reads the CSV the run
   writes out.
4. **Measure** — that run is repeated N times, and the elapsed time of each run is
   recorded.

Step 3–4 are identical for every project: same command, same input files (each
container reads the same Gaia DR3 archives), same clock, same way of reading the
result.

## How runs are timed

Runs never overlap. The backend holds a single lock, so only one submission's run
executes at any instant — a run never shares the machine with another. The clock
starts only after a run actually begins, so waiting in line is never counted
against a submission's time. Whether you compare one project or ten, each one's
recorded times are the same as if it had run alone.

## What you see

- A **table**: min / max / mean / median run time, the lines and characters of
  code in the repo, and a **Result** link showing how many rows that run produced
  (click it to view the full output).
- A **histogram**: every project's run-time distribution overlaid in its own color,
  so you can see them against each other directly.

If a repo can't be built or run, it's kept but flagged with a warning (hover to see
why) and left out of the comparison, rather than silently skewing it.

## Running the app

Backend (needs `fastapi`, `uvicorn`, and `docker` + `git` on the PATH):

```bash
cd frontend-app
uvicorn backend:app --host 127.0.0.1 --port 8200 --reload
```

Frontend:

```bash
cd frontend-app/ui
npm install
npm run dev        # http://localhost:5173
```

Then open the app, paste a GitHub repo URL, and press Run.

## How it's built

- **`backend.py`** — FastAPI. Clones repos, builds/starts their containers, runs
  the configured command via `docker exec`, and streams live timing over SSE.
- **`ui/`** — Vite + React + TypeScript + Tailwind.
