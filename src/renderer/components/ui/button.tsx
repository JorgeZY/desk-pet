import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent bg-transparent text-sm font-semibold whitespace-nowrap transition-[transform,box-shadow,background-color,border-color,color,opacity] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:translate-y-0 disabled:opacity-50 disabled:shadow-none aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-primary/70 bg-primary text-primary-foreground shadow-[inset_0_1px_0_var(--ui-control-highlight),0_2px_0_var(--ui-control-shadow)] hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-[inset_0_1px_0_var(--ui-control-highlight),0_3px_0_var(--ui-control-shadow-hover)] active:translate-y-px active:scale-[0.985] active:shadow-[inset_0_1px_0_var(--ui-control-highlight),0_1px_0_var(--ui-control-shadow)]",
        destructive:
          "border-destructive/75 bg-destructive text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_2px_0_rgba(105,30,20,0.28)] hover:-translate-y-0.5 hover:bg-destructive/90 active:translate-y-px active:scale-[0.985] active:shadow-[0_1px_0_rgba(105,30,20,0.24)] focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border-[var(--ui-control-border)] bg-card text-foreground shadow-[inset_0_1px_0_var(--ui-control-highlight),0_2px_0_var(--ui-control-shadow)] hover:-translate-y-0.5 hover:bg-accent hover:text-accent-foreground hover:shadow-[inset_0_1px_0_var(--ui-control-highlight),0_3px_0_var(--ui-control-shadow-hover)] active:translate-y-px active:scale-[0.985] active:shadow-[0_1px_0_var(--ui-control-shadow)] dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "border-[var(--ui-control-border)] bg-secondary text-secondary-foreground shadow-[inset_0_1px_0_var(--ui-control-highlight),0_2px_0_var(--ui-control-shadow)] hover:-translate-y-0.5 hover:bg-secondary/80 hover:shadow-[inset_0_1px_0_var(--ui-control-highlight),0_3px_0_var(--ui-control-shadow-hover)] active:translate-y-px active:scale-[0.985] active:shadow-[0_1px_0_var(--ui-control-shadow)]",
        soft:
          "border-transparent bg-transparent text-muted-foreground shadow-none hover:-translate-y-0.5 hover:border-primary/35 hover:bg-secondary hover:text-secondary-foreground hover:shadow-[inset_0_1px_0_var(--ui-control-highlight),0_3px_0_var(--ui-control-shadow-hover)] active:translate-y-px active:scale-[0.985] active:shadow-[inset_0_1px_0_var(--ui-control-highlight),0_1px_0_var(--ui-control-shadow)] data-[active=true]:border-primary/40 data-[active=true]:bg-secondary data-[active=true]:text-primary data-[active=true]:shadow-[inset_0_1px_0_var(--ui-control-highlight),0_2px_0_var(--ui-control-shadow)] data-[state=open]:border-primary/40 data-[state=open]:bg-secondary data-[state=open]:text-primary data-[state=open]:shadow-[inset_0_1px_0_var(--ui-control-highlight),0_2px_0_var(--ui-control-shadow)]",
        ghost:
          "font-medium shadow-none hover:bg-accent hover:text-accent-foreground active:scale-[0.98] active:bg-accent/80 dark:hover:bg-accent/50",
        link: "border-0 text-primary shadow-none underline-offset-4 hover:underline active:scale-[0.99]",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
