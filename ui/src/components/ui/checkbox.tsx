import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

// shadcn-style checkbox (no Radix dependency): a styled button that toggles.
// When `color` is given, the checked state fills with that color instead of the
// theme primary — used to tint each project by its series color.
export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  color,
  className,
  title,
}: {
  checked: boolean
  onCheckedChange: () => void
  disabled?: boolean
  color?: string
  className?: string
  title?: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={onCheckedChange}
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "border-transparent text-background" : "border-input hover:border-muted-foreground",
        className
      )}
      style={checked ? { backgroundColor: color ?? "hsl(var(--primary))" } : undefined}
    >
      {checked && <Check className="h-3 w-3" strokeWidth={3} />}
    </button>
  )
}
