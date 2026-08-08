import { useMemo, useState } from "react";
import type { ProbeResult, RuntimeConfig } from "../../shared/types";
import { Pet } from "./Pet";
import { PixelIcon } from "./PixelIcon";

interface OnboardingProps {
  initialConfig: RuntimeConfig;
  platform: string;
  onComplete: (config: RuntimeConfig) => Promise<void>;
}

export function Onboarding({ initialConfig, platform, onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState(initialConfig);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const canContinue = useMemo(() => {
    if (step === 1) return probe?.ok === true;
    if (step === 2 && config.modelMode === "local") return config.modelPath.endsWith(".gguf");
    return true;
  }, [config.modelMode, config.modelPath, probe?.ok, step]);

  const update = <K extends keyof RuntimeConfig>(key: K, value: RuntimeConfig[K]) =>
    setConfig((current) => ({ ...current, [key]: value }));

  const selectExecutable = async () => {
    const result = await window.desktopPet.pickExecutable();
    if (!result) return;
    update("executable", result.path);
    setProbe(null);
  };

  const testRuntime = async () => {
    setBusy(true);
    setError("");
    const result = await window.desktopPet.probeRuntime(config.executable);
    setProbe(result);
    if (!result.ok) setError("没有找到可用的 llama.cpp。请先安装，或选择 llama/llama-server 可执行文件。");
    setBusy(false);
  };

  const selectModel = async () => {
    const result = await window.desktopPet.pickModel();
    if (result) update("modelPath", result.path);
  };

  const next = async () => {
    setError("");
    if (step < 3) {
      setStep((value) => value + 1);
      return;
    }
    setBusy(true);
    try {
      await onComplete({ ...config, setupComplete: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setBusy(false);
    }
  };

  return (
    <main className="surface onboarding">
      <div className="window-drag-strip" />
      <header className="onboarding__header">
        <div>
          <p className="eyebrow">DESK-PET · LOCAL FIRST</p>
          <h1>{["你好，我是团子", "连接 llama.cpp", "选择端侧模型", "调好我的小脑袋"][step]}</h1>
        </div>
        <span className="step-count">{step + 1} / 4</span>
      </header>

      <div className="step-track" aria-label={`第 ${step + 1} 步，共 4 步`}>
        {[0, 1, 2, 3].map((item) => (
          <span
            key={item}
            className={item <= step ? "active" : ""}
            aria-current={item === step ? "step" : undefined}
          />
        ))}
      </div>

      <section className="onboarding__body">
        {step === 0 && (
          <div className="welcome-step">
            <Pet mood="idle" compact />
            <div className="welcome-copy">
              <p>
                团子是一只完全运行在你电脑上的 AI 桌宠。日常对话不会发送给云端服务，也不需要 API Key。
              </p>
              <ul className="feature-list">
                <li><b>任意 GGUF</b><span>按需切换 llama.cpp 支持的本地模型</span></li>
                <li><b>llama.cpp</b><span>CPU / Vulkan / CUDA 本地推理</span></li>
                <li><b>隐私优先</b><span>对话只发往 127.0.0.1</span></li>
              </ul>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="form-stack">
            <div className="callout">
              <span>01</span>
              <p>
                {platform === "win32"
                  ? "Windows 推荐先在终端运行 winget install llama.cpp，然后点击检测。"
                  : "请通过 llama.app 安装 llama.cpp，或选择已有的 llama-server。"}
              </p>
            </div>
            <label>
              <span>可执行文件或命令</span>
              <div className="field-row">
                <input
                  value={config.executable}
                  onChange={(event) => {
                    update("executable", event.target.value);
                    setProbe(null);
                  }}
                  placeholder="llama"
                />
                <button className="button button--quiet" type="button" onClick={selectExecutable}>选择</button>
              </div>
            </label>
            <div className="button-row">
              <button className="button button--secondary" type="button" onClick={testRuntime} disabled={busy}>
                {busy ? "检测中…" : "检测 llama.cpp"}
              </button>
              <button
                className="text-button text-button--with-icon"
                type="button"
                onClick={() => window.desktopPet.openExternal("https://github.com/ggml-org/llama.cpp/releases")}
              >
                打开官方下载页 <PixelIcon name="open" />
              </button>
            </div>
            {probe && (
              <div className={`probe-result ${probe.ok ? "success" : "failure"}`}>
                <b>{probe.ok ? "运行时可用" : "检测失败"}</b>
                <span>{probe.ok ? probe.version : probe.error}</span>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="form-stack">
            <div className="segmented">
              <button
                type="button"
                className={config.modelMode === "huggingface" ? "active" : ""}
                onClick={() => update("modelMode", "huggingface")}
              >
                自动下载
                <small>联网</small>
              </button>
              <button
                type="button"
                className={config.modelMode === "local" ? "active" : ""}
                onClick={() => update("modelMode", "local")}
              >
                本地 GGUF
                <small>离线</small>
              </button>
            </div>
            {config.modelMode === "huggingface" ? (
              <>
                <div className="model-card">
                  <div className="model-card__icon"><img src="./app-icon.png" alt="" /></div>
                  <div>
                    <b>准备下载的模型</b>
                    <span>{config.hfRepo}</span>
                  </div>
                  <strong>可切换</strong>
                </div>
                <label>
                  <span>Hugging Face 模型标识</span>
                  <input
                    value={config.hfRepo}
                    onChange={(event) => update("hfRepo", event.target.value)}
                    placeholder="owner/repo:quant"
                  />
                </label>
                <p className="hint">
                  格式为 owner/repo:quant。内置默认模型支持镜像与断点续传；其他模型由 llama.cpp 下载。
                </p>
              </>
            ) : (
              <label>
                <span>llama.cpp 支持的 GGUF 文件</span>
                <div className="field-row">
                  <input value={config.modelPath} readOnly placeholder="请选择 .gguf 文件" />
                  <button className="button button--quiet" type="button" onClick={selectModel}>选择</button>
                </div>
              </label>
            )}
            <button
              className="text-button text-button--with-icon align-left"
              type="button"
              onClick={() => window.desktopPet.openExternal("https://huggingface.co/models?library=gguf")}
            >
              浏览 GGUF 模型并检查许可 <PixelIcon name="open" />
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="form-stack">
            <div className="metric-grid">
              <label>
                <span>上下文长度</span>
                <select value={config.contextSize} onChange={(event) => update("contextSize", Number(event.target.value))}>
                  <option value={4096}>4K · 更省内存</option>
                  <option value={8192}>8K · 推荐</option>
                  <option value={16384}>16K · 长对话</option>
                  <option value={32768}>32K · 高内存</option>
                </select>
              </label>
              <label>
                <span>GPU 卸载层数</span>
                <input
                  type="number"
                  min={0}
                  max={999}
                  value={config.gpuLayers}
                  onChange={(event) => update("gpuLayers", Number(event.target.value))}
                />
              </label>
            </div>
            <label>
              <span>团子的性格设定</span>
              <textarea
                value={config.systemPrompt}
                rows={6}
                onChange={(event) => update("systemPrompt", event.target.value)}
              />
            </label>
            <label className="switch-row">
              <div><b>开机后自动准备模型</b><span>启动桌宠时自动拉起 llama.cpp</span></div>
              <input
                type="checkbox"
                checked={config.autoStart}
                onChange={(event) => update("autoStart", event.target.checked)}
              />
            </label>
          </div>
        )}
      </section>

      {error && <p className="inline-error">{error}</p>}

      <footer className="onboarding__footer">
        <button
          className="button button--quiet"
          type="button"
          onClick={() => setStep((value) => Math.max(0, value - 1))}
          disabled={step === 0 || busy}
        >
          上一步
        </button>
        <button className="button button--primary" type="button" onClick={next} disabled={!canContinue || busy}>
          {step === 3 ? (busy ? "正在保存…" : "完成并唤醒团子") : "继续"}
        </button>
      </footer>
    </main>
  );
}
