import type { RuntimePhase } from "../../shared/types";

export type PetMood = "idle" | "thinking" | "talking" | "sleeping" | "sad";

interface PetProps {
  mood: PetMood;
  phase: RuntimePhase;
  compact?: boolean;
  onClick?: () => void;
}

export function Pet({ mood, phase, compact = false, onClick }: PetProps) {
  return (
    <button
      className={`pet ${compact ? "pet--compact" : ""} mood-${mood}`}
      type="button"
      onClick={onClick}
      aria-label="打开 desk-pet 对话"
    >
      <span className={`runtime-orb phase-${phase}`} aria-hidden="true" />
      <svg viewBox="0 0 260 240" role="img" aria-label="橘色桌宠小猫">
        <defs>
          <linearGradient id="fur" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffc283" />
            <stop offset="1" stopColor="#ed8f61" />
          </linearGradient>
          <linearGradient id="belly" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff3df" />
            <stop offset="1" stopColor="#ffe1be" />
          </linearGradient>
          <filter id="shadow" x="-30%" y="-30%" width="160%" height="180%">
            <feDropShadow dx="0" dy="10" stdDeviation="9" floodColor="#673b31" floodOpacity=".2" />
          </filter>
        </defs>

        <g className="pet-tail" filter="url(#shadow)">
          <path
            d="M195 174c38 2 49-24 32-38-11-9-23-3-20 8"
            fill="none"
            stroke="url(#fur)"
            strokeWidth="25"
            strokeLinecap="round"
          />
        </g>

        <ellipse cx="130" cy="213" rx="78" ry="13" fill="#593d35" opacity=".14" />
        <g className="pet-body" filter="url(#shadow)">
          <path
            d="M76 128c-11 19-14 47-6 70 8 24 35 30 60 30s52-6 60-30c8-23 5-51-6-70Z"
            fill="url(#fur)"
          />
          <ellipse cx="130" cy="181" rx="42" ry="39" fill="url(#belly)" opacity=".92" />
          <ellipse cx="91" cy="214" rx="25" ry="13" fill="#f4a56f" />
          <ellipse cx="169" cy="214" rx="25" ry="13" fill="#f4a56f" />
        </g>

        <g className="pet-head" filter="url(#shadow)">
          <path d="m68 71 8-48 37 30Z" fill="url(#fur)" />
          <path d="m192 71-8-48-37 30Z" fill="url(#fur)" />
          <path d="m78 57 3-22 18 16Z" fill="#e7796f" opacity=".75" />
          <path d="m182 57-3-22-18 16Z" fill="#e7796f" opacity=".75" />
          <path
            d="M67 91c0-39 27-59 63-59s63 20 63 59c0 36-26 61-63 61S67 127 67 91Z"
            fill="url(#fur)"
          />
          <path d="M106 45c6 13 4 25-1 34M130 39v36M154 45c-6 13-4 25 1 34" stroke="#d77854" strokeWidth="6" strokeLinecap="round" fill="none" opacity=".7" />
          <ellipse cx="130" cy="116" rx="35" ry="25" fill="url(#belly)" />
          <g className="pet-eyes">
            <ellipse cx="103" cy="91" rx="8" ry="10" fill="#40302d" />
            <ellipse cx="157" cy="91" rx="8" ry="10" fill="#40302d" />
            <circle cx="100" cy="87" r="2.3" fill="#fff" />
            <circle cx="154" cy="87" r="2.3" fill="#fff" />
          </g>
          <path d="m124 108 6-4 6 4-6 6Z" fill="#d96f76" />
          <g className="pet-mouth">
            <path d="M130 114c-1 8-9 10-14 5M130 114c1 8 9 10 14 5" stroke="#573c37" strokeWidth="2.7" strokeLinecap="round" fill="none" />
          </g>
          <g stroke="#694942" strokeWidth="2" strokeLinecap="round" opacity=".55">
            <path d="m96 112-32-6M96 119l-34 3M164 112l32-6M164 119l34 3" />
          </g>
          <circle cx="93" cy="109" r="8" fill="#ee8f8c" opacity=".35" />
          <circle cx="167" cy="109" r="8" fill="#ee8f8c" opacity=".35" />
        </g>

        <g className="thought-dots" fill="#fff">
          <circle cx="207" cy="63" r="5" />
          <circle cx="221" cy="46" r="7" />
          <circle cx="239" cy="24" r="10" />
        </g>
      </svg>
    </button>
  );
}
