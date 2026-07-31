import { useRef } from "react";
import type { SpeechState } from "../../shared/types";

interface VoiceButtonProps {
  speech: SpeechState;
  compact?: boolean;
  onPrepare: () => Promise<void>;
  onStart: () => Promise<string | undefined>;
  onStop: (sessionId: string) => Promise<void>;
  onCancel: (sessionId: string) => Promise<void>;
}

export function VoiceButton({
  speech,
  compact = false,
  onPrepare,
  onStart,
  onStop,
  onCancel,
}: VoiceButtonProps) {
  const sessionRef = useRef<string | undefined>(undefined);
  const releasedRef = useRef(false);

  const begin = async () => {
    if (speech.phase === "not-installed") {
      await onPrepare();
      return;
    }
    if (speech.phase !== "ready" && speech.phase !== "error") return;
    releasedRef.current = false;
    const sessionId = await onStart();
    sessionRef.current = sessionId;
    if (releasedRef.current && sessionId) {
      sessionRef.current = undefined;
      await onStop(sessionId);
    }
  };

  const finish = async () => {
    releasedRef.current = true;
    const sessionId = sessionRef.current;
    sessionRef.current = undefined;
    if (sessionId) await onStop(sessionId);
  };

  const cancel = async () => {
    releasedRef.current = true;
    const sessionId = sessionRef.current;
    sessionRef.current = undefined;
    if (sessionId) await onCancel(sessionId);
  };

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
      onPointerCancel={() => void cancel()}
      onLostPointerCapture={() => {
        if (sessionRef.current) void finish();
      }}
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
      <span className="voice-button__icon" aria-hidden="true">●</span>
      {!compact && <span>{label}</span>}
      {speech.phase === "recording" && (
        <i className="voice-button__level" style={{ transform: `scaleY(${0.25 + (speech.level ?? 0) * 0.75})` }} />
      )}
    </button>
  );
}
