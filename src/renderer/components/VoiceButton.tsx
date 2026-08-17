import { useEffect, useRef } from "react";
import type { SpeechState } from "../../shared/types";
import { createHoldToTalkController } from "./hold-to-talk";
import { PixelIcon } from "./PixelIcon";

interface VoiceButtonProps {
  speech: SpeechState;
  compact?: boolean;
  onPrepare: () => Promise<void>;
  onStart: () => Promise<string | undefined>;
  onStop: (sessionId: string) => Promise<void>;
}

export function VoiceButton({
  speech,
  compact = false,
  onPrepare,
  onStart,
  onStop,
}: VoiceButtonProps) {
  const controllerRef = useRef<ReturnType<typeof createHoldToTalkController> | null>(null);
  if (!controllerRef.current) controllerRef.current = createHoldToTalkController();
  useEffect(() => () => {
    void controllerRef.current?.release();
  }, []);

  const begin = async () => {
    if (speech.phase === "not-installed") {
      await onPrepare();
      return;
    }
    if (speech.phase !== "ready" && speech.phase !== "error") return;
    await controllerRef.current?.press({ start: onStart, stop: onStop });
  };

  const finish = () => controllerRef.current?.release();

  const busy = !speech.enabled || speech.phase === "downloading" || speech.phase === "loading" || speech.phase === "transcribing";
  const label =
    !speech.enabled
      ? "语音输入已关闭"
      : speech.phase === "not-installed"
      ? "下载语音模型"
      : speech.phase === "error"
        ? "重试语音输入"
      : speech.phase === "recording"
        ? "录音中，松开结束"
        : speech.phase === "transcribing"
          ? "正在转换语音"
          : "按住说话";

  return (
    <button
      className={`voice-button ${compact ? "voice-button--compact" : ""} phase-${speech.phase}`}
      type="button"
      disabled={busy}
      aria-label={label}
      title={label}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        void begin();
      }}
      onPointerUp={() => void finish()}
      onPointerCancel={() => void finish()}
      onLostPointerCapture={() => void finish()}
      onBlur={() => void finish()}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          void begin();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          void finish();
        }
      }}
    >
      <PixelIcon name="mic" className="voice-button__icon" />
      {!compact && <span>{label}</span>}
      {speech.phase === "recording" && (
        <i className="voice-button__level" style={{ transform: `scaleY(${0.25 + (speech.level ?? 0) * 0.75})` }} />
      )}
    </button>
  );
}
