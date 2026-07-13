import { useState, useMemo, useRef, useEffect } from "react"
import {
  Play, Loader2, Database, ArrowUp, ArrowDown, ChevronsUpDown,
  ChevronLeft, ChevronRight, Square, X, Pencil, Download, ChevronUp, ChevronDown, Settings,
  AlertTriangle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import { MultiHistogram, type Bin, type Series } from "@/components/MultiHistogram"
import { RunsInput } from "@/components/RunsInput"
import { useToast } from "@/components/Toaster"

const API = "http://127.0.0.1:8200"
const MAX_PROJECTS = 10
// the correct number of result rows for the 20-file challenge; any project whose
// output differs from this is flagged red in the Result column.
const EXPECTED_ROWS = 57099
// the ObjectScript command each run executes in the container (editable per project)
const DEFAULT_COMMAND = "do ^RunScript"

// Distinct, legible-on-dark palette; index = selection order.
const PALETTE = [
  "#38bdf8", "#f472b6", "#a3e635", "#fbbf24", "#c084fc",
  "#34d399", "#fb7185", "#60a5fa", "#facc15", "#2dd4bf",
]

interface RunResult {
  project: string
  total_rows: number
  columns: string[]
  rows: string[][]
}

interface BenchStats {
  run: number
  total: number
  min: number
  max: number
  mean: number
  median: number
  histogram: Bin[]
}

// source_id (column 0) is a 64-bit id that overflows JS numbers -> compare as BigInt.
function compareCells(a: string, b: string, col: number): number {
  if (col === 0) {
    const x = a === "" ? 0n : BigInt(a)
    const y = b === "" ? 0n : BigInt(b)
    return x < y ? -1 : x > y ? 1 : 0
  }
  const x = a === "" ? NaN : Number(a)
  const y = b === "" ? NaN : Number(b)
  if (isNaN(x) && isNaN(y)) return 0
  if (isNaN(x)) return 1
  if (isNaN(y)) return -1
  return x - y
}

function fmtFlux(v: string) {
  if (v === "" || v == null) return "—"
  const n = Number(v)
  if (!isFinite(n)) return v
  return Math.abs(n) >= 1e6 || (Math.abs(n) > 0 && Math.abs(n) < 1e-3)
    ? n.toExponential(3)
    : n.toLocaleString(undefined, { maximumFractionDigits: 3 })
}

interface Proj {
  folder: string // identity — drives the container name; immutable
  label: string // editable display title
  enabled: boolean // selected to run the benchmark on
  visible: boolean // shown in the comparison histogram
  lines: number // lines of code in the project's src/
  chars: number // characters of code in the project's src/
  container?: string // docker container the project runs in
  url?: string // source GitHub URL (shown alongside a renamed project)
  command: string // ObjectScript command the run/benchmark executes
  warnings?: string[] // reasons the project can't run (shown on hover)
  pending?: boolean // true while a clone is still cloning/building
}


export default function App() {
  // projects the user has cloned (each a repo with a docker-compose file)
  const [projects, setProjects] = useState<Proj[]>([])
  const [runs, setRuns] = useState(1)
  const { toast } = useToast()

  const selected = projects.map((p) => p.folder) // convenience: ordered folders

  // multi-run benchmark: per-project live stats, and whether a benchmark is active
  const [bench, setBench] = useState<Record<string, BenchStats>>({})
  const [benching, setBenching] = useState(false)
  // folders in the current run, captured at click time so the table + (empty)
  // chart render immediately at 0/N — before the first result arrives.
  const [runningFolders, setRunningFolders] = useState<string[]>([])
  const streamsRef = useRef<EventSource[]>([])

  // GitHub-clone column state
  const [repoUrl, setRepoUrl] = useState("")
  // clones in flight — placeholder rows carry pending:true
  const anyCloning = projects.some((p) => p.pending)

  // settings overlay: the folder whose settings pane is open (or null)
  const [settingsFolder, setSettingsFolder] = useState<string | null>(null)

  // result-CSV overlay: the project whose result table is open, its fetched data,
  // and whether the fetch is in flight. `resultRows` caches each project's row
  // count (fetched when its benchmark completes) for the Result column link.
  const [resultPane, setResultPane] = useState<{ folder: string; label: string } | null>(null)
  const [resultData, setResultData] = useState<RunResult | null>(null)
  const [resultLoading, setResultLoading] = useState(false)
  const [resultRows, setResultRows] = useState<Record<string, number>>({})

  async function fetchRowCount(folder: string) {
    try {
      const res = await fetch(`${API}/result?project=${encodeURIComponent(folder)}`)
      if (!res.ok) return
      const data = await res.json()
      setResultRows((cur) => ({ ...cur, [folder]: data.total_rows }))
    } catch { /* leave uncounted; the link falls back to "view" */ }
  }

  async function openResult(folder: string, label: string) {
    setResultPane({ folder, label })
    setResultData(null)
    setResultLoading(true)
    try {
      const res = await fetch(`${API}/result?project=${encodeURIComponent(folder)}`)
      if (!res.ok) throw new Error(`server returned ${res.status}`)
      setResultData(await res.json())
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not load result")
      setResultPane(null)
    } finally {
      setResultLoading(false)
    }
  }

  // color is keyed to the folder's position, stable across renames
  const colorOf = (folder: string) => PALETTE[selected.indexOf(folder) % PALETTE.length]

  // derive the repo (folder) name from a GitHub URL — matches the backend, which
  // clones into a directory named after the repo. Lenient: accepts optional
  // scheme/www, SSH form, and ignores any trailing path/query/fragment
  // (e.g. /tree/main), so only owner/repo need be present.
  function repoNameFromUrl(url: string): string | null {
    const m = url
      .trim()
      .match(/(?:github\.com[/:])([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i)
    return m ? m[2] : null
  }

  // clone a public GitHub repo. A placeholder row is added immediately so the
  // clone/build runs in the background while the user keeps adding projects.
  // On success the row fills in; on failure it's removed with a toast.
  async function cloneRepo() {
    const url = repoUrl.trim()
    if (!url) return
    const name = repoNameFromUrl(url)
    if (!name) {
      toast("Not a GitHub repo URL (expected github.com/owner/repo).")
      return
    }
    if (selected.includes(name)) {
      toast(`"${name}" is already added.`)
      return
    }
    if (projects.length >= MAX_PROJECTS) {
      toast(`At most ${MAX_PROJECTS} projects can be compared at once.`)
      return
    }

    // normalize to a canonical https URL for display
    const displayUrl = url.replace(/\.git\/?$/, "").replace(/\/$/, "")

    // add the pending placeholder row and clear the field right away
    setProjects((cur) => [
      ...cur,
      { folder: name, label: name, enabled: false, visible: true, lines: 0, chars: 0, url: displayUrl, command: DEFAULT_COMMAND, pending: true },
    ])
    setRepoUrl("")

    try {
      const res = await fetch(`${API}/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      })
      if (!res.ok) {
        let detail = `clone failed (${res.status})`
        try {
          detail = (await res.json()).detail || detail
        } catch { /* keep default */ }
        throw new Error(detail)
      }
      const p = await res.json()
      const warnings: string[] = p.warnings ?? []
      // The repo is kept even if it can't run — any problems come back as
      // warnings shown on hover. Only auto-select it if it started AND has no
      // warnings; anything flagged stays unchecked so it's excluded from runs.
      setProjects((cur) =>
        cur.map((row) =>
          row.folder === name
            ? {
                ...row, folder: p.name, label: p.name,
                enabled: !!p.running && warnings.length === 0,
                lines: p.lines ?? 0, chars: p.chars ?? 0, container: p.container,
                warnings, pending: false,
              }
            : row
        )
      )
      // a re-clone rebuilds the container fresh (empty output) — discard any
      // stale results/row counts for this project so it reads "not run yet".
      setBench((prev) => { const n = { ...prev }; delete n[name]; delete n[p.name]; return n })
      setResultRows((prev) => { const n = { ...prev }; delete n[name]; delete n[p.name]; return n })
    } catch (e) {
      // a hard failure (network, git clone, non-public repo) — drop the placeholder
      setProjects((cur) => cur.filter((row) => row.folder !== name))
      toast(e instanceof Error ? e.message : "clone failed")
    }
  }

  function removeProject(folder: string) {
    // drop only the removed folder's results; keep everyone else's
    setBench((prev) => {
      const next = { ...prev }
      delete next[folder]
      return next
    })
    setResultRows((prev) => {
      const next = { ...prev }
      delete next[folder]
      return next
    })
    setProjects((cur) => cur.filter((p) => p.folder !== folder))
    // tear down the container + delete the cloned checkout on the backend
    fetch(`${API}/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: folder }),
    }).catch(() => { /* best-effort; the row is already gone from the UI */ })
  }

  function renameProject(folder: string, label: string) {
    setProjects((cur) => cur.map((p) => (p.folder === folder ? { ...p, label: label || folder } : p)))
  }

  function setProjectCommand(folder: string, command: string) {
    setProjects((cur) => cur.map((p) => (p.folder === folder ? { ...p, command: command || DEFAULT_COMMAND } : p)))
  }

  function toggleVisible(folder: string) {
    setProjects((cur) => cur.map((p) => (p.folder === folder ? { ...p, visible: !p.visible } : p)))
  }

  function toggleEnabled(folder: string) {
    setProjects((cur) =>
      cur.map((p) =>
        // never enable a project that has warnings (it can't run correctly)
        p.folder === folder && !(p.warnings?.length) ? { ...p, enabled: !p.enabled } : p
      )
    )
  }

  function stopAll() {
    streamsRef.current.forEach((es) => es.close())
    streamsRef.current = []
    setBenching(false)
  }

  useEffect(() => () => stopAll(), [])

  // On every page load, sweep evaluator-cloned repos so we start from a clean
  // slate (containers torn down, checkouts deleted). Marker-guarded on the
  // backend, so the user's own projects are never touched.
  useEffect(() => {
    fetch(`${API}/sweep`, { method: "POST" }).catch(() => { /* best-effort */ })
    setProjects([])
    setBench({})
    setResultRows({})
  }, [])

  // a project runs only if selected AND free of warnings (can't-run reasons)
  const enabledFolders = projects
    .filter((p) => p.enabled && !(p.warnings?.length))
    .map((p) => p.folder)

  function startBenchmark(folders: string[]) {
    setRunningFolders(folders)
    // clear only the folders being (re)run — keep results from earlier runs of
    // other projects so the table persists across separate runs.
    setBench((prev) => {
      const next = { ...prev }
      for (const f of folders) delete next[f]
      return next
    })
    setResultRows((prev) => {
      const next = { ...prev }
      for (const f of folders) delete next[f]
      return next
    })
    setBenching(true)
    const streams: EventSource[] = []
    let done = 0
    for (const name of folders) {
      let gotData = false
      const cmd = projects.find((p) => p.folder === name)?.command || DEFAULT_COMMAND
      const es = new EventSource(
        `${API}/benchmark?project=${encodeURIComponent(name)}&runs=${runs}&command=${encodeURIComponent(cmd)}`
      )
      es.onmessage = (e) => {
        const first = !gotData
        gotData = true
        const data = JSON.parse(e.data) as BenchStats
        setBench((prev) => ({ ...prev, [name]: data }))
        // the result CSV exists after the very first pass — fetch its row count
        // then so the Result link is usable without waiting for all runs.
        if (first) fetchRowCount(name)
      }
      es.addEventListener("done", () => {
        es.close()
        if (++done === streams.length) setBenching(false)
      })
      // backend-reported per-run failure (container gone, bad command, etc.)
      es.addEventListener("error", (e) => {
        es.close()
        let detail = `Run failed for "${name}".`
        try {
          const d = JSON.parse((e as MessageEvent).data)
          if (d?.detail) detail = `"${name}": ${d.detail}`
        } catch { /* not a data-bearing error event */ }
        toast(detail)
        if (++done === streams.length) setBenching(false)
      })
      es.onerror = () => {
        es.close()
        // a stream that dies before delivering any data (and without an explicit
        // error event) is a transport-level failure
        if (!gotData) toast(`Benchmark failed for "${name}" — check the backend and container.`)
        if (++done === streams.length) setBenching(false)
      }
      streams.push(es)
    }
    streamsRef.current = streams
  }

  // Every run — even a single pass of one project — goes through the benchmark
  // path, so the stats table + histogram always render and each project's result
  // CSV is reached via the Result column. `runs === 1` just streams one sample.
  function handleRun() {
    if (enabledFolders.length === 0) return
    startBenchmark(enabledFolders)
  }

  const busy = benching
  const canRun = enabledFolders.length > 0 && !busy

  // projects shown in the comparison view: those with results (persist across
  // separate runs, even if later unselected) plus any in the current run — the
  // latter so the table + chart appear immediately at 0/N before results land.
  const benchedProjects = projects.filter((p) => bench[p.folder] || runningFolders.includes(p.folder))

  // build histogram series for benched + visible projects
  const series: Series[] = useMemo(
    () =>
      benchedProjects
        .filter((p) => p.visible)
        .map((p) => ({ name: p.label, color: colorOf(p.folder), bins: bench[p.folder]?.histogram ?? [] }))
        .filter((s) => s.bins.length > 0),
    [projects, bench, runningFolders]
  )
  const anyBench = benchedProjects.length > 0

  // a project in the current run is "still running" until its live run count
  // reaches the total (or before its first result arrives).
  const isRunning = (folder: string) => {
    if (!benching || !runningFolders.includes(folder)) return false
    const b = bench[folder]
    return !b || b.run < b.total
  }

  return (
    <div className="min-h-screen w-full">
      <div className="mx-auto max-w-6xl px-6 py-10">
        {/* header */}
        <header className="mb-8">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/30">
              <Database className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                InterSystems Programming Challenge: <span className="text-primary">GAIA</span>
              </h1>
              <p className="text-sm text-muted-foreground">
                Gaia DR3 BP/RP flux variability &mdash; sources whose brightness changed by more than 100%
              </p>
            </div>
          </div>
        </header>

        {/* controls */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="flex flex-col gap-5">
              {/* project picker: added projects (left) + add-by-source (right) */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-sm font-medium">
                    Projects{" "}
                    <span className="text-muted-foreground">
                      ({selected.length}/{MAX_PROJECTS})
                    </span>
                  </label>
                </div>
                {/* full-width list of added projects */}
                {projects.length > 0 && (
                  <div className="mb-4 flex flex-col gap-2">
                    {projects.map((p) => (
                      <ProjectRow
                        key={p.folder}
                        proj={p}
                        color={colorOf(p.folder)}
                        disabled={busy}
                        onToggleEnabled={() => toggleEnabled(p.folder)}
                        onRename={(label) => renameProject(p.folder, label)}
                        onRemove={() => removeProject(p.folder)}
                        onOpenSettings={() => setSettingsFolder(p.folder)}
                      />
                    ))}
                  </div>
                )}

                {/* add a project by cloning a public GitHub repo */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="url"
                      value={repoUrl}
                      disabled={busy}
                      placeholder="https://github.com/owner/repo"
                      onChange={(e) => setRepoUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") cloneRepo()
                      }}
                      className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                    />
                    <button
                      onClick={cloneRepo}
                      disabled={busy || !repoUrl.trim() || projects.length >= MAX_PROJECTS}
                      title="clone & add repository"
                      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {anyCloning
                      ? "Cloning in the background — you can add more while it builds."
                      : "Paste a public GitHub repo URL to clone, build, and add it."}
                  </p>
                </div>
              </div>

              {/* runs + run button */}
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <label className="mb-2 block text-sm font-medium">Runs per project</label>
                  <RunsInput value={runs} onChange={setRuns} disabled={busy} />
                </div>
                <div className="flex gap-2">
                  <Button size="lg" onClick={handleRun} disabled={!canRun}>
                    {busy ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Running…
                      </>
                    ) : (
                      <>
                        <Play className="h-4 w-4" />
                        {runs > 1 ? `Run ×${runs}` : "Run"}
                      </>
                    )}
                  </Button>
                  {benching && (
                    <Button variant="outline" size="lg" onClick={stopAll}>
                      <Square className="h-4 w-4" /> Stop
                    </Button>
                  )}
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                {runs > 1
                  ? `Runs each selected project ${runs}× and overlays their run-time distributions.`
                  : "Runs each selected project once and shows its timing and result."}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* comparison view (multi-project or runs > 1) */}
        {anyBench && (
          <div className="flex flex-col gap-6">
            {/* per-project stats table */}
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-3 font-medium">Project</th>
                        <th className="px-3 py-3 text-right font-medium text-yellow-400">Min</th>
                        <th className="px-3 py-3 text-right font-medium text-yellow-400">Max</th>
                        <th className="px-3 py-3 text-right font-medium text-yellow-400">Mean</th>
                        <th className="px-3 py-3 text-right font-medium text-yellow-400">Median</th>
                        <th className="px-3 py-3 text-right font-medium text-sky-400">Lines</th>
                        <th className="px-3 py-3 text-right font-medium text-sky-400">Characters</th>
                        <th className="px-4 py-3 text-right font-medium text-emerald-400">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {projects
                        .filter((p) => p.enabled || bench[p.folder] || runningFolders.includes(p.folder))
                        .map((p) => {
                          const b = bench[p.folder]
                          const running = isRunning(p.folder)
                          // count to show: live from data, else 0/N while queued
                          const counter = b
                            ? `${b.run}/${b.total}`
                            : runningFolders.includes(p.folder)
                            ? `0/${runs}`
                            : null
                          return (
                            <tr key={p.folder} className="border-b last:border-0">
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2">
                                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                                    {running ? (
                                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                    ) : (
                                      <span
                                        className="h-3 w-3 rounded-sm"
                                        style={{ backgroundColor: colorOf(p.folder) }}
                                      />
                                    )}
                                  </span>
                                  <span className="truncate font-medium">{p.label}</span>
                                  {counter && (
                                    <span className="text-xs text-muted-foreground">{counter}</span>
                                  )}
                                </div>
                              </td>
                              <TimeCell value={b?.min} />
                              <TimeCell value={b?.max} />
                              <TimeCell value={b?.mean} />
                              <TimeCell value={b?.median} />
                              <td className="px-3 py-3 text-right font-mono tabular-nums text-sky-400">
                                {p.lines.toLocaleString()}
                              </td>
                              <td className="px-3 py-3 text-right font-mono tabular-nums text-sky-400">
                                {p.chars.toLocaleString()}
                              </td>
                              <td className="px-4 py-3 text-right">
                                {resultRows[p.folder] ? (
                                  <button
                                    onClick={() => openResult(p.folder, p.label)}
                                    title={
                                      resultRows[p.folder] === EXPECTED_ROWS
                                        ? "view result rows"
                                        : `expected ${EXPECTED_ROWS.toLocaleString()} rows`
                                    }
                                    className={cn(
                                      "font-mono tabular-nums underline decoration-dotted underline-offset-2",
                                      resultRows[p.folder] === EXPECTED_ROWS
                                        ? "text-emerald-400 hover:text-emerald-300"
                                        : "text-red-400 hover:text-red-300"
                                    )}
                                  >
                                    {resultRows[p.folder].toLocaleString()}
                                  </button>
                                ) : b ? (
                                  <span className="text-muted-foreground">…</span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            {/* overlaid histogram + legend with visibility checkboxes */}
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-col gap-3 text-base sm:flex-row sm:items-center sm:justify-between">
                  <span>Distribution of run times</span>
                  <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs font-normal">
                    {benchedProjects.map((p) => (
                      <div
                        key={p.folder}
                        className="inline-flex select-none items-center gap-1.5"
                      >
                        <Checkbox
                          checked={p.visible}
                          onCheckedChange={() => toggleVisible(p.folder)}
                          color={colorOf(p.folder)}
                          title={p.visible ? "hide from chart" : "show in chart"}
                        />
                        <button
                          onClick={() => toggleVisible(p.folder)}
                          className={cn(
                            "cursor-pointer",
                            p.visible ? "text-foreground" : "text-muted-foreground line-through"
                          )}
                        >
                          {p.label}
                        </button>
                      </div>
                    ))}
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <MultiHistogram series={series} />
              </CardContent>
            </Card>
          </div>
        )}

        {!busy && !anyBench && (
          <p className="text-center text-sm text-muted-foreground">
            Add one or more projects, check the ones to run, set the run count, and press Run.
          </p>
        )}
      </div>

      {/* result-CSV overlay pane */}
      {resultPane && (
        <div
          className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:p-8"
          onClick={() => setResultPane(null)}
        >
          <div
            className="relative w-full max-w-6xl rounded-xl border border-border bg-card p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between gap-4">
              <h2 className="text-lg font-semibold">
                Result &mdash; <span className="text-emerald-400">{resultPane.label}</span>
              </h2>
              <button
                onClick={() => setResultPane(null)}
                aria-label="close"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {resultLoading || !resultData ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> loading result…
              </div>
            ) : (
              <ResultsTable result={resultData} />
            )}
          </div>
        </div>
      )}

      {/* per-project settings overlay */}
      {settingsFolder && (() => {
        const proj = projects.find((p) => p.folder === settingsFolder)
        if (!proj) return null
        return (
          <div
            className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:p-8"
            onClick={() => setSettingsFolder(null)}
          >
            <div
              className="relative mt-16 w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-center justify-between gap-4">
                <h2 className="text-lg font-semibold">
                  Settings &mdash; <span className="text-primary">{proj.label}</span>
                </h2>
                <button
                  onClick={() => setSettingsFolder(null)}
                  aria-label="close"
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <label className="mb-2 block text-sm font-medium">Run command</label>
              <input
                type="text"
                value={proj.command}
                spellCheck={false}
                onChange={(e) => setProjectCommand(proj.folder, e.target.value)}
                placeholder={DEFAULT_COMMAND}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                The ObjectScript command executed in the container on each run. Defaults to{" "}
                <code className="text-primary">{DEFAULT_COMMAND}</code>.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setProjectCommand(proj.folder, DEFAULT_COMMAND)}
                >
                  Reset
                </Button>
                <Button onClick={() => setSettingsFolder(null)}>Done</Button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// Amber warning icon with a hover tooltip listing why a project can't run.
function WarningBadge({ warnings }: { warnings: string[] }) {
  const [show, setShow] = useState(false)
  return (
    <span
      className="relative flex shrink-0"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <AlertTriangle className="h-4 w-4 text-amber-400" />
      {show && (
        <div className="absolute left-0 top-full z-20 mt-1.5 w-80 max-w-[80vw] rounded-md border border-amber-500/40 bg-card p-3 text-left shadow-xl">
          <div className="mb-1.5 text-xs font-semibold text-amber-400">
            Cannot run ({warnings.length} {warnings.length === 1 ? "reason" : "reasons"})
          </div>
          <ul className="space-y-2">
            {warnings.map((w, i) => (
              <li key={i} className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted-foreground">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  )
}

function ProjectRow({
  proj,
  color,
  disabled,
  onToggleEnabled,
  onRename,
  onRemove,
  onOpenSettings,
}: {
  proj: Proj
  color: string
  disabled?: boolean
  onToggleEnabled: () => void
  onRename: (label: string) => void
  onRemove: () => void
  onOpenSettings: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(proj.label)

  useEffect(() => setDraft(proj.label), [proj.label])

  function commit() {
    onRename(draft.trim())
    setEditing(false)
  }

  // still cloning/building: show a spinner + status; only removal is allowed
  if (proj.pending) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-dashed border-input bg-background px-3 py-2">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        <span className="truncate text-sm font-medium">{proj.label}</span>
        <span className="flex-1 truncate text-xs text-muted-foreground">cloning &amp; building…</span>
        <button
          onClick={onRemove}
          title="cancel"
          className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    )
  }

  const hasWarnings = (proj.warnings?.length ?? 0) > 0
  return (
    <div className="flex items-center gap-3 rounded-md border border-input bg-background px-3 py-2">
      <Checkbox
        checked={proj.enabled}
        disabled={disabled || hasWarnings}
        onCheckedChange={onToggleEnabled}
        color={color}
        title={hasWarnings ? "cannot run — see warning" : proj.enabled ? "selected to run" : "not selected"}
      />
      {hasWarnings ? (
        <WarningBadge warnings={proj.warnings!} />
      ) : (
        <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
      )}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit()
            if (e.key === "Escape") {
              setDraft(proj.label)
              setEditing(false)
            }
          }}
          className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-0.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      ) : (
        <button
          onClick={() => !disabled && setEditing(true)}
          disabled={disabled}
          title="click to rename"
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium disabled:opacity-60"
        >
          <span className="truncate">{proj.label}</span>
          <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      )}
      {proj.container && (
        <span
          title={`container: ${proj.container}`}
          className="hidden shrink-0 truncate rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-muted-foreground sm:inline"
        >
          {proj.container}
        </span>
      )}
      {proj.url && (
        <a
          href={proj.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={proj.url}
          className="hidden max-w-[16rem] shrink-0 truncate text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground sm:inline"
        >
          {proj.url.replace(/^https?:\/\//, "")}
        </a>
      )}
      <button
        onClick={onOpenSettings}
        disabled={disabled}
        title="settings"
        className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
      >
        <Settings className="h-4 w-4" />
      </button>
      <button
        onClick={onRemove}
        disabled={disabled}
        title="remove"
        className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

function TimeCell({ value }: { value?: number }) {
  return (
    <td className="px-3 py-3 text-right font-mono tabular-nums text-yellow-400">
      {value == null ? <span className="text-muted-foreground">—</span> : `${value.toFixed(3)}s`}
    </td>
  )
}

function ResultsTable({ result }: { result: RunResult }) {
  const MAX_PAGE_SIZE = 1000
  const [sortCol, setSortCol] = useState(5)
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")
  const [pageSize, setPageSize] = useState(100)
  const [page, setPage] = useState(0)
  const [editingLimit, setEditingLimit] = useState(false)

  const sortedRows = useMemo(() => {
    const rows = [...result.rows]
    rows.sort((a, b) => {
      const c = compareCells(a[sortCol], b[sortCol], sortCol)
      return sortDir === "asc" ? c : -c
    })
    return rows
  }, [result, sortCol, sortDir])

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize))
  const currentPage = Math.min(page, totalPages - 1)
  const pageStart = currentPage * pageSize
  const shownRows = sortedRows.slice(pageStart, pageStart + pageSize)

  function setPageSizeClamped(n: number) {
    setPageSize(Math.max(1, Math.min(n, MAX_PAGE_SIZE)))
    setPage(0)
  }
  function toggleSort(col: number) {
    if (col === sortCol) setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    else {
      setSortCol(col)
      setSortDir("desc")
    }
    setPage(0)
  }

  const mismatch = result.total_rows !== EXPECTED_ROWS
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Results</span>
            <span className="text-sm font-normal text-muted-foreground">
              {editingLimit ? (
                <span className="inline-flex items-center overflow-hidden rounded-md border border-input bg-background align-middle focus-within:ring-2 focus-within:ring-ring">
                  <input
                    autoFocus
                    type="text"
                    inputMode="numeric"
                    value={pageSize}
                    onChange={(e) => {
                      const n = parseInt(e.target.value.replace(/[^\d]/g, ""), 10)
                      if (!isNaN(n)) setPageSizeClamped(n)
                    }}
                    onBlur={() => setEditingLimit(false)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === "Escape") setEditingLimit(false)
                    }}
                    className="w-14 bg-transparent px-2 py-0.5 text-center font-semibold text-primary outline-none"
                  />
                  <span className="flex flex-col border-l border-input">
                    <button
                      type="button"
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setPageSizeClamped(pageSize + 10)}
                      className="flex h-[13px] items-center justify-center px-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      <ChevronUp className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setPageSizeClamped(pageSize - 10)}
                      className="flex h-[13px] items-center justify-center border-t border-input px-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </span>
                </span>
              ) : (
                <button
                  onClick={() => setEditingLimit(true)}
                  title="rows per page — click to edit (max 1000)"
                  className="font-semibold text-primary underline decoration-dotted underline-offset-4 hover:decoration-solid"
                >
                  {pageSize}
                </button>
              )}{" "}
              rows/page ·{" "}
              <span
                className={cn("font-semibold", mismatch ? "text-red-400" : "text-foreground")}
                title={mismatch ? `expected ${EXPECTED_ROWS.toLocaleString()} rows` : undefined}
              >
                {result.total_rows.toLocaleString()}
              </span>{" "}
              total{mismatch && ` (expected ${EXPECTED_ROWS.toLocaleString()})`}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-secondary/50 text-left text-muted-foreground">
                  {result.columns.map((c, j) => (
                    <th key={c} className="px-3 py-2 font-medium">
                      <button
                        onClick={() => toggleSort(j)}
                        className="inline-flex items-center gap-1 hover:text-foreground"
                      >
                        {c}
                        {sortCol === j ? (
                          sortDir === "asc" ? (
                            <ArrowUp className="h-3.5 w-3.5 text-primary" />
                          ) : (
                            <ArrowDown className="h-3.5 w-3.5 text-primary" />
                          )
                        ) : (
                          <ChevronsUpDown className="h-3.5 w-3.5 opacity-30" />
                        )}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownRows.map((row, i) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-secondary/30">
                    {row.map((cell, j) => (
                      <td key={j} className="px-3 py-1.5 font-mono text-xs">
                        {j === 0 ? cell : fmtFlux(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <span>
              rows {sortedRows.length === 0 ? 0 : pageStart + 1}&ndash;
              {pageStart + shownRows.length} of {sortedRows.length.toLocaleString()}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={currentPage === 0}
              >
                <ChevronLeft className="h-4 w-4" /> Prev
              </Button>
              <span className="min-w-[6rem] text-center">
                Page {currentPage + 1} of {totalPages}
              </span>
              <Button
                variant="outline"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={currentPage >= totalPages - 1}
              >
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  )
}

