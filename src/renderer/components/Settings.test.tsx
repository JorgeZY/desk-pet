import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../main/config-store";
import type { RuntimeState, SpeechState, TtsState } from "../../shared/types";
import { Settings } from "./Settings";

const runtime: RuntimeState = {
  phase: "ready",
  visionEnabled: false,
  endpoint: "http://127.0.0.1:18766",
  message: "模型已就绪。",
  updatedAt: 1,
};

const speech: SpeechState = {
  enabled: true,
  phase: "ready",
  message: "语音模型已就绪。",
  modelDirectory: "D:\\models\\speech",
  updatedAt: 1,
};

const tts: TtsState = {
  enabled: true,
  phase: "ready",
  message: "语音朗读模型已就绪。",
  modelDirectory: "D:\\models\\tts",
  updatedAt: 1,
};

function renderSettings(): string {
  return renderToStaticMarkup(
    <Settings
      initialConfig={{ ...DEFAULT_CONFIG, chatTemplates: ["模板甲", "", "模板丙"] }}
      runtime={runtime}
      speech={speech}
      tts={tts}
      onClose={() => undefined}
      onSave={async () => undefined}
      onPrepareSpeech={async () => undefined}
      onImportSpeech={async () => undefined}
      onPrepareTts={async () => undefined}
      onImportTts={async () => undefined}
      onSpeakText={async () => undefined}
      onStopSpeaking={async () => undefined}
    />,
  );
}

describe("Settings", () => {
  it("shows help tooltips for every model and TTS parameter", () => {
    const markup = renderSettings();

    expect(markup.match(/role="tooltip"/g)).toHaveLength(12);
    for (const label of [
      "上下文",
      "GPU 层数",
      "CPU 线程",
      "最大输出",
      "温度",
      "端口",
      "Top K",
      "Top P",
      "Min P",
      "重复惩罚",
      "语速",
      "音色编号",
    ]) {
      expect(markup).toContain(`${label}参数说明`);
    }
  });

  it("renders three editable templates and one combined local-speech switch", () => {
    const markup = renderSettings();

    expect(markup).toContain("快捷模板");
    expect(markup).toContain('value="模板甲"');
    expect(markup).toContain('value="模板丙"');
    expect(markup.match(/maxLength="80"/g)).toHaveLength(3);
    expect(markup.match(/全局 F8/g)).toHaveLength(1);
    expect(markup).toContain("同时启用聊天框麦克风与全局 F8 按住说话");
    expect(markup.match(/type="checkbox"/g)).toHaveLength(3);
  });
});
