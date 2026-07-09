import { useEffect, useRef, useState } from "react"
import { ChevronDown, Check } from "lucide-react"
import { cn } from "@/lib/utils"

const PRESETS = [1, 10, 50, 100, 500, 1000, 2000, 5000]

// shadcn-style combobox for the run count: a text field you can type into, plus
// a dropdown of common presets. No native spinner buttons.
export function RunsInput({
  value,
  onChange,
  disabled,
}: {
  value: number
  onChange: (n: number) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(String(value))
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => setText(String(value)), [value])

  // close on outside click
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  function commit(raw: string) {
    const n = Math.max(1, Math.min(5000, parseInt(raw, 10) || 1))
    onChange(n)
    setText(String(n))
  }

  return (
    <div ref={wrapRef} className="relative w-40">
      <div
        className={cn(
          "flex items-center rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring",
          disabled && "opacity-50"
        )}
      >
        <input
          type="text"
          inputMode="numeric"
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ""))}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit((e.target as HTMLInputElement).value)
              setOpen(false)
            }
            if (e.key === "ArrowDown") setOpen(true)
          }}
          className="w-full bg-transparent px-3 py-2 text-sm outline-none"
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          className="flex h-full items-center px-2 text-muted-foreground hover:text-foreground"
          tabIndex={-1}
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-card p-1 shadow-lg">
          {PRESETS.map((n) => (
            <button
              key={n}
              onClick={() => {
                commit(String(n))
                setOpen(false)
              }}
              className={cn(
                "flex w-full items-center justify-between rounded-sm px-3 py-1.5 text-sm hover:bg-secondary",
                n === value && "text-primary"
              )}
            >
              {n === 1 ? "1 run" : `${n.toLocaleString()} runs`}
              {n === value && <Check className="h-3.5 w-3.5" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
