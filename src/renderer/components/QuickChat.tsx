import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatEvent, ChatImage, ChatMessage, RuntimeState, SpeechState } from "../../shared/types";
import { PET_WINDOW_BASE_HEIGHT, PET_WINDOW_MAX_HEIGHT, quickReplyWindowHeight } from "../../shared/pet-window";
import { appendChatMessages, readChatHistory, updateChatMessage } from "../chat-history";
import { VoiceButton } from "./VoiceButton";
import { ImageAttachButton, ImageAttachmentTray } from "./ImageAttachments";

interface QuickChatProps {
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

export function resetQuickChatWindowHeight(
  setPetWindowHeight: (height: number) => Promise<void>,
): void {
  void setPetWindowHeight(PET_WINDOW_BASE_HEIGHT);
}

export function QuickChat({
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
  onOpenChat,
  onStartRuntime,
}: QuickChatProps) {
  const [reply, setReply] = useState("");
  const [starting, setStarting] = useState(false);
  const [activeRequest, setActiveRequest] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const activeRequestRef = useRef<string | null>(null);
  const assistantIdRef = useRef<string | null>(null);
  const replyRef = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);
  const replyElementRef = useRef<HTMLParagraphElement>(null);
  const shouldRestoreFocusRef = useRef(false);
  const lastWindowHeightRef = useRef(0);

  const changeActiveRequest = (requestId: string | null) => {
    activeRequestRef.current = requestId;
    setActiveRequest(requestId);
  };

  const saveAssistantReply = (content: string) => {
    const assistantId = assistantIdRef.current;
    if (!assistantId) return;
    updateChatMessage(assistantId, (message) => ({ ...message, content }));
  };

  useEffect(() => {
    const unsubscribe = window.desktopPet.onChatEvent((event: ChatEvent) => {
      if (event.requestId !== activeRequestRef.current) return;
      if (event.type === "warning") setAttachmentError(event.message);
      if (event.type === "delta") {
        const nextReply = replyRef.current + event.text;
        replyRef.current = nextReply;
        setReply(nextReply);
        saveAssistantReply(nextReply);
      }
      if (event.type === "reasoning") {
        const assistantId = assistantIdRef.current;
        if (assistantId) {
          updateChatMessage(assistantId, (message) => ({
            ...message,
            reasoning: (message.reasoning ?? "") + event.text,
          }));
        }
      }
      if (event.type === "error") {
        const fallback = event.message === "已停止生成" ? "（停在这里啦）" : `⚠ ${event.message}`;
        const finalReply = replyRef.current || fallback;
        replyRef.current = finalReply;
        setReply(finalReply);
        saveAssistantReply(finalReply);
        changeActiveRequest(null);
      }
      if (event.type === "done") {
        const finalReply = replyRef.current || "这次没有生成内容，要不要换个问法？";
        replyRef.current = finalReply;
        setReply(finalReply);
        saveAssistantReply(finalReply);
        changeActiveRequest(null);
      }
    });
    return () => {
      unsubscribe();
      const requestId = activeRequestRef.current;
      if (requestId) {
        window.desktopPet.abortChat(requestId);
        saveAssistantReply(replyRef.current || "（快捷回答已停止，可在完整对话中继续。）");
        activeRequestRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (activeRequest || !shouldRestoreFocusRef.current || runtime.phase !== "ready") return;

    shouldRestoreFocusRef.current = false;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeRequest, runtime.phase]);

  const submit = () => {
    const content = draft.trim();
    if ((!content && !images.length) || runtime.phase !== "ready" || activeRequestRef.current) return;
    const requestId = crypto.randomUUID();
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      images: images.length ? images : undefined,
      createdAt: Date.now(),
    };
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };
    const nextMessages = [...readChatHistory(), user];
    appendChatMessages([user, assistant]);
    assistantIdRef.current = assistant.id;
    replyRef.current = "";
    shouldRestoreFocusRef.current = true;
    changeActiveRequest(requestId);
    onDraftChange("");
    onImagesChange([]);
    setAttachmentError("");
    setReply("");
    window.desktopPet.startChat({
      requestId,
      messages: nextMessages,
      thinking: false,
    });
  };

  const stop = () => {
    const requestId = activeRequestRef.current;
    if (!requestId) return;
    window.desktopPet.abortChat(requestId);
    const finalReply = replyRef.current || "（停在这里啦）";
    replyRef.current = finalReply;
    setReply(finalReply);
    saveAssistantReply(finalReply);
    changeActiveRequest(null);
  };

  const openFullChat = () => {
    const requestId = activeRequestRef.current;
    if (requestId) {
      window.desktopPet.abortChat(requestId);
      saveAssistantReply(replyRef.current || "（快捷回答已停止，可在完整对话中继续。）");
      changeActiveRequest(null);
    }
    onOpenChat();
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

  const isGenerating = activeRequest !== null;
  const ready = runtime.phase === "ready";
  const speechBusy = speech.phase === "recording" || speech.phase === "transcribing";
  const visibleReply = speechBusy ? speech.message : reply || runtimeHint(runtime);

  const removeImage = (index: number) => {
    onImagesChange(images.filter((_image, imageIndex) => imageIndex !== index));
  };

  useLayoutEffect(() => {
    const replyElement = replyElementRef.current;
    if (!replyElement) return;
    const contentHeight = quickReplyWindowHeight(replyElement.scrollHeight, Boolean(reply));
    const nextHeight = Math.min(
      PET_WINDOW_MAX_HEIGHT,
      contentHeight + (images.length || attachmentError ? 48 : 0),
    );
    if (nextHeight === lastWindowHeightRef.current) return;
    lastWindowHeightRef.current = nextHeight;
    void window.desktopPet.setPetWindowHeight(nextHeight);
  }, [attachmentError, images.length, reply, visibleReply]);

  useLayoutEffect(() => () => {
    lastWindowHeightRef.current = PET_WINDOW_BASE_HEIGHT;
    resetQuickChatWindowHeight(window.desktopPet.setPetWindowHeight);
  }, []);

  return (
    <section className={`quick-chat ${reply ? "quick-chat--has-reply" : ""}`}>
      <div className="quick-chat__message">
        <span className="quick-chat__avatar">团</span>
        <p ref={replyElementRef} title={visibleReply} aria-live="polite">{visibleReply}</p>
        <button type="button" onClick={openFullChat} aria-label="打开完整对话" title="打开完整对话">↗</button>
      </div>

      {ready ? (
        <>
          <ImageAttachmentTray images={images} onRemove={removeImage} compact />
          {attachmentError && <p className="quick-chat__error">{attachmentError}</p>}
          <form
            className="quick-chat__composer"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onFocus={() => window.desktopPet.setSpeechComposerFocused(true)}
              onBlur={() => window.desktopPet.setSpeechComposerFocused(false)}
              placeholder={speech.phase === "recording" ? "正在听你说…" : isGenerating ? "正在回答…" : "快速聊一句…"}
              disabled={speechBusy}
              aria-label="快捷对话"
            />
            <ImageAttachButton
              images={images}
              compact
              disabled={!visionEnabled || isGenerating || speechBusy}
              onChange={onImagesChange}
              onError={setAttachmentError}
            />
            <VoiceButton
              speech={speech}
              compact
              onPrepare={onPrepareSpeech}
              onStart={onStartSpeech}
              onStop={onStopSpeech}
              onCancel={onCancelSpeech}
            />
            <button
              type={isGenerating ? "button" : "submit"}
              onClick={isGenerating ? stop : undefined}
              disabled={speechBusy || (!isGenerating && !draft.trim() && !images.length)}
              aria-label={isGenerating ? "停止生成" : "发送"}
            >
              {isGenerating ? "■" : "↑"}
            </button>
          </form>
        </>
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
