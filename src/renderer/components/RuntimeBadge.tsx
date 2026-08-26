import type { RuntimeState } from "../../shared/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const phaseLabel: Record<RuntimeState["phase"], string> = {
  stopped: "未启动",
  starting: "启动中",
  downloading: "下载中",
  ready: "本地就绪",
  stopping: "停止中",
  error: "需检查",
};

export function RuntimeBadge({ runtime }: { runtime: RuntimeState }) {
  const label =
    runtime.phase === "downloading" && runtime.download?.percent !== undefined
      ? `下载 ${runtime.download.percent}%`
      : phaseLabel[runtime.phase];
  return (
    <Badge
      aria-live="polite"
      className="gap-2 font-normal"
      role="status"
      title={runtime.error ?? runtime.lastLog}
      variant="outline"
    >
      <i
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          runtime.phase === "ready"
            ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.12)]"
            : runtime.phase === "error"
              ? "bg-destructive"
              : "animate-pulse bg-amber-500",
        )}
      />
      {label}
    </Badge>
  );
}
