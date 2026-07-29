import { useState } from "react";
import type { ProbeResult, RuntimeConfig, RuntimeState } from "../../shared/types";
import { RuntimeBadge } from "./RuntimeBadge";

interface SettingsProps {
  initialConfig: RuntimeConfig;
  runtime: RuntimeState;
  onClose: () => void;
  onSave: (config: RuntimeConfig, restart: boolean) => Promise<void>;
}

export function Settings({ initialConfig, runtime, onClose, onSave }: SettingsProps) {
  const [config, setConfig] = useState(initialConfig);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const update = <K extends keyof RuntimeConfig>(key: K, value: RuntimeConfig[K]) =>
    setConfig((current) => ({ ...current, [key]: value }));

  const pickExecutable = async () => {
    const result = await window.desktopPet.pickExecutable();
    if (result) {
      update("executable", result.path);
      setProbe(null);
    }
  };

  const pickModel = async () => {
    const result = await window.desktopPet.pickModel();
    if (result) update("modelPath", result.path);
  };

  const probeRuntime = async () => {
    setProbe(await window.desktopPet.probeRuntime(config.executable));
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
          <p className="eyebrow">LOCAL RUNTIME</p>
          <h1>desk-pet 设置</h1>
        </div>
        <div className="header-actions">
          <RuntimeBadge runtime={runtime} />
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">×</button>
        </div>
      </header>

      <div className="settings__body">
        <section className="settings-section">
          <div className="section-heading"><span>01</span><div><b>llama.cpp</b><small>本地推理引擎</small></div></div>
          <label>
            <span>可执行文件或命令</span>
            <div className="field-row">
              <input value={config.executable} onChange={(event) => update("executable", event.target.value)} />
              <button className="button button--quiet" type="button" onClick={pickExecutable}>选择</button>
              <button className="button button--quiet" type="button" onClick={probeRuntime}>检测</button>
            </div>
          </label>
          {probe && <p className={`compact-result ${probe.ok ? "success" : "failure"}`}>{probe.ok ? probe.version : probe.error}</p>}
        </section>

        <section className="settings-section">
          <div className="section-heading"><span>02</span><div><b>本地模型</b><small>可随时切换 GGUF</small></div></div>
          <div className="segmented segmented--small">
            <button type="button" className={config.modelMode === "huggingface" ? "active" : ""} onClick={() => update("modelMode", "huggingface")}>Hugging Face</button>
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
              <p className="hint">内置默认模型支持镜像与断点续传；其他远程模型由 llama.cpp 的 -hf 模式下载。</p>
            </>
          ) : (
            <label>
              <span>GGUF 文件</span>
              <div className="field-row">
                <input value={config.modelPath} readOnly />
                <button className="button button--quiet" type="button" onClick={pickModel}>选择</button>
              </div>
            </label>
          )}
        </section>

        <section className="settings-section">
          <div className="section-heading"><span>03</span><div><b>性能</b><small>修改后需重启模型</small></div></div>
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
        </section>

        <section className="settings-section">
          <div className="section-heading"><span>04</span><div><b>人格</b><small>桌宠的系统提示词</small></div></div>
          <textarea rows={5} value={config.systemPrompt} onChange={(event) => update("systemPrompt", event.target.value)} />
          <label className="switch-row">
            <div><b>自动启动模型</b><span>打开桌宠时准备 llama.cpp</span></div>
            <input type="checkbox" checked={config.autoStart} onChange={(event) => update("autoStart", event.target.checked)} />
          </label>
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
