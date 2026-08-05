import { useId } from "react";

export type PetMood =
  | "idle"
  | "thinking"
  | "talking"
  | "sleeping"
  | "sad"
  | "listening"
  | "transcribing";

interface PetProps {
  mood: PetMood;
  compact?: boolean;
  onClick?: () => void;
  windowDrag?: boolean;
}

export function Pet({ mood, compact = false, onClick, windowDrag = false }: PetProps) {
  const id = useId().replace(/:/gu, "");
  const furId = `fur-${id}`;
  const bellyId = `belly-${id}`;
  const collarId = `collar-${id}`;

  return (
    <button
      className={`pet ${compact ? "pet--compact" : ""} ${windowDrag ? "pet--window-drag" : ""} mood-${mood}`}
      type="button"
      onClick={onClick}
      aria-label={windowDrag ? "拖动桌宠窗口" : "打开 desk-pet 对话"}
    >
      {windowDrag && <span className="pet__drag-zone" aria-hidden="true" />}
      <svg viewBox="0 0 260 240" role="img" aria-label="橘色桌宠小猫">
        <defs>
          <linearGradient id={furId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffd39a" />
            <stop offset="0.48" stopColor="#f5aa70" />
            <stop offset="1" stopColor="#e78257" />
          </linearGradient>
          <linearGradient id={bellyId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff9eb" />
            <stop offset="1" stopColor="#ffdfb8" />
          </linearGradient>
          <linearGradient id={collarId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#65c2aa" />
            <stop offset="1" stopColor="#3f987f" />
          </linearGradient>
        </defs>

        <g className="pet-tail">
          <path
            d="M195 174c38 2 49-24 32-38-11-9-23-3-20 8"
            fill="none"
            stroke={`url(#${furId})`}
            strokeWidth="25"
            strokeLinecap="round"
          />
          <g className="pet-tail__markings" fill="none" stroke="#cc6d4e" strokeWidth="5" strokeLinecap="round" opacity=".72">
            <path d="M211 171c2-5 1-10-2-15" />
            <path d="M224 163c2-5 1-10-3-15" />
          </g>
        </g>

        <ellipse className="pet-ground" cx="130" cy="216" rx="76" ry="10" fill="#593d35" opacity=".1" />
        <g className="pet-body">
          <path
            d="M76 128c-11 19-14 47-6 70 8 24 35 30 60 30s52-6 60-30c8-23 5-51-6-70Z"
            fill={`url(#${furId})`}
          />
          <path d="M78 150c8-13 20-20 29-22-7 18-9 48-2 78-18-4-29-17-31-33-1-8 1-16 4-23Z" fill="#ffd09a" opacity=".34" />
          <path d="M104 137c7 5 17 8 26 8s19-3 26-8c-2 11-11 18-26 18s-24-7-26-18Z" fill={`url(#${bellyId})`} opacity=".96" />
          <ellipse cx="130" cy="183" rx="42" ry="40" fill={`url(#${bellyId})`} opacity=".94" />
          <path d="M130 156c-6 14-6 32 0 49" fill="none" stroke="#f4c693" strokeWidth="3" strokeLinecap="round" opacity=".52" />
          <ellipse cx="91" cy="214" rx="25" ry="13" fill="#f4a56f" />
          <ellipse cx="169" cy="214" rx="25" ry="13" fill="#f4a56f" />
          <g className="pet-toes" fill="none" stroke="#d47a59" strokeWidth="2.2" strokeLinecap="round" opacity=".72">
            <path d="M83 212c1 4 1 7 0 9M94 211c1 4 1 7 0 10M166 211c-1 4-1 7 0 10M177 212c-1 4-1 7 0 9" />
          </g>
        </g>

        <g className="pet-head">
          <g className="pet-ear pet-ear--left">
            <path d="m68 71 8-48 37 30Z" fill={`url(#${furId})`} />
            <path d="m78 57 3-22 18 16Z" fill="#df7b74" opacity=".72" />
            <path d="m78 34 2-8 7 9" fill="none" stroke="#ffe1b5" strokeWidth="3" strokeLinecap="round" opacity=".7" />
          </g>
          <g className="pet-ear pet-ear--right">
            <path d="m192 71-8-48-37 30Z" fill={`url(#${furId})`} />
            <path d="m182 57-3-22-18 16Z" fill="#df7b74" opacity=".72" />
            <path d="m182 34-2-8-7 9" fill="none" stroke="#ffe1b5" strokeWidth="3" strokeLinecap="round" opacity=".7" />
          </g>
          <path
            d="M67 91c0-39 27-59 63-59s63 20 63 59c0 36-26 61-63 61S67 127 67 91Z"
            fill={`url(#${furId})`}
          />
          <path d="M79 73c7-20 26-32 48-34-27 10-42 29-43 56-1 22 9 40 26 51-25-7-39-27-39-53 0-7 3-15 8-20Z" fill="#ffd49f" opacity=".3" />
          <path d="M106 45c6 13 4 25-1 34M130 39v36M154 45c-6 13-4 25 1 34" stroke="#d77854" strokeWidth="6" strokeLinecap="round" fill="none" opacity=".7" />
          <g className="pet-brows" fill="none" stroke="#bc654b" strokeWidth="2.8" strokeLinecap="round" opacity=".55">
            <path d="M94 76c6-3 12-3 18 0M148 76c6-3 12-3 18 0" />
          </g>
          <ellipse cx="130" cy="116" rx="35" ry="25" fill={`url(#${bellyId})`} />
          <g className="pet-eyes">
            <ellipse cx="103" cy="91" rx="8.5" ry="10.5" fill="#5b4037" />
            <ellipse cx="157" cy="91" rx="8.5" ry="10.5" fill="#5b4037" />
            <ellipse cx="103" cy="93" rx="4.7" ry="6.5" fill="#2f2928" />
            <ellipse cx="157" cy="93" rx="4.7" ry="6.5" fill="#2f2928" />
            <circle cx="100" cy="87" r="2.5" fill="#fff" />
            <circle cx="154" cy="87" r="2.5" fill="#fff" />
            <circle cx="105" cy="96" r="1.2" fill="#dba36d" opacity=".8" />
            <circle cx="159" cy="96" r="1.2" fill="#dba36d" opacity=".8" />
          </g>
          <path d="m124 108 6-4 6 4-6 6Z" fill="#d96f76" stroke="#b85a63" strokeWidth="1" />
          <path d="m127 107 3-2 2 1" fill="none" stroke="#ffc8c9" strokeWidth="1.2" strokeLinecap="round" opacity=".9" />
          <g className="pet-mouth">
            <path d="M130 114c-1 8-9 10-14 5M130 114c1 8 9 10 14 5" stroke="#573c37" strokeWidth="2.7" strokeLinecap="round" fill="none" />
          </g>
          <g className="pet-whiskers" stroke="#694942" strokeWidth="2" strokeLinecap="round" opacity=".58">
            <path d="m96 112-32-6M96 119l-34 3M164 112l32-6M164 119l34 3" />
          </g>
          <g fill="#9b654f" opacity=".35">
            <circle cx="106" cy="113" r="1.2" /><circle cx="101" cy="117" r="1.1" /><circle cx="154" cy="113" r="1.2" /><circle cx="159" cy="117" r="1.1" />
          </g>
          <circle cx="93" cy="109" r="8" fill="#ee8f8c" opacity=".35" />
          <circle cx="167" cy="109" r="8" fill="#ee8f8c" opacity=".35" />
        </g>

        <g className="pet-collar">
          <path d="M101 139c8 7 18 10 29 10s21-3 29-10" fill="none" stroke={`url(#${collarId})`} strokeWidth="7" strokeLinecap="round" />
          <g className="pet-collar__charm">
            <circle cx="130" cy="151" r="6" fill="#f2bd55" stroke="#c88730" strokeWidth="1.5" />
            <circle cx="128" cy="149" r="1.5" fill="#fff2b9" opacity=".9" />
          </g>
        </g>

        <g className="thought-dots" fill="#fff">
          <circle cx="207" cy="63" r="5" />
          <circle cx="221" cy="46" r="7" />
          <circle cx="239" cy="24" r="10" />
        </g>
        <g className="voice-waves" fill="none" stroke="#58b89a" strokeLinecap="round">
          <path d="M44 78c-8 8-8 20 0 28" strokeWidth="5" />
          <path d="M31 68c-15 15-15 38 0 53" strokeWidth="4" />
          <path d="M216 78c8 8 8 20 0 28" strokeWidth="5" />
          <path d="M229 68c15 15 15 38 0 53" strokeWidth="4" />
        </g>
        <g className="transcribe-card">
          <rect x="181" y="14" width="65" height="50" rx="11" fill="#fff8eb" stroke="#eda371" strokeWidth="3" />
          <path className="transcribe-line line-1" d="M194 28h37" />
          <path className="transcribe-line line-2" d="M194 39h29" />
          <path className="transcribe-line line-3" d="M194 50h34" />
        </g>
      </svg>
    </button>
  );
}
