import { useId, useState } from "react";
import type { RuntimeConfig, RuntimeState, SpeechState, TtsState } from "../../shared/types";
import { CHAT_TEMPLATE_COUNT, CHAT_TEMPLATE_MAX_LENGTH } from "../../shared/chat-templates";
import { PixelIcon } from "./PixelIcon";
import { RuntimeBadge } from "./RuntimeBadge";

interface SettingsProps {
  initialConfig: RuntimeConfig;
  runtime: RuntimeState;
  speech: SpeechState;
  tts: TtsState;
  onClose: () => void;
  onSave: (config: RuntimeConfig, restart: boolean) => Promise<void>;
  onPrepareSpeech: (force?: boolean) => Promise<void>;
  onImportSpeech: () => Promise<void>;
  onPrepareTts: (force?: boolean) => Promise<void>;
  onImportTts: () => Promise<void>;
  onSpeakText: (text: string) => Promise<void>;
  onStopSpeaking: () => Promise<void>;
}

interface ParameterLabelProps {
  label: string;
  tooltip: string;
}

function ParameterLabel({ label, tooltip }: ParameterLabelProps) {
  const tooltipId = useId();
  return (
    <span className="parameter-label">
      <span>{label}</span>
      <span
        className="parameter-tooltip"
        tabIndex={0}
        aria-label={`${label}参数说明`}
        aria-describedby={tooltipId}
      >
        ?
        <span className="parameter-tooltip__content" id={tooltipId} role="tooltip">
          {tooltip}
        </span>
      </span>
    </span>
  );
}

export function Settings({ initialConfig, runtime, speech, tts, onClose, onSave, onPrepareSpeech, onImportSpeech, onPrepareTts, onImportTts, onSpeakText, onStopSpeaking }: SettingsProps) {
  const [config, setConfig] = useState(initialConfig);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const update = <K extends keyof RuntimeConfig>(key: K, value: RuntimeConfig[K]) =>
    setConfig((current) => ({ ...current, [key]: value }));

  const updateChatTemplate = (index: number, value: string) => {
    const chatTemplates = Array.from(
      { length: CHAT_TEMPLATE_COUNT },
      (_item, templateIndex) => config.chatTemplates[templateIndex] ?? "",
    );
    chatTemplates[index] = value;
    update("chatTemplates", chatTemplates);
  };

  const pickModel = async () => {
    const result = await window.desktopPet.pickModel();
    if (result) update("modelPath", result.path);
  };

  const pickMmproj = async () => {
    const result = await window.desktopPet.pickMmproj();
    if (result) update("mmprojPath", result.path);
  };

  const save = async (restart: boolean) => {
    setBusy(true);
    setError("");
    try {
      await onSave(config, restart);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      setBusy(false);
    }
  };

  return (
    <main className="surface settings">
      <div className="window-drag-strip" />
      <header className="panel-header settings__header">
        <div>
          <p className="eyebrow">PREFERENCES</p>
          <h1>desk-pet 设置</h1>
        </div>
        <div className="header-actions">
          <RuntimeBadge runtime={runtime} />
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭"><PixelIcon name="close" /></button>
        </div>
      </header>

      <div className="settings__body">
        <section className="settings-section">
          <div className="section-heading"><span>01</span><div><b>本地模型</b><small>选择团子使用的模型</small></div></div>
          <div className="segmented segmented--small">
            <button type="button" className={config.modelMode === "huggingface" ? "active" : ""} onClick={() => update("modelMode", "huggingface")}>自动下载</button>
            <button type="button" className={config.modelMode === "local" ? "active" : ""} onClick={() => update("modelMode", "local")}>本地 GGUF</button>
          </div>
          {config.modelMode === "huggingface" ? (
            <>
              <label>
                <span>模型标识</span>
                <input
                  value={config.hfRepo}
                  onChange={(event) => update("hfRepo", event.target.value)}
                  placeholder="owner/repo:quant"
                />
              </label>
              <p className="hint">仅在你手工启动或保存并重启模型时下载；程序启动不会自动下载未缓存模型。</p>
            </>
          ) : (
            <div className="settings-value-row">
              <div><span>GGUF 文件</span><strong title={config.modelPath}>{config.modelPath || "尚未选择"}</strong></div>
              <button className="button button--quiet" type="button" onClick={pickModel}>选择</button>
            </div>
          )}
          <div className="settings-value-row">
            <div>
              <span>视觉投影模型（可选）</span>
              <strong title={config.mmprojPath}>{config.mmprojPath || "未启用视觉功能"}</strong>
            </div>
            <div className="settings-value-actions">
              {config.mmprojPath && (
                <button className="button button--quiet" type="button" onClick={() => update("mmprojPath", "")}>清除</button>
              )}
              <button className="button button--quiet" type="button" onClick={pickMmproj}>选择 mmproj</button>
            </div>
          </div>
          <p className="hint">选择与主模型匹配的 mmproj GGUF 后，重启模型即可在聊天中发送图片。</p>
        </section>

        <section className="settings-section">
          <div className="section-heading"><span>02</span><div><b>模型参数</b><small>运行参数与常用采样设置</small></div></div>
          <div className="metric-grid metric-grid--three">
            <label><ParameterLabel label="上下文" tooltip="模型一次可参考的最大 token 数。越大越能保留长对话，但会占用更多内存或显存。" /><input type="number" min={512} max={131072} step={512} value={config.contextSize} onChange={(event) => update("contextSize", Number(event.target.value))} /></label>
            <label><ParameterLabel label="GPU 层数" tooltip="交给 GPU 计算的模型层数。数值越高通常越快，但需要更多显存；999 表示尽量全部卸载。" /><input type="number" min={0} max={999} value={config.gpuLayers} onChange={(event) => update("gpuLayers", Number(event.target.value))} /></label>
            <label><ParameterLabel label="CPU 线程" tooltip="llama.cpp 推理使用的 CPU 线程数。过高可能抢占系统资源，通常接近性能核心数即可。" /><input type="number" min={1} max={256} value={config.threads} onChange={(event) => update("threads", Number(event.target.value))} /></label>
          </div>
          <div className="metric-grid metric-grid--three">
            <label><ParameterLabel label="最大输出" tooltip="每次回答最多生成的 token 数。提高后回答可以更长，也会增加生成时间。" /><input type="number" min={32} max={8192} value={config.maxTokens} onChange={(event) => update("maxTokens", Number(event.target.value))} /></label>
            <label><ParameterLabel label="温度" tooltip="控制随机性。较低更稳定和确定，较高更有变化但也更容易偏离事实。" /><input type="number" min={0} max={2} step={0.1} value={config.temperature} onChange={(event) => update("temperature", Number(event.target.value))} /></label>
            <label><ParameterLabel label="端口" tooltip="本地 llama.cpp 服务监听的端口。仅在端口冲突或连接外部本地服务时需要调整。" /><input type="number" min={1024} max={65535} value={config.port} onChange={(event) => update("port", Number(event.target.value))} /></label>
          </div>
          <div className="metric-grid metric-grid--four">
            <label><ParameterLabel label="Top K" tooltip="每一步只从概率最高的 K 个 token 中采样。较小更保守；0 通常表示关闭此筛选。" /><input type="number" min={0} max={1000} value={config.topK} onChange={(event) => update("topK", Number(event.target.value))} /></label>
            <label><ParameterLabel label="Top P" tooltip="只保留累计概率达到该值的候选 token。越低越聚焦，常与温度一起调节。" /><input type="number" min={0} max={1} step={0.05} value={config.topP} onChange={(event) => update("topP", Number(event.target.value))} /></label>
            <label><ParameterLabel label="Min P" tooltip="过滤相对概率过低的 token。提高可减少离题候选，但过高可能让表达单一。" /><input type="number" min={0} max={1} step={0.01} value={config.minP} onChange={(event) => update("minP", Number(event.target.value))} /></label>
            <label><ParameterLabel label="重复惩罚" tooltip="降低近期已出现 token 再次被选中的概率。1 表示不惩罚，略高可减少复读。" /><input type="number" min={0} max={2} step={0.05} value={config.repeatPenalty} onChange={(event) => update("repeatPenalty", Number(event.target.value))} /></label>
          </div>
        </section>

        <section className="settings-section">
          <div className="section-heading"><span>03</span><div><b>人格</b><small>桌宠的系统提示词</small></div></div>
          <textarea rows={5} value={config.systemPrompt} onChange={(event) => update("systemPrompt", event.target.value)} />
          <label className="switch-row">
            <div><b>自动启动模型</b><span>打开桌宠时准备本地模型</span></div>
            <input type="checkbox" checked={config.autoStart} onChange={(event) => update("autoStart", event.target.checked)} />
          </label>
        </section>

        <section className="settings-section">
          <div className="section-heading"><span>04</span><div><b>快捷模板</b><small>自定义聊天首页的一键填充内容</small></div></div>
          <div className="chat-template-settings">
            {Array.from({ length: CHAT_TEMPLATE_COUNT }, (_item, index) => (
              <label key={index}>
                <span>模板 {index + 1}</span>
                <input
                  type="text"
                  maxLength={CHAT_TEMPLATE_MAX_LENGTH}
                  value={config.chatTemplates[index] ?? ""}
                  placeholder="留空即隐藏这条模板"
                  onChange={(event) => updateChatTemplate(index, event.target.value)}
                />
              </label>
            ))}
          </div>
          <p className="hint">点击模板只会填入聊天输入框，不会自动发送。</p>
        </section>

        <section className="settings-section">
          <div className="section-heading"><span>05</span><div><b>本地语音</b><small>录音和识别均在本机完成</small></div></div>
          <label className="switch-row">
            <div><b>启用本地语音输入</b><span>同时启用聊天框麦克风与全局 F8 按住说话</span></div>
            <input
              type="checkbox"
              checked={config.speech.enabled}
              onChange={(event) => update("speech", { ...config.speech, enabled: event.target.checked })}
            />
          </label>
          <div className="speech-settings-row">
            <div className="settings-info"><span>识别语言</span><strong>自动识别中、英、日、韩、粤语</strong></div>
            <div className="settings-info"><span>麦克风</span><strong title={speech.inputDevice}>{speech.inputDevice ?? "系统默认麦克风"}</strong></div>
          </div>
          <div className="settings-info settings-info--path">
            <span>语音模型位置</span>
            <strong title={speech.modelDirectory}>{speech.modelDirectory}</strong>
          </div>
          <p className={`compact-result ${speech.phase === "error" ? "failure" : speech.phase === "ready" ? "success" : ""}`}>
            {speech.error ?? speech.message}
            {speech.progress?.percent !== undefined ? ` ${speech.progress.percent.toFixed(1)}%` : ""}
          </p>
          {speech.progress && (
            <div className={`runtime-progress ${speech.progress.percent === undefined ? "indeterminate" : ""}`}>
              <i style={{ width: `${speech.progress.percent ?? 32}%` }} />
            </div>
          )}
          <div className="button-row">
            <button
              className="button button--secondary"
              type="button"
              onClick={() => void onImportSpeech()}
              disabled={speech.phase === "recording" || speech.phase === "transcribing" || speech.phase === "downloading" || speech.phase === "loading"}
            >
              使用本地模型
            </button>
            {speech.phase === "not-installed" || speech.phase === "error" ? (
              <button className="button button--quiet" type="button" onClick={() => void onPrepareSpeech(false)}>自动下载</button>
            ) : (
              <button className="button button--quiet" type="button" onClick={() => void onPrepareSpeech(true)} disabled={speech.phase !== "ready"}>重新下载模型</button>
            )}
          </div>
        </section>

        <section className="settings-section">
          <div className="section-heading"><span>06</span><div><b>语音输出</b><small>回复由本地模型朗读，不出网</small></div></div>
          <label className="switch-row">
            <div><b>启用语音朗读</b><span>团子会用本地语音朗读聊天回复</span></div>
            <input
              type="checkbox"
              checked={config.tts.enabled}
              onChange={(event) => update("tts", { ...config.tts, enabled: event.target.checked })}
            />
          </label>
          <div className="metric-grid metric-grid--two">
            <label><ParameterLabel label="语速" tooltip="TTS 合成语音的播放节奏。1 为模型默认速度，小于 1 更慢，大于 1 更快。" /><input type="number" min={0.5} max={2} step={0.1} value={config.tts.speed} onChange={(event) => update("tts", { ...config.tts, speed: Number(event.target.value) })} /></label>
            <label><ParameterLabel label="音色编号" tooltip="选择多音色 TTS 模型中的说话人编号。官方默认模型只有 0 号音色。" /><input type="number" min={0} max={99} value={config.tts.speaker} onChange={(event) => update("tts", { ...config.tts, speaker: Math.round(Number(event.target.value)) })} /></label>
          </div>
          <p className="hint">官方语音朗读模型为单一音色，音色编号保持 0；导入多音色模型时可在此选择（超出范围会自动使用最后一个音色）。</p>
          <div className="settings-info settings-info--path">
            <span>语音朗读模型位置</span>
            <strong title={tts.modelDirectory}>{tts.modelDirectory}</strong>
          </div>
          <p className={`compact-result ${tts.phase === "error" ? "failure" : tts.phase === "ready" || tts.phase === "speaking" ? "success" : ""}`}>
            {tts.error ?? tts.message}
            {tts.progress?.percent !== undefined ? ` ${tts.progress.percent.toFixed(1)}%` : ""}
          </p>
          {tts.progress && (
            <div className={`runtime-progress ${tts.progress.percent === undefined ? "indeterminate" : ""}`}>
              <i style={{ width: `${tts.progress.percent ?? 32}%` }} />
            </div>
          )}
          <div className="button-row">
            <button
              className="button button--secondary"
              type="button"
              onClick={() => void onImportTts()}
              disabled={tts.phase === "downloading" || tts.phase === "loading"}
            >
              使用本地模型
            </button>
            {tts.phase === "not-installed" || tts.phase === "error" ? (
              <button className="button button--quiet" type="button" onClick={() => void onPrepareTts(false)}>自动下载</button>
            ) : (
              <button className="button button--quiet" type="button" onClick={() => void onPrepareTts(true)} disabled={tts.phase !== "ready"}>重新下载模型</button>
            )}
          </div>
          <div className="button-row">
            <button
              className="button button--secondary"
              type="button"
              disabled={!tts.enabled || (tts.phase !== "ready" && tts.phase !== "speaking")}
              onClick={() => void onSpeakText("你好，我是团子，很高兴见到你。")}
            >
              试听
            </button>
            <button
              className="button button--quiet"
              type="button"
              disabled={tts.phase !== "speaking"}
              onClick={() => void onStopSpeaking()}
            >
              停止朗读
            </button>
          </div>
        </section>
      </div>

      {error && <p className="inline-error">{error}</p>}

      <footer className="settings__footer">
        <button className="button button--quiet" type="button" onClick={onClose}>取消</button>
        <div className="button-row">
          <button className="button button--secondary" type="button" onClick={() => save(false)} disabled={busy}>仅保存</button>
          <button className="button button--primary" type="button" onClick={() => save(true)} disabled={busy}>
            {busy ? "保存中…" : "保存并重启模型"}
          </button>
        </div>
      </footer>
    </main>
  );
}
