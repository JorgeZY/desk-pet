import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { SpeechState } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { PromptInputButton } from "./ai-elements/prompt-input";
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

  const commonProps = {
      type: "button" as const,
      disabled: busy,
      "aria-label": label,
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        void begin();
      },
      onPointerUp: () => void finish(),
      onPointerCancel: () => void finish(),
      onLostPointerCapture: () => void finish(),
      onBlur: () => void finish(),
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          void begin();
        }
      },
      onKeyUp: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          void finish();
        }
      },
  } as const;
  const voiceActive = speech.phase === "recording" || speech.phase === "transcribing";
  const level = speech.phase === "recording" ? speech.level ?? 0.35 : 0.55;
  const content = (
    <>
      {voiceActive ? (
        <span className="flex h-4 items-center gap-0.5" aria-hidden="true">
          {[0.55, 1, 0.72].map((multiplier, index) => (
            <i
              className="h-3 w-0.5 origin-center animate-pulse rounded-full bg-primary transition-transform"
              key={multiplier}
              style={{
                animationDelay: `${index * 110}ms`,
                transform: `scaleY(${Math.max(0.28, level * multiplier)})`,
              }}
            />
          ))}
        </span>
      ) : (
        <PixelIcon name="mic" />
      )}
      {!compact ? <span>{label}</span> : null}
    </>
  );

  if (compact) {
    return (
      <PromptInputButton
        {...commonProps}
        tooltip={label}
        variant={speech.phase === "recording" ? "secondary" : "ghost"}
      >
        {content}
      </PromptInputButton>
    );
  }

  return (
    <Button {...commonProps} variant={speech.phase === "recording" ? "secondary" : "outline"}>
      {content}
    </Button>
  );
}
