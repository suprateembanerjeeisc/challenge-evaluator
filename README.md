# InterSystems Programming Challenge: GAIA — Evaluator

A small web app to run and compare GAIA challenge submissions. Point it at one or
more project folders (each containing `src/RunScript.mac`), and it runs `do ^RunScript`
inside that project's IRIS container, showing results and benchmarking timings.

## Features

- **Open-folder picker** — choose any project folder; it validates a `RunScript`
  is present and confirms the project's IRIS container is running.
- **Compare up to 10 projects** — each gets a color; rename titles inline, toggle
  which to run with checkboxes.
- **Runs selector** — run once (shows the result CSV table, sortable/paginated) or
  N times to benchmark.
- **Live comparison** — a stats table (min/max/mean/median timings, plus lines and
  characters of code) with a per-project spinner while running, and an overlaid
  multi-color run-time histogram with a legend and per-series visibility toggles.
- Results persist across separate runs, so you can benchmark projects one at a time
  and still compare them side by side.

## Architecture

- **`backend.py`** — FastAPI. Discovers sibling challenge projects, runs
  `do ^RunScript` in each project's `docker-compose` container via `docker exec`,
  parses the result CSV, and streams live benchmark statistics over SSE.
- **`ui/`** — Vite + React + TypeScript + Tailwind, shadcn-style dark UI.

## Running

Backend (needs `fastapi` + `uvicorn`):

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

The challenge projects must be running (`docker-compose up -d` in each), and the
backend expects them as sibling directories of `frontend-app/`.
