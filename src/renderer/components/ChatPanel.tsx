import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent, ChatImage, ChatMessage, RuntimeState, SpeechState } from "../../shared/types";
import { readChatHistory, writeChatHistory } from "../chat-history";
import { Pet, type PetMood } from "./Pet";
import { RuntimeBadge } from "./RuntimeBadge";
import { VoiceButton } from "./VoiceButton";
import { ImageAttachButton, ImageAttachmentTray } from "./ImageAttachments";

interface ChatPanelProps {
  runtime: RuntimeState;
  speech: SpeechState;
  draft: string;
  images: ChatImage[];
  onDraftChange: (value: string) => void;
  onImagesChange: (images: ChatImage[]) => void;
  visionEnabled: boolean;
  onPrepareSpeech: () => Promise<void>;
  onStartSpeech: () => Promise<string | undefined>;
  onStopSpeech: (sessionId: string) => Promise<void>;
  onCancelSpeech: (sessionId: string) => Promise<void>;
  onClose: () => void;
  onSettings: () => void;
  onStartRuntime: () => Promise<void>;
}

export function ChatPanel({
  runtime,
  speech,
  draft,
  images,
  onDraftChange,
  onImagesChange,
  visionEnabled,
  onPrepareSpeech,
  onStartSpeech,
  onStopSpeech,
  onCancelSpeech,
  onClose,
  onSettings,
  onStartRuntime,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(readChatHistory);
  const [thinking, setThinking] = useState(false);
  const [activeRequest, setActiveRequest] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const assistantByRequest = useRef(new Map<string, string>());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    writeChatHistory(messages);
    requestAnimationFrame(() => {
      if (scrollRef.current)
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, [messages]);

  useEffect(
    () =>
      window.desktopPet.onChatEvent((event: ChatEvent) => {
        const assistantId = assistantByRequest.current.get(event.requestId);
        if (!assistantId) return;
        if (event.type === "warning") setAttachmentError(event.message);
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
                        (event.message === "已停止生成"
                          ? "（团子停下了）"
                          : `⚠ ${event.message}`),
                    }
                  : message,
              ),
            );
          }
          assistantByRequest.current.delete(event.requestId);
          setActiveRequest((current) =>
            current === event.requestId ? null : current,
          );
        }
      }),
    [],
  );

  const mood: PetMood = useMemo(() => {
    if (speech.phase === "recording") return "listening";
    if (speech.phase === "transcribing") return "transcribing";
    if (runtime.phase === "error") return "sad";
    if (
      runtime.phase === "starting" ||
      runtime.phase === "downloading" ||
      activeRequest
    )
      return "thinking";
    if (messages.at(-1)?.role === "assistant") return "talking";
    return "idle";
  }, [activeRequest, messages, runtime.phase, speech.phase]);

  const send = () => {
    const text = draft.trim();
    if ((!text && !images.length) || activeRequest || runtime.phase !== "ready") return;
    const requestId = crypto.randomUUID();
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      images: images.length ? images : undefined,
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
    onDraftChange("");
    onImagesChange([]);
    setAttachmentError("");
    setActiveRequest(requestId);
    window.desktopPet.startChat({
      requestId,
      messages: nextMessages,
      thinking,
    });
  };

  const removeImage = (index: number) => {
    onImagesChange(images.filter((_image, imageIndex) => imageIndex !== index));
  };

  const speechBusy = speech.phase === "recording" || speech.phase === "transcribing";

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
          <span className="brand-mark">
            <img src="./app-icon.png" alt="" />
          </span>
          <div>
            <b>团子</b>
            <small>一只不偷数据，只偷算力的橘猫</small>
          </div>
        </div>
        <div className="header-actions">
          <RuntimeBadge runtime={runtime} />
          <button
            className="icon-button"
            type="button"
            onClick={onSettings}
            aria-label="设置"
          >
            ⚙
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="收起"
          >
            ×
          </button>
        </div>
      </header>

      <section className="chat-log" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="empty-chat">
            <Pet mood={mood} compact />
            <h2>今天想聊点什么？</h2>
            <p></p>
            <div className="suggestion-grid">
              {[
                "给今天的我来一句橘猫式鼓励",
                "用橘猫口吻吐槽一下加班",
                "编一个橘猫偷吃却拒不承认的故事",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => onDraftChange(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              className={`message message--${message.role}`}
            >
              {message.role === "assistant" && (
                <span className="message-avatar">团</span>
              )}
              <div className="message-content">
                <ImageAttachmentTray images={message.images ?? []} />
                {message.reasoning && (
                  <details className="reasoning">
                    <summary>团子的思考</summary>
                    <p>{message.reasoning}</p>
                  </details>
                )}
                {(message.content || message.role === "assistant") && <p className={!message.content ? "typing-dots" : ""}>
                  {message.content || (
                    <>
                      <i />
                      <i />
                      <i />
                    </>
                  )}
                </p>}
              </div>
            </article>
          ))
        )}
      </section>

      {runtime.phase !== "ready" && (
        <section
          className={`runtime-notice ${runtime.phase === "error" ? "runtime-notice--error" : ""}`}
        >
          <div>
            <b>{runtime.message}</b>
            <span>
              {runtime.error ?? runtime.lastLog ?? "准备完成后就可以开始聊天。"}
            </span>
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
            <button
              className="button button--secondary"
              type="button"
              onClick={onStartRuntime}
            >
              启动模型
            </button>
          )}
        </section>
      )}

      {(speech.phase === "recording" || speech.phase === "transcribing") && (
        <section className={`voice-pet-indicator phase-${speech.phase}`} aria-live="polite">
          <Pet
            mood={speech.phase === "recording" ? "listening" : "transcribing"}
            compact
          />
          <div>
            <b>{speech.phase === "recording" ? "团子在认真听" : "团子正在转成文字"}</b>
            <span>{speech.message}</span>
          </div>
        </section>
      )}

      <footer className="composer">
        <div className="composer__toolbar">
          <div className="composer__tools">
            <button
              type="button"
              className="thinking-toggle"
              onClick={() => setThinking((value) => !value)}
              aria-pressed={thinking}
              aria-label={thinking ? "当前为深度思考，点击切换到快速回答" : "当前为快速回答，点击切换到深度思考"}
              title={thinking
                ? "当前：深度思考。点击切换到快速回答"
                : "当前：快速回答。点击切换到深度思考（需要模型支持）"}
            >
              <span className={`thinking-toggle__option thinking-toggle__option--quick ${!thinking ? "active" : ""}`}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M9.2 1.7 3.8 8.5h3.7l-.7 5.8 5.4-7H8.5l.7-5.6Z" />
                </svg>
                快速回答
              </span>
              <span className={`thinking-toggle__option thinking-toggle__option--deep ${thinking ? "active" : ""}`}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 1.7c.5 3.3 1.8 4.6 5.1 5.1-3.3.5-4.6 1.8-5.1 5.1-.5-3.3-1.8-4.6-5.1-5.1C6.2 6.3 7.5 5 8 1.7Zm4.4 9c.2 1.2.7 1.7 1.9 1.9-1.2.2-1.7.7-1.9 1.9-.2-1.2-.7-1.7-1.9-1.9 1.2-.2 1.7-.7 1.9-1.9Z" />
                </svg>
                深度思考
              </span>
            </button>
            <ImageAttachButton
              images={images}
              disabled={!visionEnabled || runtime.phase !== "ready" || Boolean(activeRequest) || speechBusy}
              onChange={onImagesChange}
              onError={setAttachmentError}
            />
          </div>
          {messages.length > 0 && !activeRequest && (
            <button
              className="text-button"
              type="button"
              onClick={() => setMessages([])}
            >
              清空对话
            </button>
          )}
        </div>
        <ImageAttachmentTray images={images} onRemove={removeImage} />
        {attachmentError && <p className="composer__error">{attachmentError}</p>}
        <div className="composer__input">
          <textarea
            rows={2}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onFocus={() => window.desktopPet.setSpeechComposerFocused(true)}
            onBlur={() => window.desktopPet.setSpeechComposerFocused(false)}
            onKeyDown={handleKeyDown}
            placeholder={
              speech.phase === "recording"
                ? "正在听你说话…"
                : speech.phase === "transcribing"
                  ? "团子正在整理语音…"
                  : runtime.phase === "ready"
                ? "和团子说点什么…"
                : "等待本地模型就绪…"
            }
            disabled={runtime.phase !== "ready" || speechBusy}
          />
          <VoiceButton
            speech={speech}
            compact
            onPrepare={onPrepareSpeech}
            onStart={onStartSpeech}
            onStop={onStopSpeech}
            onCancel={onCancelSpeech}
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
              disabled={(!draft.trim() && !images.length) || runtime.phase !== "ready" || speechBusy}
              aria-label="发送"
            >
              ↑
            </button>
          )}
        </div>
        <small className="privacy-note">
          AI生成可能不准确，请核实重要信息
        </small>
      </footer>
    </main>
  );
}
