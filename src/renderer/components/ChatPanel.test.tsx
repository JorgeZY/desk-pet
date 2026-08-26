import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RuntimeState, SpeechState, TtsState } from "../../shared/types";
import { ChatPanel } from "./ChatPanel";
import { TooltipProvider } from "./ui/tooltip";

const runtime: RuntimeState = {
  phase: "ready",
  visionEnabled: false,
  endpoint: "http://127.0.0.1:18766",
  message: "模型已就绪。",
  updatedAt: 1,
};

const recordingSpeech: SpeechState = {
  enabled: true,
  phase: "recording",
  message: "正在聆听…",
  modelDirectory: "D:\\models\\speech",
  activeSessionId: "speech-1",
  updatedAt: 1,
};

const tts: TtsState = {
  enabled: true,
  phase: "ready",
  message: "语音朗读模型已就绪。",
  modelDirectory: "D:\\models\\tts",
  updatedAt: 1,
};

describe("ChatPanel empty state", () => {
  it("keeps templates in place and renders voice capture as an icon-only animation", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <ChatPanel
          runtime={runtime}
          speech={recordingSpeech}
          tts={tts}
          chatTemplates={["模板甲", "  ", "模板丙"]}
          maxTokens={2048}
          contextSize={8192}
          modelLabel="MiniCPM5-1B-Q4_K_M"
          draft=""
          images={[]}
          documents={[]}
          onDraftChange={() => undefined}
          onImagesChange={() => undefined}
          onDocumentsChange={() => undefined}
          visionEnabled={false}
          onPrepareSpeech={async () => undefined}
          onStartSpeech={async () => undefined}
          onStopSpeech={async () => undefined}
          onSpeakText={async () => undefined}
          onStopSpeaking={async () => undefined}
          onClose={() => undefined}
          onStartRuntime={async () => undefined}
        />
      </TooltipProvider>,
    );

    expect(markup).not.toContain("正在聆听…");
    expect(markup).toContain("模板甲");
    expect(markup).toContain("模板丙");
    expect(markup).toContain("今天想完成什么？");
    expect(markup).toContain("workbench-empty-title");
    expect(markup).toContain("min-h-11 max-w-72");
    expect(markup).not.toContain('class="pet');
    expect(markup).not.toContain("voice-pet-indicator");
    expect(markup).toContain('rows="3"');
    expect(markup).toContain('aria-label="模型 MiniCPM5-1B-Q4_K_M，推理关闭"');
    expect(markup).toContain('data-slot="dropdown-menu-trigger"');
    expect(markup).toContain('aria-label="上下文上限 8,192 token，完成一次回答后显示用量"');
    expect(markup.indexOf("模板甲")).toBeLessThan(markup.indexOf('rows="3"'));
    expect(markup).not.toContain('class="workbench-titlebar"');
    expect(markup).not.toContain("LOCAL AI");
    expect(markup).not.toContain("AI 工作台");
    expect(markup).not.toContain('aria-label="功能"');
    expect(markup).toContain("bg-emerald-500");
    expect(markup).toContain("MiniCPM5-1B-Q4_K_M");
    expect(markup).toContain('aria-label="工作台侧栏"');
    expect(markup).toContain("最近对话");
    expect(markup).toContain('aria-label="打开实时字幕"');
    expect(markup).toContain('aria-label="返回桌面宠物"');
    expect(markup).toContain("animate-pulse");
  });
});
