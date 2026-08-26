import {
  CircleAlert,
  Cpu,
  Info,
  Power,
  RefreshCw,
} from "lucide-react";
import type { RuntimeState } from "../../shared/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";

interface RuntimeLoadingDockProps {
  modelLabel: string;
  onStart: () => Promise<void>;
  runtime: RuntimeState;
}

function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return undefined;
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function downloadSummary(runtime: RuntimeState): string | undefined {
  if (runtime.phase !== "downloading" || !runtime.download) {
    return undefined;
  }

  const received = formatBytes(runtime.download.receivedBytes);
  const total = formatBytes(runtime.download.totalBytes);
  if (received && total) {
    return `${received} / ${total}`;
  }
  return received;
}

function RuntimeGlyph({ phase }: Pick<RuntimeState, "phase">) {
  const active = phase === "starting" || phase === "downloading" || phase === "stopping";
  if (phase === "error") {
    return (
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive">
        <CircleAlert aria-hidden="true" className="size-4" />
      </span>
    );
  }
  if (phase === "stopped") {
    return (
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
        <Power aria-hidden="true" className="size-4" />
      </span>
    );
  }
  return (
    <span className="relative grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
      {active ? (
        <span
          aria-hidden="true"
          className="absolute inset-1 rounded-full border-2 border-primary/15 border-r-primary border-t-primary motion-safe:animate-spin motion-reduce:border-primary/45"
          style={{ animationDuration: "1.8s" }}
        />
      ) : null}
      <Cpu aria-hidden="true" className="size-3.5" />
    </span>
  );
}

export function RuntimeLoadingDock({
  modelLabel,
  onStart,
  runtime,
}: RuntimeLoadingDockProps) {
  if (runtime.phase === "ready") {
    return null;
  }

  const canStart = runtime.phase === "stopped" || runtime.phase === "error";
  const active = runtime.phase === "starting" || runtime.phase === "downloading" || runtime.phase === "stopping";
  const progress = runtime.phase === "downloading" ? runtime.download?.percent : undefined;
  const bytes = downloadSummary(runtime);
  const detail = runtime.error ?? runtime.lastLog ?? (
    canStart ? "启动模型后即可开始对话。" : "本地运行时正在准备，请稍候。"
  );

  return (
    <section
      aria-label="本地模型运行状态"
      className={cn(
        "w-full border-b border-border/75 bg-secondary/35 px-3.5 py-3",
        runtime.phase === "error" && "bg-destructive/[0.045]",
      )}
      data-runtime-phase={runtime.phase}
    >
      <div className="flex items-center gap-3">
        <RuntimeGlyph phase={runtime.phase} />
        <div className="min-w-0 flex-1" role="status" aria-live="polite">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">
              {runtime.message}
            </p>
            {runtime.phase === "downloading" && progress !== undefined ? (
              <span className="shrink-0 text-xs font-semibold tabular-nums text-primary">
                {Math.round(progress)}%
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {modelLabel}{bytes ? ` · ${bytes}` : ` · ${detail}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                aria-label="查看模型加载详情"
                size="icon-xs"
                title="查看模型加载详情"
                type="button"
                variant="soft"
              >
                <Info aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
              <PopoverHeader>
                <PopoverTitle>本地运行时详情</PopoverTitle>
                <PopoverDescription>
                  当前模型的加载状态与最近一条运行日志。
                </PopoverDescription>
              </PopoverHeader>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
                <dt className="text-muted-foreground">模型</dt>
                <dd className="min-w-0 break-all font-medium">{modelLabel}</dd>
                <dt className="text-muted-foreground">状态</dt>
                <dd>{runtime.message}</dd>
                <dt className="text-muted-foreground">端点</dt>
                <dd className="min-w-0 break-all font-mono">{runtime.endpoint}</dd>
                {runtime.download ? (
                  <>
                    <dt className="text-muted-foreground">来源</dt>
                    <dd>{runtime.download.source}</dd>
                  </>
                ) : null}
              </dl>
              <div className="mt-3 rounded-lg border bg-muted/45 p-2.5">
                <p className="mb-1 text-xs font-medium text-foreground">
                  {runtime.error ? "错误" : "最近日志"}
                </p>
                <p className={cn(
                  "max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-muted-foreground",
                  runtime.error && "text-destructive",
                )}>
                  {detail}
                </p>
              </div>
            </PopoverContent>
          </Popover>
          {canStart ? (
            <Button
              aria-label="启动模型"
              onClick={() => void onStart()}
              size="icon-xs"
              title="启动模型"
              type="button"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      {active ? (
        <div className="mt-2.5 pl-12">
          {runtime.phase === "downloading" && progress !== undefined ? (
            <Progress
              aria-label="模型下载进度"
              className="h-1.5 bg-primary/15"
              data-mode="determinate"
              value={Math.max(0, Math.min(100, progress))}
            />
          ) : (
            <div
              aria-label="模型加载中"
              className="runtime-dock-progress h-1.5 overflow-hidden rounded-full bg-primary/15"
              data-mode="indeterminate"
              role="progressbar"
            >
              <span aria-hidden="true" className="runtime-dock-progress__beam" />
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

export { formatBytes };
