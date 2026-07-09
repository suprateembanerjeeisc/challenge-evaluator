import { useState, useMemo, useRef, useEffect } from "react"
import {
  Play, Loader2, Timer, Database, Rocket, ArrowUp, ArrowDown, ChevronsUpDown,
  ChevronLeft, ChevronRight, Square, FolderOpen, X, Pencil,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import { MultiHistogram, type Bin, type Series } from "@/components/MultiHistogram"
import { RunsInput } from "@/components/RunsInput"

const API = "http://127.0.0.1:8200"
const MAX_PROJECTS = 10

// Distinct, legible-on-dark palette; index = selection order.
const PALETTE = [
  "#38bdf8", "#f472b6", "#a3e635", "#fbbf24", "#c084fc",
  "#34d399", "#fb7185", "#60a5fa", "#facc15", "#2dd4bf",
]

// allow the non-standard directory-picker attributes on <input>
declare module "react" {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string
    directory?: string
  }
}

interface RunResult {
  project: string
  elapsed_seconds: number
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
}

// count visual lines the way `wc`-style tools report displayed lines: newlines
// plus a trailing partial line if the file doesn't end in one.
function countLines(text: string): number {
  if (!text) return 0
  const nl = (text.match(/\n/g) || []).length
  return nl + (text.endsWith("\n") ? 0 : 1)
}

// what counts toward the codebase size: every code file under src/, excluding
// only the fixed RunScript.mac harness (identical boilerplate in every project,
// not part of the scored solution), plus non-code noise — compiled/binary
// artifacts, editor/OS junk (.DS_Store, dotfiles), and build caches.
function isSourceFile(relPath: string): boolean {
  const name = relPath.split("/").pop() || ""
  if (name.startsWith(".")) return false // .DS_Store and other dotfiles
  if (/(^|\/)__pycache__(\/|$)/.test(relPath)) return false
  if (/(^|\/)runscript(\.mac)?$/i.test(relPath)) return false
  return !/\.(so|pyc|pyo|o|a|dll|dylib|bin|png|jpg|jpeg|gif|ico|zip|gz)$/i.test(relPath)
}

export default function App() {
  // projects the user has opened (each validated to contain a RunScript)
  const [projects, setProjects] = useState<Proj[]>([])
  const [runs, setRuns] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)

  const selected = projects.map((p) => p.folder) // convenience: ordered folders

  // single-run table result (only when exactly one project × runs === 1)
  const [result, setResult] = useState<RunResult | null>(null)
  const [loading, setLoading] = useState(false)

  // multi-run benchmark: per-project live stats, and whether a benchmark is active
  const [bench, setBench] = useState<Record<string, BenchStats>>({})
  const [benching, setBenching] = useState(false)
  const streamsRef = useRef<EventSource[]>([])

  // color is keyed to the folder's position, stable across renames
  const colorOf = (folder: string) => PALETTE[selected.indexOf(folder) % PALETTE.length]

  // The browser can't give us an absolute path, but a directory <input> exposes
  // the folder's files via relative paths. We use those to (a) confirm a
  // RunScript is present and (b) read the top-level folder name, which is what
  // docker-compose uses to name the container.
  async function onFolderChosen(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null)
    const files = Array.from(e.target.files ?? [])
    e.target.value = "" // allow re-selecting the same folder later
    if (files.length === 0) return

    const firstPath = files[0].webkitRelativePath || files[0].name
    const folder = firstPath.split("/")[0]

    // RunScript lives at <folder>/src/RunScript.mac (case-insensitive match on the name)
    const hasRunScript = files.some((f) =>
      /(^|\/)runscript(\.mac)?$/i.test(f.webkitRelativePath || f.name)
    )
    if (!hasRunScript) {
      setError(`"${folder}" does not contain a RunScript — pick the project folder (the one with src/RunScript.mac).`)
      return
    }
    if (selected.includes(folder)) {
      setError(`"${folder}" is already added.`)
      return
    }
    if (selected.length >= MAX_PROJECTS) {
      setError(`At most ${MAX_PROJECTS} projects can be compared at once.`)
      return
    }

    // confirm the project's IRIS container is actually running
    try {
      const res = await fetch(`${API}/status?project=${encodeURIComponent(folder)}`)
      const st = await res.json()
      if (!st.running) {
        setError(`"${folder}" has a RunScript, but its container (${st.container}) is not running. Start it with \`docker-compose up -d\` in that folder.`)
        return
      }
    } catch {
      setError("could not reach backend — is it running on :8200?")
      return
    }

    // codebase size: count lines + characters across the source files under src/
    let lines = 0
    let chars = 0
    const srcFiles = files.filter((f) => {
      const rel = f.webkitRelativePath || f.name
      return /(^|\/)src\//.test(rel) && isSourceFile(rel)
    })
    await Promise.all(
      srcFiles.map(async (f) => {
        const text = await f.text()
        lines += countLines(text)
        chars += text.length
      })
    )

    // adding a folder doesn't touch existing results — they persist in the table
    setProjects((cur) => [
      ...cur,
      { folder, label: folder, enabled: true, visible: true, lines, chars },
    ])
  }

  function removeProject(folder: string) {
    // drop only the removed folder's results; keep everyone else's
    setBench((prev) => {
      const next = { ...prev }
      delete next[folder]
      return next
    })
    setProjects((cur) => cur.filter((p) => p.folder !== folder))
  }

  function renameProject(folder: string, label: string) {
    setProjects((cur) => cur.map((p) => (p.folder === folder ? { ...p, label: label || folder } : p)))
  }

  function toggleVisible(folder: string) {
    setProjects((cur) => cur.map((p) => (p.folder === folder ? { ...p, visible: !p.visible } : p)))
  }

  function toggleEnabled(folder: string) {
    setProjects((cur) => cur.map((p) => (p.folder === folder ? { ...p, enabled: !p.enabled } : p)))
  }

  function stopAll() {
    streamsRef.current.forEach((es) => es.close())
    streamsRef.current = []
    setBenching(false)
  }

  useEffect(() => () => stopAll(), [])

  const enabledFolders = projects.filter((p) => p.enabled).map((p) => p.folder)

  function startBenchmark(folders: string[]) {
    setResult(null)
    setError(null)
    // clear only the folders being (re)run — keep results from earlier runs of
    // other projects so the table persists across separate runs.
    setBench((prev) => {
      const next = { ...prev }
      for (const f of folders) delete next[f]
      return next
    })
    setBenching(true)
    const streams: EventSource[] = []
    let done = 0
    for (const name of folders) {
      const es = new EventSource(`${API}/benchmark?project=${encodeURIComponent(name)}&runs=${runs}`)
      es.onmessage = (e) => {
        const data = JSON.parse(e.data) as BenchStats
        setBench((prev) => ({ ...prev, [name]: data }))
      }
      es.addEventListener("done", () => {
        es.close()
        if (++done === streams.length) setBenching(false)
      })
      es.onerror = () => {
        es.close()
        if (++done === streams.length) setBenching(false)
      }
      streams.push(es)
    }
    streamsRef.current = streams
  }

  async function runOnce(folder: string) {
    setLoading(true)
    setError(null)
    setResult(null)
    setBench({})
    try {
      const res = await fetch(`${API}/run?project=${encodeURIComponent(folder)}`)
      if (!res.ok) throw new Error(`server returned ${res.status}`)
      setResult(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : "run failed")
    } finally {
      setLoading(false)
    }
  }

  // A single run of a single project shows the results table; anything else
  // (multiple projects, or runs > 1) shows the timing comparison.
  const isComparison = enabledFolders.length > 1 || runs > 1
  function handleRun() {
    if (enabledFolders.length === 0) return
    if (isComparison) startBenchmark(enabledFolders)
    else runOnce(enabledFolders[0])
  }

  const busy = loading || benching
  const canRun = enabledFolders.length > 0 && !busy

  // projects that have benchmark results (persist across separate runs, even if
  // later unselected), in selection order.
  const benchedProjects = projects.filter((p) => bench[p.folder])

  // build histogram series for benched + visible projects
  const series: Series[] = useMemo(
    () =>
      benchedProjects
        .filter((p) => p.visible)
        .map((p) => ({ name: p.label, color: colorOf(p.folder), bins: bench[p.folder]?.histogram ?? [] }))
        .filter((s) => s.bins.length > 0),
    [projects, bench]
  )
  const anyBench = benchedProjects.length > 0

  // a benchmarked project is "still running" until its live run count reaches the total
  const isRunning = (folder: string) => {
    const b = bench[folder]
    return benching && (!b || b.run < b.total)
  }

  return (
    <div className="min-h-screen w-full">
      <div className="mx-auto max-w-5xl px-6 py-10">
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
              {/* folder picker + added projects (one per line, editable titles) */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-sm font-medium">
                    Projects{" "}
                    <span className="text-muted-foreground">
                      ({selected.length}/{MAX_PROJECTS})
                    </span>
                  </label>
                </div>
                <div className="flex flex-col gap-2">
                  {projects.map((p) => (
                    <ProjectRow
                      key={p.folder}
                      proj={p}
                      color={colorOf(p.folder)}
                      disabled={busy}
                      onToggleEnabled={() => toggleEnabled(p.folder)}
                      onRename={(label) => renameProject(p.folder, label)}
                      onRemove={() => removeProject(p.folder)}
                    />
                  ))}
                  <input
                    ref={folderInputRef}
                    type="file"
                    webkitdirectory=""
                    directory=""
                    multiple
                    className="hidden"
                    onChange={onFolderChosen}
                  />
                  <button
                    onClick={() => folderInputRef.current?.click()}
                    disabled={busy || selected.length >= MAX_PROJECTS}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-input px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-40"
                  >
                    <FolderOpen className="h-4 w-4" />
                    Open folder…
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Open a project folder containing <code className="text-primary">src/RunScript.mac</code>. Check the box to include it in the run, click a title to rename it. Add up to {MAX_PROJECTS} to compare.
                </p>
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
                        {isComparison ? `Run ×${runs}` : "Run"}
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
                {isComparison
                  ? `Runs each selected project ${runs}× and overlays their run-time distributions.`
                  : "Runs the selected project once and shows the result rows."}
              </p>
              {error && <p className="text-sm text-red-400">Error: {error}</p>}
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
                        <th className="px-4 py-3 text-right font-medium text-sky-400">Characters</th>
                      </tr>
                    </thead>
                    <tbody>
                      {projects
                        .filter((p) => p.enabled || bench[p.folder])
                        .map((p) => {
                          const b = bench[p.folder]
                          const running = isRunning(p.folder)
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
                                  {b && (
                                    <span className="text-xs text-muted-foreground">
                                      {b.run}/{b.total}
                                    </span>
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
                              <td className="px-4 py-3 text-right font-mono tabular-nums text-sky-400">
                                {p.chars.toLocaleString()}
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

        {/* single-run results table */}
        {result && !anyBench && (
          <ResultsTable result={result} />
        )}

        {!result && !busy && !anyBench && (
          <p className="text-center text-sm text-muted-foreground">
            Open one or more project folders, check the ones to run, set the run count, and press Run.
          </p>
        )}
      </div>
    </div>
  )
}

function ProjectRow({
  proj,
  color,
  disabled,
  onToggleEnabled,
  onRename,
  onRemove,
}: {
  proj: Proj
  color: string
  disabled?: boolean
  onToggleEnabled: () => void
  onRename: (label: string) => void
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(proj.label)

  useEffect(() => setDraft(proj.label), [proj.label])

  function commit() {
    onRename(draft.trim())
    setEditing(false)
  }

  return (
    <div className="flex items-center gap-3 rounded-md border border-input bg-background px-3 py-2">
      <Checkbox
        checked={proj.enabled}
        disabled={disabled}
        onCheckedChange={onToggleEnabled}
        color={color}
        title={proj.enabled ? "selected to run" : "not selected"}
      />
      <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
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
      {proj.label !== proj.folder && (
        <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">{proj.folder}</span>
      )}
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

  return (
    <>
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard icon={Timer} label="Elapsed time" value={`${result.elapsed_seconds}s`} accent />
        <StatCard icon={Database} label="Objects > 100%" value={result.total_rows.toLocaleString()} />
        <StatCard icon={Rocket} label="Project" value={result.project} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Results</span>
            <span className="text-sm font-normal text-muted-foreground">
              {editingLimit ? (
                <input
                  autoFocus
                  type="number"
                  min={1}
                  max={MAX_PAGE_SIZE}
                  defaultValue={pageSize}
                  onBlur={(e) => {
                    const n = parseInt(e.target.value, 10)
                    if (!isNaN(n)) setPageSizeClamped(n)
                    setEditingLimit(false)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur()
                    if (e.key === "Escape") setEditingLimit(false)
                  }}
                  className="w-20 rounded border border-input bg-background px-1 py-0.5 text-center font-semibold text-primary outline-none focus:ring-2 focus:ring-ring"
                />
              ) : (
                <button
                  onClick={() => setEditingLimit(true)}
                  title="rows per page — click to edit (max 1000)"
                  className="font-semibold text-primary underline decoration-dotted underline-offset-4 hover:decoration-solid"
                >
                  {pageSize}
                </button>
              )}{" "}
              rows/page · {result.total_rows.toLocaleString()} total
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

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof Timer
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-5">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-lg ${
            accent ? "bg-primary/15 ring-1 ring-primary/30" : "bg-secondary"
          }`}
        >
          <Icon className={`h-5 w-5 ${accent ? "text-primary" : "text-muted-foreground"}`} />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className={`text-lg font-semibold ${accent ? "text-primary" : ""}`}>{value}</div>
        </div>
      </CardContent>
    </Card>
  )
}
