import { useState } from "react"

export interface Bin {
  lo: number
  hi: number
  count: number
}

export interface Series {
  name: string
  color: string
  bins: Bin[]
}

const WIDTH = 0.05 // bin width (must match the backend's BIN_WIDTH)

// Overlaid run-time histogram for several projects. Bins are laid out on a
// single contiguous grid from the lowest to the highest observed time, so an
// empty bucket between two populated ones still occupies its slot. Runs of
// empty buckets collapse into a dotted connector instead of dead whitespace.
export function MultiHistogram({ series }: { series: Series[] }) {
  const [hover, setHover] = useState<number | null>(null)

  const active = series.filter((s) => s.bins.length > 0)
  if (active.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
        waiting for data…
      </div>
    )
  }

  // contiguous grid of bin lower-bounds from global min..max, stepping by WIDTH
  let lo = Infinity
  let hi = -Infinity
  for (const s of active)
    for (const b of s.bins) {
      lo = Math.min(lo, b.lo)
      hi = Math.max(hi, b.lo)
    }
  const round2 = (x: number) => Math.round(x * 100) / 100
  const grid: number[] = []
  for (let x = lo; x <= hi + 1e-9; x += WIDTH) grid.push(round2(x))

  const countAt = (s: Series, g: number) =>
    s.bins.find((b) => Math.abs(b.lo - g) < 1e-9)?.count ?? 0
  const totalAt = (g: number) => active.reduce((sum, s) => sum + countAt(s, g), 0)

  let maxCount = 1
  for (const g of grid) for (const s of active) maxCount = Math.max(maxCount, countAt(s, g))

  // build render items: a "bar" slot for each populated bucket, and a "gap"
  // connector standing in for one-or-more consecutive empty buckets.
  type Item = { kind: "bar"; g: number } | { kind: "gap"; from: number; to: number; span: number }
  const items: Item[] = []
  let i = 0
  while (i < grid.length) {
    if (totalAt(grid[i]) > 0) {
      items.push({ kind: "bar", g: grid[i] })
      i++
    } else {
      const start = i
      while (i < grid.length && totalAt(grid[i]) === 0) i++
      // only render a connector if it sits between two populated buckets
      if (start > 0 && i < grid.length) {
        items.push({ kind: "gap", from: grid[start], to: grid[i], span: i - start })
      }
    }
  }

  return (
    <div className="relative">
      <div className="flex h-56 items-end gap-1">
        {items.map((it, idx) =>
          it.kind === "gap" ? (
            <div
              key={idx}
              className="flex h-full min-w-[24px] items-end justify-center pb-1"
              style={{ flex: Math.min(it.span, 3) }}
              title={`${it.from.toFixed(2)}–${it.to.toFixed(2)}s · empty`}
            >
              <div className="w-full border-t-2 border-dotted border-muted-foreground/40" />
            </div>
          ) : (
            <BarGroup
              key={idx}
              g={it.g}
              active={active}
              countAt={countAt}
              maxCount={maxCount}
              hover={hover === idx}
              onEnter={() => setHover(idx)}
              onLeave={() => setHover(null)}
            />
          )
        )}
      </div>
      {/* x-axis: first and last populated bounds */}
      <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
        <span>{lo.toFixed(2)}s</span>
        <span>{round2(hi + WIDTH).toFixed(2)}s</span>
      </div>
    </div>
  )
}

function BarGroup({
  g,
  active,
  countAt,
  maxCount,
  hover,
  onEnter,
  onLeave,
}: {
  g: number
  active: Series[]
  countAt: (s: Series, g: number) => number
  maxCount: number
  hover: boolean
  onEnter: () => void
  onLeave: () => void
}) {
  return (
    <div
      className="group relative flex flex-1 items-end justify-center gap-[2px]"
      style={{ height: "100%", minWidth: 10 }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {active.map((s, si) => {
        const c = countAt(s, g)
        const h = (c / maxCount) * 100
        return (
          <div
            key={si}
            className="flex-1 rounded-t transition-all duration-150"
            style={{
              height: `${h}%`,
              minHeight: c > 0 ? 2 : 0,
              backgroundColor: s.color,
              opacity: hover ? 1 : 0.82,
            }}
          />
        )
      })}
      {hover && (
        <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-lg">
          <div className="mb-1 font-medium">
            {g.toFixed(2)}–{(g + WIDTH).toFixed(2)}s
          </div>
          {active.map((s, si) => (
            <div key={si} className="flex items-center gap-1.5 text-muted-foreground">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: s.color }} />
              <span className="text-foreground">{countAt(s, g)}</span>
              <span>{s.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
