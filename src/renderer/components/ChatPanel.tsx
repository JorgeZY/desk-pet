import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent, ChatMessage, RuntimeState } from "../../shared/types";
import { readChatHistory, writeChatHistory } from "../chat-history";
import { Pet, type PetMood } from "./Pet";
import { RuntimeBadge } from "./RuntimeBadge";

interface ChatPanelProps {
  runtime: RuntimeState;
  onClose: () => void;
  onSettings: () => void;
  onStartRuntime: () => Promise<void>;
}

export function ChatPanel({ runtime, onClose, onSettings, onStartRuntime }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(readChatHistory);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [activeRequest, setActiveRequest] = useState<string | null>(null);
  const assistantByRequest = useRef(new Map<string, string>());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    writeChatHistory(messages);
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, [messages]);

  useEffect(
    () =>
      window.desktopPet.onChatEvent((event: ChatEvent) => {
        const assistantId = assistantByRequest.current.get(event.requestId);
        if (!assistantId) return;
        if (event.type === "delta" || event.type === "reasoning") {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    ...(event.type === "delta"
                      ? { content: message.content + event.text }
                      : { reasoning: (message.reasoning ?? "") + event.text }),
                  }
                : message,
            ),
          );
        }
        if (event.type === "done" || event.type === "error") {
          if (event.type === "error") {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      content:
                        message.content ||
                        (event.message === "已停止生成" ? "（团子停下了）" : `⚠ ${event.message}`),
                    }
                  : message,
              ),
            );
          }
          assistantByRequest.current.delete(event.requestId);
          setActiveRequest((current) => (current === event.requestId ? null : current));
        }
      }),
    [],
  );

  const mood: PetMood = useMemo(() => {
    if (runtime.phase === "error") return "sad";
    if (runtime.phase === "starting" || runtime.phase === "downloading" || activeRequest) return "thinking";
    if (messages.at(-1)?.role === "assistant") return "talking";
    return "idle";
  }, [activeRequest, messages, runtime.phase]);

  const send = () => {
    const text = input.trim();
    if (!text || activeRequest || runtime.phase !== "ready") return;
    const requestId = crypto.randomUUID();
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };
    const nextMessages = [...messages, user];
    assistantByRequest.current.set(requestId, assistant.id);
    setMessages([...nextMessages, assistant]);
    setInput("");
    setActiveRequest(requestId);
    window.desktopPet.startChat({ requestId, messages: nextMessages, thinking });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  return (
    <main className="surface chat-panel">
      <div className="window-drag-strip" />
      <header className="panel-header">
        <div className="brand-lockup">
          <span className="brand-mark"><img src="./app-icon.png" alt="" /></span>
          <div><b>desk-pet · 团子</b><small>llama.cpp · 本地桌宠</small></div>
        </div>
        <div className="header-actions">
          <RuntimeBadge runtime={runtime} />
          <button className="icon-button" type="button" onClick={onSettings} aria-label="设置">⚙</button>
          <button className="icon-button" type="button" onClick={onClose} aria-label="收起">×</button>
        </div>
      </header>

      <section className="chat-log" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="empty-chat">
            <Pet mood={mood} phase={runtime.phase} compact />
            <h2>今天想聊点什么？</h2>
            <p>所有消息只会发送给这台电脑上的 llama.cpp。</p>
            <div className="suggestion-grid">
              {["帮我规划今天的工作", "讲一个两分钟的小故事", "解释一段技术概念"].map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => setInput(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <article key={message.id} className={`message message--${message.role}`}>
              {message.role === "assistant" && <span className="message-avatar">团</span>}
              <div className="message-content">
                {message.reasoning && (
                  <details className="reasoning">
                    <summary>团子的思考</summary>
                    <p>{message.reasoning}</p>
                  </details>
                )}
                <p className={!message.content ? "typing-dots" : ""}>
                  {message.content || <><i /><i /><i /></>}
                </p>
              </div>
            </article>
          ))
        )}
      </section>

      {runtime.phase !== "ready" && (
        <section className={`runtime-notice ${runtime.phase === "error" ? "runtime-notice--error" : ""}`}>
          <div>
            <b>{runtime.message}</b>
            <span>{runtime.error ?? runtime.lastLog ?? "准备完成后就可以开始聊天。"}</span>
            {runtime.phase === "downloading" && (
              <div
                className={`runtime-progress ${runtime.download?.percent === undefined ? "indeterminate" : ""}`}
                role="progressbar"
                aria-label="模型下载进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={runtime.download?.percent}
              >
                <i style={{ width: `${runtime.download?.percent ?? 32}%` }} />
              </div>
            )}
          </div>
          {(runtime.phase === "stopped" || runtime.phase === "error") && (
            <button className="button button--secondary" type="button" onClick={onStartRuntime}>启动模型</button>
          )}
        </section>
      )}

      <footer className="composer">
        <div className="composer__toolbar">
          <button
            type="button"
            className={`thinking-toggle ${thinking ? "active" : ""}`}
            onClick={() => setThinking((value) => !value)}
            title="深度思考模式（需要当前模型支持）"
          >
            <span>✦</span>{thinking ? "深度思考" : "快速回答"}
          </button>
          {messages.length > 0 && !activeRequest && (
            <button className="text-button" type="button" onClick={() => setMessages([])}>清空对话</button>
          )}
        </div>
        <div className="composer__input">
          <textarea
            rows={2}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={runtime.phase === "ready" ? "和团子说点什么…" : "等待本地模型就绪…"}
            disabled={runtime.phase !== "ready"}
          />
          {activeRequest ? (
            <button
              className="send-button stop-button"
              type="button"
              onClick={() => window.desktopPet.abortChat(activeRequest)}
              aria-label="停止生成"
            >
              ■
            </button>
          ) : (
            <button
              className="send-button"
              type="button"
              onClick={send}
              disabled={!input.trim() || runtime.phase !== "ready"}
              aria-label="发送"
            >
              ↑
            </button>
          )}
        </div>
        <small className="privacy-note">本地生成可能不准确，请核实重要信息</small>
      </footer>
    </main>
  );
}
