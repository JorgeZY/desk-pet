import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RuntimeState, SpeechState, TtsState } from "../../shared/types";
import { ChatPanel } from "./ChatPanel";

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
  it("keeps templates in place and folds listening status into the empty state", () => {
    const markup = renderToStaticMarkup(
      <ChatPanel
        runtime={runtime}
        speech={recordingSpeech}
        tts={tts}
        chatTemplates={["模板甲", "  ", "模板丙"]}
        maxTokens={2048}
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
        onSettings={() => undefined}
        onStartRuntime={async () => undefined}
      />,
    );

    expect(markup).toContain("empty-chat__voice-status");
    expect(markup).toContain("团子在认真听…");
    expect(markup).toContain("chat-template-grid");
    expect(markup).toContain("模板甲");
    expect(markup).toContain("模板丙");
    expect(markup).toContain("mood-listening");
    expect(markup).toContain("clip-idle");
    expect(markup).toContain("pet-idle-v1.gif");
    expect(markup).not.toContain("pet-talking-v1.gif");
    expect(markup).not.toContain("pet-listening-v1.gif");
    expect(markup).not.toContain("voice-pet-indicator");
    expect(markup).toContain('rows="3"');
    expect(markup).toContain('aria-label="推理强度：中，思考预算最多 1024 token"');
    expect(markup).toContain("预算 ≤ 1,024");
    expect(markup).toContain("总输出 ≤ 2,048");
    expect(markup).toContain('class="thinking-effort__menu"');
    expect(markup).not.toContain("<select");
    expect(markup.indexOf("chat-template-grid")).toBeLessThan(
      markup.indexOf('class="composer"'),
    );
  });
});
