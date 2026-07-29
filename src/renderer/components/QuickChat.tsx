import { useEffect, useRef, useState } from "react";
import type { ChatEvent, ChatMessage, RuntimeState } from "../../shared/types";

interface QuickChatProps {
  runtime: RuntimeState;
  onOpenChat: () => void;
  onStartRuntime: () => Promise<void>;
}

function runtimeHint(runtime: RuntimeState): string {
  if (runtime.phase === "error") return runtime.error ?? "模型启动失败，请重试。";
  if (runtime.phase === "downloading") return runtime.message;
  if (runtime.phase === "starting") return "正在加载本地模型…";
  if (runtime.phase === "stopping") return "模型正在停止…";
  if (runtime.phase === "stopped") return "先唤醒本地模型，就能在这里聊一句。";
  return "不用展开窗口，直接和我聊一句。";
}

export function QuickChat({ runtime, onOpenChat, onStartRuntime }: QuickChatProps) {
  const [input, setInput] = useState("");
  const [reply, setReply] = useState("");
  const [starting, setStarting] = useState(false);
  const activeRequest = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = window.desktopPet.onChatEvent((event: ChatEvent) => {
      if (event.requestId !== activeRequest.current) return;
      if (event.type === "delta") setReply((current) => current + event.text);
      if (event.type === "error") {
        setReply(event.message === "已停止生成" ? "（停在这里啦）" : `⚠ ${event.message}`);
        activeRequest.current = null;
      }
      if (event.type === "done") {
        setReply((current) => current || "这次没有生成内容，要不要换个问法？");
        activeRequest.current = null;
      }
    });
    return () => {
      unsubscribe();
      if (activeRequest.current) window.desktopPet.abortChat(activeRequest.current);
    };
  }, []);

  const submit = () => {
    const content = input.trim();
    if (!content || runtime.phase !== "ready" || activeRequest.current) return;
    const requestId = crypto.randomUUID();
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: Date.now(),
    };
    activeRequest.current = requestId;
    setInput("");
    setReply("");
    window.desktopPet.startChat({
      requestId,
      messages: [message],
      thinking: false,
    });
  };

  const stop = () => {
    if (activeRequest.current) window.desktopPet.abortChat(activeRequest.current);
  };

  const start = async () => {
    setStarting(true);
    try {
      await onStartRuntime();
    } catch (error) {
      setReply(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  };

  const isGenerating = activeRequest.current !== null;
  const ready = runtime.phase === "ready";

  return (
    <section className={`quick-chat ${reply ? "quick-chat--has-reply" : ""}`}>
      <div className="quick-chat__message">
        <span className="quick-chat__avatar">团</span>
        <p title={reply || runtimeHint(runtime)}>{reply || runtimeHint(runtime)}</p>
        <button type="button" onClick={onOpenChat} aria-label="打开完整对话" title="打开完整对话">↗</button>
      </div>

      {ready ? (
        <form
          className="quick-chat__composer"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={isGenerating ? "正在回答…" : "快速聊一句…"}
            disabled={isGenerating}
            aria-label="快捷对话"
          />
          <button
            type={isGenerating ? "button" : "submit"}
            onClick={isGenerating ? stop : undefined}
            disabled={!isGenerating && !input.trim()}
            aria-label={isGenerating ? "停止生成" : "发送"}
          >
            {isGenerating ? "■" : "↑"}
          </button>
        </form>
      ) : (
        <button
          className="quick-chat__wake"
          type="button"
          onClick={() => void start()}
          disabled={starting || runtime.phase === "starting" || runtime.phase === "downloading"}
        >
          {starting || runtime.phase === "starting" || runtime.phase === "downloading"
            ? "正在准备模型…"
            : runtime.phase === "error"
              ? "重试启动"
              : "唤醒模型"}
        </button>
      )}
    </section>
  );
}
