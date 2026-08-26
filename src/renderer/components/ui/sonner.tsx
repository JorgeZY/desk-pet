"use client"

import type { CSSProperties } from "react"
import { CheckCircle2, CircleAlert, Info, LoaderCircle, TriangleAlert } from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      closeButton
      duration={3200}
      icons={{
        success: <CheckCircle2 className="size-4" />,
        info: <Info className="size-4" />,
        warning: <TriangleAlert className="size-4" />,
        error: <CircleAlert className="size-4" />,
        loading: <LoaderCircle className="size-4 animate-spin" />,
      }}
      position="bottom-right"
      style={{
        "--normal-bg": "var(--ui-popover)",
        "--normal-text": "var(--ui-popover-foreground)",
        "--normal-border": "var(--ui-border)",
        "--border-radius": "var(--ui-radius)",
      } as CSSProperties}
      toastOptions={{
        classNames: {
          toast: "font-sans shadow-[var(--ui-surface-shadow)]",
          title: "text-sm font-semibold",
          description: "text-xs text-muted-foreground",
          closeButton: "border-border bg-card text-foreground hover:bg-accent",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
