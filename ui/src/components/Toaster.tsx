import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { X, AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"

export interface Toast {
  id: number
  message: string
  variant: "error" | "info"
}

interface ToastContextValue {
  toast: (message: string, variant?: Toast["variant"]) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>")
  return ctx
}

const AUTO_DISMISS_MS = 8000

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback<ToastContextValue["toast"]>((message, variant = "error") => {
    const id = nextId.current++
    setToasts((cur) => [...cur, { id, message, variant }])
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [onDismiss])

  const isError = toast.variant === "error"
  return (
    <div
      role="alert"
      className={cn(
        "toast-enter pointer-events-auto flex items-start gap-3 rounded-lg border p-4 shadow-lg",
        isError
          ? "border-red-500/40 bg-red-950/80 text-red-100 backdrop-blur"
          : "border-border bg-card text-foreground"
      )}
    >
      <AlertCircle className={cn("mt-0.5 h-5 w-5 shrink-0", isError ? "text-red-400" : "text-primary")} />
      <div className="min-w-0 flex-1 text-sm leading-snug">{toast.message}</div>
      <button
        onClick={onDismiss}
        aria-label="dismiss"
        className="shrink-0 rounded-md p-0.5 text-current/70 transition-colors hover:bg-white/10 hover:text-current"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
