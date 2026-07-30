import { useEffect, useMemo, useState } from "react";
import type { BootstrapData, RuntimeConfig, RuntimeState, WindowMode } from "../shared/types";
import { ChatPanel } from "./components/ChatPanel";
import { Onboarding } from "./components/Onboarding";
import { Pet, type PetMood } from "./components/Pet";
import { QuickChat } from "./components/QuickChat";
import { RuntimeBadge } from "./components/RuntimeBadge";
import { Settings } from "./components/Settings";

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [view, setView] = useState<WindowMode>("pet");
  const [fatalError, setFatalError] = useState("");

  useEffect(() => {
    window.desktopPet
      .getBootstrap()
      .then((data) => {
        setBootstrap(data);
        setRuntime(data.runtime);
        const requestedView = new URLSearchParams(location.search).get("view");
        const isKnownView =
          requestedView === "pet" ||
          requestedView === "chat" ||
          requestedView === "settings" ||
          requestedView === "onboarding";
        setView(
          data.config.setupComplete && isKnownView
            ? requestedView
            : data.config.setupComplete
              ? "pet"
              : "onboarding",
        );
      })
      .catch((error) => setFatalError(error instanceof Error ? error.message : String(error)));
    return window.desktopPet.onRuntimeState(setRuntime);
  }, []);

  useEffect(() => window.desktopPet.onOpenView(setView), []);

  useEffect(() => {
    void window.desktopPet.setWindowMode(view);
  }, [view]);

  const mood: PetMood = useMemo(() => {
    if (!runtime) return "sleeping";
    if (runtime.phase === "error") return "sad";
    if (runtime.phase === "starting" || runtime.phase === "downloading") return "thinking";
    if (runtime.phase === "stopped") return "sleeping";
    return "idle";
  }, [runtime]);

  const finishOnboarding = async (nextConfig: RuntimeConfig) => {
    const data = await window.desktopPet.saveConfig(nextConfig);
    setBootstrap(data);
    setRuntime(data.runtime);
    setView("chat");
    setRuntime(await window.desktopPet.startRuntime());
  };

  const saveSettings = async (nextConfig: RuntimeConfig, restart: boolean) => {
    const data = await window.desktopPet.saveConfig({ ...nextConfig, setupComplete: true });
    setBootstrap(data);
    setRuntime(data.runtime);
    if (restart) setRuntime(await window.desktopPet.restartRuntime());
    setView("pet");
  };

  const startRuntime = async () => setRuntime(await window.desktopPet.startRuntime());

  if (fatalError) {
    return (
      <main className="surface fatal-error">
        <h1>desk-pet 没能醒来</h1>
        <p>{fatalError}</p>
        <button className="button button--primary" type="button" onClick={() => location.reload()}>重试</button>
      </main>
    );
  }

  if (!bootstrap || !runtime) {
    return (
      <main className="loading-screen">
        <Pet mood="sleeping" phase="stopped" compact />
        <p>正在启动 desk-pet…</p>
      </main>
    );
  }

  if (view === "onboarding" || !bootstrap.config.setupComplete) {
    return (
      <Onboarding
        initialConfig={bootstrap.config}
        platform={bootstrap.platform}
        onComplete={finishOnboarding}
      />
    );
  }

  if (view === "chat") {
    return (
      <ChatPanel
        runtime={runtime}
        onClose={() => setView("pet")}
        onSettings={() => setView("settings")}
        onStartRuntime={startRuntime}
      />
    );
  }

  if (view === "settings") {
    return (
      <Settings
        initialConfig={bootstrap.config}
        runtime={runtime}
        onClose={() => setView("pet")}
        onSave={saveSettings}
      />
    );
  }

  return (
    <main className="pet-stage">
      <div className="pet-drag-handle" aria-label="拖动窗口"><i /><i /><i /></div>
      <div className="pet-stage__actions">
        <RuntimeBadge runtime={runtime} />
        <button className="mini-icon-button" type="button" onClick={() => setView("settings")} aria-label="设置">⚙</button>
        <button className="mini-icon-button" type="button" onClick={() => window.desktopPet.hideWindow()} aria-label="隐藏">×</button>
      </div>
      <QuickChat
        runtime={runtime}
        onOpenChat={() => setView("chat")}
        onStartRuntime={startRuntime}
      />
      <Pet mood={mood} phase={runtime.phase} onClick={() => setView("chat")} />
    </main>
  );
}
