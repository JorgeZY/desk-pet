import { useEffect, useRef, useState } from "react";
import {
  PET_CLIPS,
  petClipPlaybackSrc,
  preloadPetClip,
  preloadLoopingPetClips,
  resolvePetVisualState,
  type PetIdleAction,
  type PetMood,
  type PetVisualState,
} from "./pet-clips";
import {
  PET_IDLE_ACTION_TIMING,
  startIdleActionScheduler,
} from "./pet-idle-actions";

export type { PetMood } from "./pet-clips";

interface PetProps {
  mood: PetMood;
  compact?: boolean;
  onClick?: () => void;
  windowDrag?: boolean;
}

interface ClipLayer {
  state: PetVisualState;
  epoch: number;
}

let nextPlaybackSession = 0;

const moodLabels: Record<PetMood, string> = {
  idle: "安静陪伴中",
  thinking: "正在思考",
  talking: "正在回答",
  sleeping: "正在休息",
  sad: "有一点失落",
  listening: "正在认真听",
  transcribing: "正在把语音转成文字",
};

function useClipLayer(targetState: PetVisualState) {
  const initialLayerRef = useRef<ClipLayer>({ state: targetState, epoch: 0 });
  const currentLayerRef = useRef(initialLayerRef.current);
  const epochRef = useRef(0);
  const requestRef = useRef(0);
  const [layer, setLayer] = useState<ClipLayer>(initialLayerRef.current);

  useEffect(() => {
    const request = ++requestRef.current;
    if (targetState === currentLayerRef.current.state) return;

    let cancelled = false;
    const activate = () => {
      if (cancelled || request !== requestRef.current) return;
      const current = { state: targetState, epoch: ++epochRef.current };
      currentLayerRef.current = current;
      setLayer(current);
    };

    const media = PET_CLIPS[targetState];
    if (media.loop) {
      void preloadPetClip(media.src).then(activate);
    } else {
      // A one-shot GIF must be mounted directly. Preloading it would start its
      // animation off-screen before the grooming state becomes visible.
      activate();
    }

    return () => {
      cancelled = true;
    };
  }, [targetState]);

  useEffect(() => () => {
    requestRef.current += 1;
  }, []);

  return layer;
}

function clipImage(
  layer: ClipLayer,
  className: string,
  alt: string,
  ariaHidden: boolean,
  playbackSession: number,
) {
  return (
    <img
      key={`${layer.state}:${layer.epoch}`}
      className={className}
      src={petClipPlaybackSrc(
        layer.state,
        `${playbackSession}-${layer.epoch}`,
      )}
      alt={alt}
      aria-hidden={ariaHidden || undefined}
      draggable={false}
      decoding="async"
      onError={(event) => {
        if (event.currentTarget.dataset.fallback === "true") return;
        event.currentTarget.dataset.fallback = "true";
        event.currentTarget.src = "./pet-soft-pixel-v1.png";
      }}
    />
  );
}

export function Pet({ mood, compact = false, onClick, windowDrag = false }: PetProps) {
  const [playbackSession] = useState(() => ++nextPlaybackSession);
  const idleActionEligible = Boolean(onClick) && mood === "idle" && !compact;
  const [idleAction, setIdleAction] = useState<PetIdleAction | null>(null);

  useEffect(() => {
    preloadLoopingPetClips();
  }, []);

  useEffect(() => {
    if (!idleActionEligible) {
      setIdleAction(null);
      return;
    }

    let stopScheduler: (() => void) | undefined;
    const syncVisibility = () => {
      stopScheduler?.();
      stopScheduler = undefined;
      setIdleAction(null);
      if (document.visibilityState === "visible") {
        stopScheduler = startIdleActionScheduler(
          setIdleAction,
          PET_IDLE_ACTION_TIMING,
        );
      }
    };

    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      stopScheduler?.();
    };
  }, [idleActionEligible]);

  const activeIdleAction = idleActionEligible ? idleAction : null;
  const visualState = resolvePetVisualState(mood, activeIdleAction);
  const layer = useClipLayer(visualState);
  const className = `pet ${compact ? "pet--compact" : ""} ${windowDrag ? "pet--window-drag" : ""} ${activeIdleAction ? "pet--idle-action" : ""} mood-${mood} clip-${visualState}`;
  const decorativeAlt = onClick ? "" : `橘猫团子，${moodLabels[mood]}`;

  const artwork = (
    <span className="pet__canvas">
      <svg className="pet-ground-layer" viewBox="0 0 96 120" aria-hidden="true" focusable="false">
        <g className="pet-ground-response">
          <ellipse className="pet-ground" cx="48" cy="115" rx="31" ry="3" />
        </g>
      </svg>

      <span className="pet-interaction">
        <span className="pet-clip-stack">
          {clipImage(
            layer,
            `pet-clip pet-clip--current pet-clip--${layer.state}`,
            decorativeAlt,
            Boolean(onClick),
            playbackSession,
          )}
        </span>

        <svg className="pet-state-layer" viewBox="0 0 96 120" aria-hidden="true" focusable="false">
          <rect className="pet-focus-halo" x="9" y="4" width="78" height="111" rx="14" />

          <g className="thought-dots">
            <circle cx="75" cy="28" r="2.6" />
            <circle cx="82" cy="20" r="3.6" />
            <circle cx="89" cy="10" r="5" />
          </g>

          <g className="pet-talk-marks">
            <path d="M68 44c5 1 8 3 11 6" />
            <path d="M70 39c7 0 12 3 16 7" />
            <path d="M69 50c5 2 8 4 11 8" />
          </g>

          <g className="voice-waves">
            <path className="voice-wave voice-wave--inner" d="M15 31c-4 5-4 15 0 20M81 31c4 5 4 15 0 20" />
            <path className="voice-wave voice-wave--outer" d="M9 26c-7 9-7 22 0 31M87 26c7 9 7 22 0 31" />
          </g>
          <circle className="pet-listen-bell" cx="48" cy="57" r="8" />

          <g className="transcribe-card">
            <path className="transcribe-card__paper" d="M71 5h15l6 6v22H69V7a2 2 0 0 1 2-2Z" />
            <path className="transcribe-card__fold" d="M86 5v7h6" />
            <path className="transcribe-line line-1" d="M74 16h12" />
            <path className="transcribe-line line-2" d="M74 21h9" />
            <path className="transcribe-line line-3" d="M74 26h13" />
            <path className="transcribe-cursor" d="M87 24v5" />
          </g>

          <g className="pet-sleep-zs">
            <path d="M72 28h9l-9 9h9" />
            <path d="M81 14h12L81 26h12" />
          </g>

          <path className="pet-sad-tear" d="M34 40c0 0-4 5-4 8a4 4 0 0 0 8 0c0-3-4-8-4-8Z" />
        </svg>
      </span>
    </span>
  );

  if (onClick) {
    return (
      <div className={`${className} pet--interactive`}>
        <button
          className="pet__action"
          type="button"
          onClick={onClick}
          aria-label="打开团子对话"
        >
          {artwork}
        </button>
        {windowDrag && <span className="pet__drag-zone" aria-hidden="true" />}
      </div>
    );
  }

  return (
    <div className={`${className} pet--decorative`}>
      {artwork}
      {windowDrag && <span className="pet__drag-zone" aria-hidden="true" />}
    </div>
  );
}
