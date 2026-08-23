import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { CaptionConfig, CaptionState } from "../shared/types";
import { sendCaptionAudio } from "./caption-audio-channel";
import { StableCaptionPresenter, type CaptionPresentation } from "./caption-display";
import { PixelIcon } from "./components/PixelIcon";

interface CaptureResources {
  stream: MediaStream;
  audioStream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  worklet: AudioWorkletNode;
  silentGain: GainNode;
  frameWatchdog: ReturnType<typeof setTimeout>;
  removeListeners: () => void;
}

interface CaptureFeedback {
  hasFrames: boolean;
  heardSignal: boolean;
}

interface WorkletChunk {
  samples: Float32Array;
  level: number;
}

const EMPTY_FEEDBACK: CaptureFeedback = { hasFrames: false, heardSignal: false };

function closeCapture(resources: CaptureResources | null): void {
  if (!resources) return;
  clearTimeout(resources.frameWatchdog);
  resources.removeListeners();
  resources.worklet.port.onmessage = null;
  resources.source.disconnect();
  resources.worklet.disconnect();
  resources.silentGain.disconnect();
  for (const track of resources.stream.getTracks()) track.stop();
  void resources.context.close();
}

function phaseLabel(state: CaptionState | null, feedback: CaptureFeedback): string {
  if (!state) return "正在初始化";
  if (state.phase === "capturing" && feedback.heardSignal) return "正在显示字幕";
  if (state.phase === "capturing" && feedback.hasFrames) return "等待声音";
  if (state.phase === "capturing") return "正在连接";
  if (state.phase === "downloading") return "下载模型";
  if (state.phase === "loading") return "加载模型";
  if (state.phase === "not-installed") return "需要字幕模型";
  if (state.phase === "error") return "字幕已暂停";
  return "实时字幕";
}

export function CaptionApp() {
  const [state, setState] = useState<CaptionState | null>(null);
  const [config, setConfig] = useState<CaptionConfig>({ layoutVersion: 3, fontSize: 22, opacity: 0.96 });
  const [localError, setLocalError] = useState<string>();
  const [feedback, setFeedback] = useState<CaptureFeedback>(EMPTY_FEEDBACK);
  const [display, setDisplay] = useState<CaptionPresentation>({ lines: [], live: false });
  const resourcesRef = useRef<CaptureResources | null>(null);
  const presenterRef = useRef(new StableCaptionPresenter());
  const stoppingRef = useRef(false);

  const releaseCapture = (): void => {
    const resources = resourcesRef.current;
    resourcesRef.current = null;
    closeCapture(resources);
  };

  useEffect(() => {
    void window.desktopPet.getBootstrap().then((bootstrap) => {
      setState(bootstrap.caption);
      setConfig(bootstrap.config.caption);
    }).catch((error) => setLocalError(error instanceof Error ? error.message : String(error)));
    const unsubscribeState = window.desktopPet.onCaptionState(setState);
    const unsubscribeConfig = window.desktopPet.onCaptionConfig(setConfig);
    return () => {
      unsubscribeState();
      unsubscribeConfig();
      releaseCapture();
    };
  }, []);

  useEffect(() => {
    if (state?.phase !== "capturing" && resourcesRef.current) releaseCapture();
  }, [state?.phase]);

  useEffect(() => {
    setDisplay(presenterRef.current.update(state, config.fontSize));
  }, [state, config.fontSize]);

  const prepare = async (force = false): Promise<void> => {
    if (!window.confirm(force
      ? "将重新下载约 650 MB 的本地英文实时字幕模型，是否继续？"
      : "首次使用实时字幕需要下载约 650 MB 的本地英文模型。模型将保存在项目或应用旁的 models/speech，是否继续？")) return;
    setLocalError(undefined);
    try {
      setState(await window.desktopPet.prepareCaption(force));
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  };

  const start = async (): Promise<void> => {
    if (!state || state.phase === "downloading" || state.phase === "loading") return;
    if (state.phase === "not-installed") {
      await prepare(false);
      return;
    }
    setLocalError(undefined);
    setFeedback(EMPTY_FEEDBACK);
    releaseCapture();
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let startedSessionId: string | undefined;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) throw new Error("没有获得系统输出音频，请确认 Windows 允许桌面音频采集。");
      // Chromium's Windows loopback track can share the same desktop capture source
      // as the video track. Stopping video immediately may leave a dead audio track,
      // so keep it alive (but disabled) until the whole capture session is closed.
      for (const track of stream.getVideoTracks()) track.enabled = false;
      if (audioTrack.readyState === "ended") throw new Error("系统输出音频轨道已提前结束，请重新开始。");

      const started = await window.desktopPet.startLiveCaption();
      if (started.phase !== "capturing" || !started.sessionId) {
        for (const track of stream.getTracks()) track.stop();
        if (started.phase === "not-installed") await prepare(false);
        return;
      }
      startedSessionId = started.sessionId;

      context = new AudioContext();
      await context.audioWorklet.addModule(new URL("./caption-audio-processor.js", location.href));
      await context.resume();
      if (context.state !== "running") throw new Error("系统音频处理器未能启动，请重新点击开始。");
      const audioStream = new MediaStream([audioTrack]);
      const source = context.createMediaStreamSource(audioStream);
      const worklet = new AudioWorkletNode(context, "caption-audio-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      source.connect(worklet).connect(silentGain).connect(context.destination);
      let receivedFrames = false;
      let heardSignal = false;
      let failed = false;
      const failCapture = (message: string): void => {
        if (failed || stoppingRef.current) return;
        failed = true;
        releaseCapture();
        setFeedback(EMPTY_FEEDBACK);
        setLocalError(message);
        window.desktopPet.notifyCaptionCaptureEnded(message);
      };
      worklet.port.onmessage = (event: MessageEvent<WorkletChunk>) => {
        const chunk = event.data;
        if (!(chunk?.samples instanceof Float32Array) || !chunk.samples.length) return;
        const firstFrame = !receivedFrames;
        const signalStarted = !heardSignal
          && Number.isFinite(chunk.level)
          && chunk.level >= 0.0008;
        receivedFrames = true;
        heardSignal ||= signalStarted;
        if (firstFrame || signalStarted) {
          setFeedback({ hasFrames: true, heardSignal });
        }
        if (!sendCaptionAudio(started.sessionId!, context!.sampleRate, chunk.samples)) {
          failCapture("字幕音频通道未连接，请关闭字幕窗口后重新打开。");
        }
      };
      const handleTrackEnded = (): void => failCapture("系统输出音频已停止，请重新启动实时字幕。");
      const handleDeviceChange = (): void => failCapture("默认音频输出设备可能已变化，请重新启动实时字幕。");
      audioTrack.addEventListener("ended", handleTrackEnded, { once: true });
      navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
      const frameWatchdog = setTimeout(() => {
        if (!receivedFrames) failCapture("没有收到系统音频数据。请确认视频正在播放，然后重新开始实时字幕。");
      }, 4_000);
      resourcesRef.current = {
        stream,
        audioStream,
        context,
        source,
        worklet,
        silentGain,
        frameWatchdog,
        removeListeners: () => {
          audioTrack.removeEventListener("ended", handleTrackEnded);
          navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
        },
      };
      setState(started);
    } catch (error) {
      if (stream) for (const track of stream.getTracks()) track.stop();
      if (context) void context.close();
      const message = error instanceof Error ? error.message : String(error);
      setFeedback(EMPTY_FEEDBACK);
      setLocalError(message);
      if (startedSessionId) window.desktopPet.notifyCaptionCaptureEnded(message);
    }
  };

  const stop = async (): Promise<void> => {
    stoppingRef.current = true;
    releaseCapture();
    setFeedback(EMPTY_FEEDBACK);
    try {
      setState(await window.desktopPet.stopLiveCaption());
    } finally {
      stoppingRef.current = false;
    }
  };

  const close = async (): Promise<void> => {
    stoppingRef.current = true;
    releaseCapture();
    await window.desktopPet.closeCaptionWindow();
  };

  const updateConfig = async (next: CaptionConfig): Promise<void> => {
    setConfig(next);
    try {
      setConfig(await window.desktopPet.updateCaptionConfig(next));
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  };

  const busy = state?.phase === "downloading" || state?.phase === "loading";
  const capturing = state?.phase === "capturing";
  const message = localError ?? state?.error ?? (
    state?.phase === "downloading" || state?.phase === "loading" ? state.message : undefined
  );

  return (
    <main
      className={`caption-shell${capturing ? " is-capturing" : ""}${state?.phase === "error" || localError ? " has-error" : ""}`}
      style={{
        "--caption-font-size": `${config.fontSize}px`,
      } as CSSProperties}
    >
      <header className="caption-header caption-drag">
        <div className="caption-status">
          <i aria-hidden="true" />
          <span>{phaseLabel(state, feedback)}</span>
        </div>
        <div className="caption-controls caption-no-drag" role="toolbar" aria-label="实时字幕控制">
          <button type="button" title="缩小字幕" onClick={() => void updateConfig({ ...config, fontSize: config.fontSize - 2 })} disabled={config.fontSize <= 16} aria-label="缩小字幕"><PixelIcon name="minus" className="caption-icon" /></button>
          <button type="button" title="放大字幕" onClick={() => void updateConfig({ ...config, fontSize: config.fontSize + 2 })} disabled={config.fontSize >= 36} aria-label="放大字幕"><PixelIcon name="plus" className="caption-icon" /></button>
          <button type="button" title="清空字幕" onClick={() => void window.desktopPet.clearCaptionHistory().then(setState)} disabled={!state?.segments.length} aria-label="清空字幕"><PixelIcon name="clear" className="caption-icon" /></button>
          {capturing
            ? <button className="caption-primary is-stop" type="button" title="停止字幕" onClick={() => void stop()} aria-label="停止字幕"><PixelIcon name="stop" className="caption-icon" /></button>
            : <button className="caption-primary" type="button" title={state?.phase === "not-installed" ? "下载字幕模型" : "开始字幕"} onClick={() => void start()} disabled={busy} aria-label={state?.phase === "not-installed" ? "下载字幕模型" : "开始字幕"}><PixelIcon name={state?.phase === "not-installed" ? "download" : "play"} className="caption-icon" /></button>}
          <button className="caption-close" type="button" title="关闭字幕" onClick={() => void close()} aria-label="关闭字幕"><PixelIcon name="close" className="caption-icon" /></button>
        </div>
      </header>

      <section className="caption-lines" aria-live="polite" aria-atomic="true">
        <div className="caption-lines-content">
          {display.lines.length
            ? <p className={`caption-text${display.live ? " is-live" : ""}`}>{display.lines.map((line, index) => <span className="caption-line" key={index}>{line}</span>)}</p>
            : <p className="caption-placeholder">{capturing ? "等待播放声音…" : "实时字幕已就绪"}</p>}
        </div>
      </section>

      {(message || state?.progress) && (
        <footer className="caption-footer">
          <span>{message}</span>
          {state?.progress?.percent !== undefined && <b>{state.progress.percent.toFixed(0)}%</b>}
        </footer>
      )}
    </main>
  );
}
