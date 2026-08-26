import { LoaderIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Spinner({
  className,
  ...props
}: React.ComponentProps<"svg">) {
  return (
    <LoaderIcon
      aria-label="加载中"
      className={cn("size-4 animate-spin", className)}
      role="status"
      {...props}
    />
  );
}

export { Spinner };
