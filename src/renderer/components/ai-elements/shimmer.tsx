"use client";

import { cn } from "@/lib/utils";
import type { CSSProperties, ElementType } from "react";
import { memo } from "react";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  baseColor?: string;
  className?: string;
  duration?: number;
  highlightColor?: string;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  baseColor = "var(--color-muted-foreground)",
  className,
  duration = 2,
  highlightColor = "var(--color-background)",
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = (children?.length ?? 0) * spread;

  return (
    <Component
      className={cn(
        "shimmer relative inline-block",
        className
      )}
      data-slot="shimmer"
      style={
        {
          "--shimmer-color": highlightColor,
          "--shimmer-duration": `${duration}s`,
          "--shimmer-spread": `${dynamicSpread}px`,
          color: baseColor,
        } as CSSProperties
      }
    >
      {children}
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
