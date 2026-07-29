import type { RuntimeState } from "../../shared/types";

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
    <span className={`runtime-badge phase-${runtime.phase}`} title={runtime.error ?? runtime.lastLog}>
      <i />
      {label}
    </span>
  );
}
