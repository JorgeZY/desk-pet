import { useState } from "react";
import type { RuntimeConfig, RuntimeState, SpeechState } from "../../shared/types";
import { PixelIcon } from "./PixelIcon";
import { RuntimeBadge } from "./RuntimeBadge";

interface SettingsProps {
  initialConfig: RuntimeConfig;
  runtime: RuntimeState;
  speech: SpeechState;
  onClose: () => void;
  onSave: (config: RuntimeConfig, restart: boolean) => Promise<void>;
  onPrepareSpeech: (force?: boolean) => Promise<void>;
  onImportSpeech: () => Promise<void>;
}

export function Settings({ initialConfig, runtime, speech, onClose, onSave, onPrepareSpeech, onImportSpeech }: SettingsProps) {
  const [config, setConfig] = useState(initialConfig);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const update = <K extends keyof RuntimeConfig>(key: K, value: RuntimeConfig[K]) =>
    setConfig((current) => ({ ...current, [key]: value }));

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
            <label><span>上下文</span><input type="number" min={512} max={131072} step={512} value={config.contextSize} onChange={(event) => update("contextSize", Number(event.target.value))} /></label>
            <label><span>GPU 层数</span><input type="number" min={0} max={999} value={config.gpuLayers} onChange={(event) => update("gpuLayers", Number(event.target.value))} /></label>
            <label><span>CPU 线程</span><input type="number" min={1} max={256} value={config.threads} onChange={(event) => update("threads", Number(event.target.value))} /></label>
          </div>
          <div className="metric-grid metric-grid--three">
            <label><span>最大输出</span><input type="number" min={32} max={8192} value={config.maxTokens} onChange={(event) => update("maxTokens", Number(event.target.value))} /></label>
            <label><span>温度</span><input type="number" min={0} max={2} step={0.1} value={config.temperature} onChange={(event) => update("temperature", Number(event.target.value))} /></label>
            <label><span>端口</span><input type="number" min={1024} max={65535} value={config.port} onChange={(event) => update("port", Number(event.target.value))} /></label>
          </div>
          <div className="metric-grid metric-grid--four">
            <label><span>Top K</span><input type="number" min={0} max={1000} value={config.topK} onChange={(event) => update("topK", Number(event.target.value))} /></label>
            <label><span>Top P</span><input type="number" min={0} max={1} step={0.05} value={config.topP} onChange={(event) => update("topP", Number(event.target.value))} /></label>
            <label><span>Min P</span><input type="number" min={0} max={1} step={0.01} value={config.minP} onChange={(event) => update("minP", Number(event.target.value))} /></label>
            <label><span>重复惩罚</span><input type="number" min={0} max={2} step={0.05} value={config.repeatPenalty} onChange={(event) => update("repeatPenalty", Number(event.target.value))} /></label>
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
          <div className="section-heading"><span>04</span><div><b>本地语音</b><small>录音和识别均在本机完成</small></div></div>
          <label className="switch-row">
            <div><b>启用语音输入</b><span>录音和识别始终在本机完成</span></div>
            <input
              type="checkbox"
              checked={config.speech.enabled}
              onChange={(event) => update("speech", { ...config.speech, enabled: event.target.checked })}
            />
          </label>
          <label className="switch-row">
            <div><b>全局 F8 按住说话</b><span>在任意应用的当前输入框中输入，流式文字显示在橘猫气泡中</span></div>
            <input
              type="checkbox"
              checked={config.speech.globalShortcut}
              disabled={!config.speech.enabled}
              onChange={(event) => update("speech", { ...config.speech, globalShortcut: event.target.checked })}
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
