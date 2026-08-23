import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ChatContextUsage,
  ChatConversation,
  ChatDocument,
  ChatEvent,
  ChatImage,
  ChatMessage,
  RuntimeState,
  SpeechState,
  TtsState,
  ThinkingEffort,
} from "../../shared/types";
import { clearLegacyChatHistory, readChatHistory, writeChatHistory } from "../chat-history";
import { copyTextViaDocument, copyTextWithFallback } from "../clipboard";
import { thinkingBudgetLimitForDisplay } from "../../shared/thinking-effort";
import { Pet, type PetMood } from "./Pet";
import { resolveSpeechPetClipMood } from "./pet-clips";
import { RuntimeBadge } from "./RuntimeBadge";
import { VoiceButton } from "./VoiceButton";
import { ImageAttachButton, ImageAttachmentTray } from "./ImageAttachments";
import { DocumentAttachButton, DocumentAttachmentTray } from "./DocumentAttachments";
import { PixelIcon } from "./PixelIcon";
import { ConfirmDialog } from "./ConfirmDialog";
import { MarkdownMessage } from "./MarkdownMessage";
import { ToolCallCard } from "./ToolCallCard";
import {
  conversationOperationUiPolicy,
  continuationRequestMessages,
  isNearChatBottom,
  regenerationBaseMessages,
  type ConversationOperationKind,
  isCurrentConversationOperation,
  shouldResetComposer,
  shouldResetComposerAfterInitialization,
} from "./chat-panel-state";

interface ChatPanelProps {
  runtime: RuntimeState;
  speech: SpeechState;
  tts: TtsState;
  chatTemplates: string[];
  maxTokens: number;
  contextSize: number;
  draft: string;
  images: ChatImage[];
  documents: ChatDocument[];
  onDraftChange: (value: string) => void;
  onImagesChange: (images: ChatImage[]) => void;
  onDocumentsChange: (documents: ChatDocument[]) => void;
  visionEnabled: boolean;
  onPrepareSpeech: () => Promise<void>;
  onStartSpeech: () => Promise<string | undefined>;
  onStopSpeech: (sessionId: string) => Promise<void>;
  onSpeakText: (text: string) => Promise<void>;
  onStopSpeaking: () => Promise<void>;
  onClose: () => void;
  onSettings: () => void;
  onStartRuntime: () => Promise<void>;
}

interface ThinkingToggleProps {
  onChange: (thinking: boolean, effort: ThinkingEffort) => void;
  maxTokens: number;
}

interface ContextUsageIndicatorProps {
  usage?: ChatContextUsage;
  contextSize: number;
}

type PersistenceMode = "loading" | "database" | "legacy";

interface ChatInitialization {
  mode: Exclude<PersistenceMode, "loading">;
  conversations: ChatConversation[];
  conversationId: string | null;
  messages: ChatMessage[];
}

interface ConversationOperation {
  token: number;
  composerRevision: number;
}

interface GenerationOptions {
  targetAssistantId?: string;
  requestMessages?: ChatMessage[];
}

function formatConversationTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function latestContextUsage(messages: ChatMessage[]): ChatContextUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].contextUsage) return messages[index].contextUsage;
  }
  return undefined;
}

const THINKING_EFFORTS: Array<{ value: ThinkingEffort; label: string }> = [
  { value: "minimal", label: "极简" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
  { value: "max", label: "最大" },
];

const ThinkingToggle = memo(function ThinkingToggle({ onChange, maxTokens }: ThinkingToggleProps) {
  const [thinking, setThinking] = useState(false);
  const [effort, setEffort] = useState<ThinkingEffort>("medium");
  const effortMenuRef = useRef<HTMLDetailsElement>(null);

  const toggle = () => {
    const nextThinking = !thinking;
    setThinking(nextThinking);
    if (!nextThinking && effortMenuRef.current) effortMenuRef.current.open = false;
    onChange(nextThinking, effort);
  };

  const selectedLabel = THINKING_EFFORTS.find((option) => option.value === effort)?.label;
  const selectedBudget = thinkingBudgetLimitForDisplay(effort, maxTokens);
  const selectedBudgetDescription = effort === "max"
    ? `不单独限制思考预算，总输出最多 ${selectedBudget} token`
    : `思考预算最多 ${selectedBudget} token`;

  return (
    <div className="thinking-controls">
      <button
        type="button"
        className="thinking-toggle"
        onClick={toggle}
        aria-pressed={thinking}
        aria-label={thinking ? "当前为深度思考，点击切换到快速回答" : "当前为快速回答，点击切换到深度思考"}
      >
        <span className={`thinking-toggle__option thinking-toggle__option--quick ${!thinking ? "active" : ""}`}>
          <PixelIcon name="bolt" />
          快速回答
        </span>
        <span className={`thinking-toggle__option thinking-toggle__option--deep ${thinking ? "active" : ""}`}>
          <PixelIcon name="sparkle" />
          深度思考
        </span>
      </button>
      <details
        ref={effortMenuRef}
        className={`thinking-effort${thinking ? " thinking-effort--active" : ""}`}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
        }}
      >
        <summary
          aria-label={`推理强度：${selectedLabel}，${selectedBudgetDescription}`}
          aria-disabled={!thinking}
          title={thinking ? "选择推理强度" : "切换到深度思考后可调整"}
          onClick={(event) => {
            if (!thinking) event.preventDefault();
          }}
        >
          <span className="thinking-effort__value">{selectedLabel}</span>
          <PixelIcon name="chevron-down" className="thinking-effort__chevron" />
        </summary>
        <div className="thinking-effort__menu" role="listbox" aria-label="推理强度选项">
          {THINKING_EFFORTS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === effort}
              onClick={() => {
                setEffort(option.value);
                onChange(thinking, option.value);
                if (effortMenuRef.current) effortMenuRef.current.open = false;
              }}
            >
              <span>{option.label}</span>
              <small>
                {option.value === "max" ? "总输出" : "预算"} ≤{
                  ` ${thinkingBudgetLimitForDisplay(option.value, maxTokens).toLocaleString("en-US")}`
                }
              </small>
            </button>
          ))}
        </div>
      </details>
    </div>
  );
});

const ContextUsageIndicator = memo(function ContextUsageIndicator({
  usage,
  contextSize,
}: ContextUsageIndicatorProps) {
  const usedTokens = usage?.totalTokens ?? 0;
  const usedPercentage = contextSize > 0 ? Math.min(100, usedTokens / contextSize * 100) : 0;
  const remainingTokens = Math.max(0, contextSize - usedTokens);
  const remainingPercentage = contextSize > 0 ? remainingTokens / contextSize * 100 : 0;
  const level = usedPercentage >= 90 ? "critical" : usedPercentage >= 70 ? "high" : "normal";
  const label = usage
    ? `剩余上下文 ${remainingTokens.toLocaleString("en-US")} / ${contextSize.toLocaleString("en-US")} token，${Math.round(remainingPercentage)}% 可用`
    : `上下文上限 ${contextSize.toLocaleString("en-US")} token，完成一次回答后显示用量`;

  return (
    <div className={`context-usage context-usage--${level}`} tabIndex={0} aria-label={label}>
      <svg className="context-usage__circle" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="context-usage__track" cx="12" cy="12" r="8.5" />
        <circle
          className="context-usage__value"
          cx="12"
          cy="12"
          r="8.5"
          pathLength="100"
          strokeDasharray={`${usedPercentage} 100`}
        />
        <circle className="context-usage__center" cx="12" cy="12" r="2" />
      </svg>
      <div className="context-usage__tooltip" role="tooltip">
        <div className="context-usage__heading">
          <b>剩余上下文</b>
          <span>{usage ? `${Math.round(remainingPercentage)}% 可用` : "待统计"}</span>
        </div>
        {usage ? (
          <>
            <div className="context-usage__meter" aria-hidden="true">
              <i style={{ width: `${remainingPercentage}%` }} />
            </div>
            <strong>
              {remainingTokens.toLocaleString("en-US")} token 可用
            </strong>
            <small>
              已使用 {usedTokens.toLocaleString("en-US")} / {contextSize.toLocaleString("en-US")} · 当前输入 {usage.promptTokens.toLocaleString("en-US")} · 输出 {usage.completionTokens.toLocaleString("en-US")}
            </small>
          </>
        ) : (
          <small>完成一次回答后显示真实 token 用量</small>
        )}
      </div>
    </div>
  );
});

export function ChatPanel({
  runtime,
  speech,
  tts,
  chatTemplates,
  maxTokens,
  contextSize,
  draft,
  images,
  documents,
  onDraftChange,
  onImagesChange,
  onDocumentsChange,
  visionEnabled,
  onPrepareSpeech,
  onStartSpeech,
  onStopSpeech,
  onSpeakText,
  onStopSpeaking,
  onClose,
  onSettings,
  onStartRuntime,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [persistenceMode, setPersistenceMode] = useState<PersistenceMode>("loading");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversationOperationPending, setConversationOperationPending] = useState(false);
  const [historyOperationError, setHistoryOperationError] = useState("");
  const [deleteTargets, setDeleteTargets] = useState<ChatConversation[]>([]);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteDialogError, setDeleteDialogError] = useState("");
  const [historyBatchMode, setHistoryBatchMode] = useState(false);
  const [selectedConversationIds, setSelectedConversationIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [activeRequest, setActiveRequest] = useState<string | null>(null);
  const [copyPopupVisible, setCopyPopupVisible] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const assistantByRequest = useRef(new Map<string, string>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef(false);
  const thinkingEffortRef = useRef<ThinkingEffort>("medium");
  const autoScrollRef = useRef(true);
  const mountedRef = useRef(true);
  const messagesRef = useRef<ChatMessage[]>([]);
  const conversationIdRef = useRef<string | null>(null);
  const persistenceModeRef = useRef<PersistenceMode>("loading");
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyPopupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const initializationRef = useRef<Promise<ChatInitialization> | null>(null);
  const conversationOperationTokenRef = useRef(0);
  const conversationOperationPendingRef = useRef(false);
  const composerRevisionRef = useRef(0);
  const observedDraftRef = useRef(draft);
  const observedImagesRef = useRef(images);
  const observedDocumentsRef = useRef(documents);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyNewButtonRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusAfterHistoryCloseRef = useRef(false);
  const onDraftChangeRef = useRef(onDraftChange);
  const onImagesChangeRef = useRef(onImagesChange);
  const onDocumentsChangeRef = useRef(onDocumentsChange);
  onDraftChangeRef.current = onDraftChange;
  onImagesChangeRef.current = onImagesChange;
  onDocumentsChangeRef.current = onDocumentsChange;
  if (observedDraftRef.current !== draft) {
    observedDraftRef.current = draft;
    composerRevisionRef.current += 1;
  }
  if (observedImagesRef.current !== images) {
    observedImagesRef.current = images;
    composerRevisionRef.current += 1;
  }
  if (observedDocumentsRef.current !== documents) {
    observedDocumentsRef.current = documents;
    composerRevisionRef.current += 1;
  }

  const handleThinkingChange = useCallback((thinking: boolean, effort: ThinkingEffort) => {
    thinkingRef.current = thinking;
    thinkingEffortRef.current = effort;
  }, []);

  const changeDraft = useCallback((value: string) => {
    if (observedDraftRef.current !== value) {
      observedDraftRef.current = value;
      composerRevisionRef.current += 1;
    }
    onDraftChangeRef.current(value);
  }, []);

  const changeImages = useCallback((nextImages: ChatImage[]) => {
    if (observedImagesRef.current !== nextImages) {
      observedImagesRef.current = nextImages;
      composerRevisionRef.current += 1;
    }
    onImagesChangeRef.current(nextImages);
  }, []);

  const changeDocuments = useCallback((nextDocuments: ChatDocument[]) => {
    if (observedDocumentsRef.current !== nextDocuments) {
      observedDocumentsRef.current = nextDocuments;
      composerRevisionRef.current += 1;
    }
    onDocumentsChangeRef.current(nextDocuments);
  }, []);

  const persistMessages = useCallback((
    refreshConversations = false,
    requireSuccess = false,
  ): Promise<void> => {
    if (!dirtyRef.current) return saveChainRef.current;
    const mode = persistenceModeRef.current;
    const currentConversationId = conversationIdRef.current;
    const snapshot = messagesRef.current;

    if (mode === "legacy") {
      writeChatHistory(snapshot);
      if (messagesRef.current === snapshot) dirtyRef.current = false;
      return Promise.resolve();
    }
    if (mode !== "database" || !currentConversationId) return Promise.resolve();

    const saveOperation = saveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        await window.desktopPet.saveChatMessages(currentConversationId, snapshot);
        if (messagesRef.current === snapshot) dirtyRef.current = false;
        if (refreshConversations) {
          const nextConversations = await window.desktopPet.listChatConversations();
          if (mountedRef.current) setConversations(nextConversations);
        }
      });
    saveChainRef.current = saveOperation.catch((error) => {
        dirtyRef.current = true;
        if (mountedRef.current) {
          setAttachmentError(
            `聊天记录保存失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    return requireSuccess ? saveOperation : saveChainRef.current;
  }, []);

  const scheduleSave = useCallback((immediate = false, refreshConversations = false) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (immediate) {
      void persistMessages(refreshConversations);
      return;
    }
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persistMessages(refreshConversations);
    }, 1_000);
  }, [persistMessages]);

  const updateMessages = useCallback((
    update: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[]),
    immediate = false,
    refreshConversations = false,
  ): ChatMessage[] => {
    const next = typeof update === "function" ? update(messagesRef.current) : update;
    messagesRef.current = next;
    dirtyRef.current = true;
    setMessages(next);
    scheduleSave(immediate, refreshConversations);
    return next;
  }, [scheduleSave]);

  const loadIntoState = useCallback((
    id: string | null,
    nextMessages: ChatMessage[],
    resetComposer = true,
  ) => {
    conversationIdRef.current = id;
    messagesRef.current = nextMessages;
    dirtyRef.current = false;
    setConversationId(id);
    setMessages(nextMessages);
    autoScrollRef.current = true;
    setShowScrollToLatest(false);
    setAttachmentError("");
    if (resetComposer) {
      changeDraft("");
      changeImages([]);
      changeDocuments([]);
    }
  }, [changeDocuments, changeDraft, changeImages]);

  useEffect(() => {
    let cancelled = false;
    const initializationComposerRevision = composerRevisionRef.current;
    const initializationComposerWasEmpty =
      observedDraftRef.current.length === 0 &&
      observedImagesRef.current.length === 0 &&
      observedDocumentsRef.current.length === 0;
    initializationRef.current ??= (async () => {
      try {
        let nextConversations = await window.desktopPet.listChatConversations();
        let current = nextConversations[0];
        if (!current) {
          current = await window.desktopPet.createChatConversation();
          nextConversations = [current];
        }
        return {
          mode: "database",
          conversations: nextConversations,
          conversationId: current.id,
          messages: await window.desktopPet.loadChatConversation(current.id),
        } satisfies ChatInitialization;
      } catch {
        return {
          mode: "legacy",
          conversations: [],
          conversationId: null,
          messages: readChatHistory(),
        } satisfies ChatInitialization;
      }
    })();
    void initializationRef.current.then((result) => {
      if (cancelled) return;
      persistenceModeRef.current = result.mode;
      setPersistenceMode(result.mode);
      setConversations(result.conversations);
      loadIntoState(
        result.conversationId,
        result.messages,
        shouldResetComposerAfterInitialization(
          initializationComposerWasEmpty,
          initializationComposerRevision,
          composerRevisionRef.current,
        ),
      );
      if (result.mode === "database") {
        clearLegacyChatHistory();
      } else {
        setAttachmentError("本地聊天数据库暂不可用，当前使用浏览器存储兜底。");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadIntoState]);

  useLayoutEffect(() => {
    if (scrollRef.current && autoScrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleChatScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const nearBottom = isNearChatBottom(
      element.scrollHeight,
      element.scrollTop,
      element.clientHeight,
    );
    autoScrollRef.current = nearBottom;
    setShowScrollToLatest(!nearBottom);
  }, []);

  const scrollToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    autoScrollRef.current = true;
    setShowScrollToLatest(false);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, []);

  useLayoutEffect(() => {
    if (historyOpen || !focusAfterHistoryCloseRef.current) return;
    focusAfterHistoryCloseRef.current = false;
    textareaRef.current?.focus({ preventScroll: true });
  }, [conversationId, historyOpen]);

  useEffect(
    () =>
      window.desktopPet.onChatEvent((event: ChatEvent) => {
        const assistantId = assistantByRequest.current.get(event.requestId);
        if (!assistantId) return;
        if (event.type === "warning") setAttachmentError(event.message);
        if (event.type === "delta" || event.type === "reasoning") {
          updateMessages((current) =>
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
        if (event.type === "tool-call") {
          updateMessages((current) =>
            current.map((message) => {
              if (message.id !== assistantId) return message;
              const calls = [...(message.toolCalls ?? [])];
              const index = calls.findIndex((call) => call.id === event.call.id);
              if (index >= 0) calls[index] = event.call;
              else calls.push(event.call);
              return { ...message, toolCalls: calls };
            }),
          );
        }
        if (event.type === "tool-result") {
          updateMessages((current) =>
            current.map((message) => message.id === assistantId
              ? {
                  ...message,
                  toolCalls: (message.toolCalls ?? []).map((call) => call.id === event.toolCallId
                    ? {
                        ...call,
                        status: event.status,
                        ...(event.result ? { result: event.result } : {}),
                        ...(event.error ? { error: event.error } : {}),
                      }
                    : call),
                }
              : message),
          );
        }
        if (event.type === "done" || event.type === "error") {
          if (event.type === "error") {
            const existingMessage = messagesRef.current.find((message) => message.id === assistantId);
            if (existingMessage?.content) setAttachmentError(event.message);
            updateMessages(
              (current) =>
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
              true,
              true,
            );
          } else {
            if (event.contextUsage) {
              updateMessages(
                (current) => current.map((message) => message.id === assistantId
                  ? { ...message, contextUsage: event.contextUsage }
                  : message),
                true,
                true,
              );
            } else {
              scheduleSave(true, true);
            }
          }
          assistantByRequest.current.delete(event.requestId);
          setActiveRequest((current) => current === event.requestId ? null : current);
        }
      }),
    [scheduleSave, updateMessages],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      conversationOperationTokenRef.current += 1;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (copyPopupTimerRef.current) clearTimeout(copyPopupTimerRef.current);
      void persistMessages();
    };
  }, [persistMessages]);

  const mood: PetMood = useMemo(() => {
    if (speech.phase === "recording") return "listening";
    if (speech.phase === "transcribing") return "transcribing";
    if (runtime.phase === "error") return "sad";
    if (
      runtime.phase === "starting" ||
      runtime.phase === "downloading"
    )
      return "thinking";
    if (activeRequest) {
      return messages.at(-1)?.content.trim() ? "talking" : "thinking";
    }
    if (tts.phase === "speaking") return "talking";
    return "idle";
  }, [activeRequest, messages, runtime.phase, speech.phase, tts.phase]);

  const operationIsCurrent = (operation: ConversationOperation): boolean =>
    mountedRef.current && isCurrentConversationOperation(
      operation.token,
      conversationOperationTokenRef.current,
    );

  const closeHistoryAndFocusComposer = (): void => {
    focusAfterHistoryCloseRef.current = true;
    setHistoryBatchMode(false);
    setSelectedConversationIds(new Set());
    setHistoryOpen(false);
  };

  const commitConversationOperationUi = (kind: ConversationOperationKind): void => {
    const uiPolicy = conversationOperationUiPolicy(kind, "commit");
    if (uiPolicy.closeHistory && uiPolicy.focusComposer) {
      closeHistoryAndFocusComposer();
    }
  };

  const beginConversationOperation = (
    kind: ConversationOperationKind,
  ): ConversationOperation | null => {
    if (conversationOperationPendingRef.current) return null;
    conversationOperationPendingRef.current = true;
    const operation = {
      token: ++conversationOperationTokenRef.current,
      composerRevision: composerRevisionRef.current,
    };
    setConversationOperationPending(true);
    if (kind !== "delete") setHistoryOperationError("");
    const uiPolicy = conversationOperationUiPolicy(kind, "start");
    if (uiPolicy.closeHistory && uiPolicy.focusComposer) {
      closeHistoryAndFocusComposer();
    }
    return operation;
  };

  const finishConversationOperation = (operation: ConversationOperation): void => {
    if (!operationIsCurrent(operation)) return;
    conversationOperationPendingRef.current = false;
    setConversationOperationPending(false);
  };

  const createConversation = async (source: "history" | "composer") => {
    if (activeRequest || persistenceMode !== "database") return;
    const operation = beginConversationOperation("create");
    if (!operation) return;
    try {
      await persistMessages(false, true);
      if (!operationIsCurrent(operation)) return;
      const created = await window.desktopPet.createChatConversation();
      if (!operationIsCurrent(operation)) return;
      const nextConversations = await window.desktopPet.listChatConversations();
      if (!operationIsCurrent(operation)) return;
      setConversations(nextConversations);
      loadIntoState(
        created.id,
        [],
        shouldResetComposer(operation.composerRevision, composerRevisionRef.current),
      );
      commitConversationOperationUi("create");
    } catch (error) {
      if (operationIsCurrent(operation)) {
        const message = `新建对话失败：${error instanceof Error ? error.message : String(error)}`;
        if (source === "history") setHistoryOperationError(message);
        else setAttachmentError(message);
      }
    } finally {
      finishConversationOperation(operation);
    }
  };

  const switchConversation = async (nextConversationId: string) => {
    if (
      activeRequest ||
      persistenceMode !== "database" ||
      conversationOperationPendingRef.current
    ) return;
    if (nextConversationId === conversationIdRef.current) {
      closeHistoryAndFocusComposer();
      return;
    }
    const operation = beginConversationOperation("switch");
    if (!operation) return;
    try {
      await persistMessages(false, true);
      if (!operationIsCurrent(operation)) return;
      const savedMessages = await window.desktopPet.loadChatConversation(nextConversationId);
      if (!operationIsCurrent(operation)) return;
      loadIntoState(
        nextConversationId,
        savedMessages,
        shouldResetComposer(operation.composerRevision, composerRevisionRef.current),
      );
      commitConversationOperationUi("switch");
    } catch (error) {
      if (operationIsCurrent(operation)) {
        setHistoryOperationError(
          `切换对话失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      finishConversationOperation(operation);
    }
  };

  const requestDeleteConversation = (
    target: ChatConversation,
    trigger: HTMLButtonElement,
  ): void => {
    if (
      activeRequest ||
      persistenceMode !== "database" ||
      conversationOperationPendingRef.current
    ) return;
    deleteTriggerRef.current = trigger;
    setHistoryOperationError("");
    setDeleteDialogError("");
    setDeleteTargets([target]);
  };

  const toggleConversationSelection = (targetId: string): void => {
    setSelectedConversationIds((current) => {
      const next = new Set(current);
      if (next.has(targetId)) next.delete(targetId);
      else next.add(targetId);
      return next;
    });
  };

  const requestDeleteSelectedConversations = (): void => {
    const targets = conversations.filter((conversation) => selectedConversationIds.has(conversation.id));
    if (!targets.length || activeRequest || conversationOperationPendingRef.current) return;
    setHistoryOperationError("");
    setDeleteDialogError("");
    setDeleteTargets(targets);
  };

  const closeDeleteDialog = (): void => {
    if (deletePending) return;
    const trigger = deleteTriggerRef.current;
    setDeleteDialogError("");
    setDeleteTargets([]);
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      else historyNewButtonRef.current?.focus({ preventScroll: true });
    });
  };

  const confirmDeleteConversation = async (): Promise<void> => {
    const targets = deleteTargets;
    if (!targets.length) return;
    const targetIds = new Set(targets.map((target) => target.id));
    const operation = beginConversationOperation("delete");
    if (!operation) return;
    setDeletePending(true);
    setDeleteDialogError("");
    let succeeded = false;
    try {
      await persistMessages(false, true);
      if (!operationIsCurrent(operation)) return;
      await window.desktopPet.deleteChatConversations([...targetIds]);
      if (!operationIsCurrent(operation)) return;
      let nextConversations = await window.desktopPet.listChatConversations();
      if (!operationIsCurrent(operation)) return;
      let nextConversationId = conversationIdRef.current;
      let nextMessages: ChatMessage[] | null = null;
      if (conversationIdRef.current && targetIds.has(conversationIdRef.current)) {
        let next = nextConversations[0];
        if (!next) {
          next = await window.desktopPet.createChatConversation();
          if (!operationIsCurrent(operation)) return;
          nextConversations = [next];
        }
        nextConversationId = next.id;
        nextMessages = await window.desktopPet.loadChatConversation(next.id);
        if (!operationIsCurrent(operation)) return;
      }
      if (nextMessages && nextConversationId) {
        loadIntoState(
          nextConversationId,
          nextMessages,
          shouldResetComposer(operation.composerRevision, composerRevisionRef.current),
        );
      }
      setConversations(nextConversations);
      succeeded = true;
    } catch (error) {
      if (operationIsCurrent(operation)) {
        setDeleteDialogError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      finishConversationOperation(operation);
      if (operationIsCurrent(operation)) {
        setDeletePending(false);
        if (succeeded) {
          setDeleteTargets([]);
          setDeleteDialogError("");
          setSelectedConversationIds(new Set());
          setHistoryBatchMode(false);
          deleteTriggerRef.current = null;
          requestAnimationFrame(() => {
            historyNewButtonRef.current?.focus({ preventScroll: true });
          });
        }
      }
    }
  };

  const startGeneration = (nextMessages: ChatMessage[], options: GenerationOptions = {}) => {
    const requestId = crypto.randomUUID();
    const assistantId = options.targetAssistantId ?? crypto.randomUUID();
    assistantByRequest.current.set(requestId, assistantId);
    autoScrollRef.current = true;
    setShowScrollToLatest(false);
    if (!options.targetAssistantId) {
      const assistant: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        createdAt: Date.now(),
      };
      updateMessages([...nextMessages, assistant], true, true);
    }
    setActiveRequest(requestId);
    window.desktopPet.startChat({
      requestId,
      messages: options.requestMessages ?? nextMessages,
      thinking: thinkingRef.current,
      thinkingEffort: thinkingEffortRef.current,
    });
  };

  const copyMessage = async (message: ChatMessage): Promise<void> => {
    try {
      const desktopCopyText = typeof window.desktopPet.copyText === "function"
        ? window.desktopPet.copyText.bind(window.desktopPet)
        : undefined;
      const browserCopyText = typeof navigator.clipboard?.writeText === "function"
        ? navigator.clipboard.writeText.bind(navigator.clipboard)
        : undefined;
      await copyTextWithFallback(message.content, {
        desktopCopyText,
        browserCopyText,
        legacyCopyText: (text) => copyTextViaDocument(text, document),
      });
      setAttachmentError("");
      setCopyPopupVisible(true);
      if (copyPopupTimerRef.current) clearTimeout(copyPopupTimerRef.current);
      copyPopupTimerRef.current = setTimeout(() => {
        copyPopupTimerRef.current = null;
        setCopyPopupVisible(false);
      }, 1_600);
    } catch (error) {
      setAttachmentError(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const continueGeneration = (message: ChatMessage): void => {
    if (
      message.id !== messagesRef.current.at(-1)?.id ||
      message.role !== "assistant" ||
      !message.content.trim() ||
      activeRequest ||
      conversationOperationPendingRef.current ||
      runtime.phase !== "ready" ||
      persistenceMode === "loading"
    ) return;
    if (tts.phase === "speaking") void onStopSpeaking();
    setAttachmentError("");
    const requestMessages = continuationRequestMessages(
      messagesRef.current,
      crypto.randomUUID(),
      Date.now(),
    );
    if (!requestMessages) return;
    startGeneration(messagesRef.current, {
      targetAssistantId: message.id,
      requestMessages,
    });
  };

  const send = () => {
    const text = draft.trim();
    if (
      (!text && !images.length && !documents.length) ||
      activeRequest ||
      conversationOperationPendingRef.current ||
      runtime.phase !== "ready" ||
      persistenceMode === "loading"
    ) return;
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      images: images.length ? images : undefined,
      documents: documents.length ? documents : undefined,
      createdAt: Date.now(),
    };
    startGeneration([...messagesRef.current, user]);
    changeDraft("");
    changeImages([]);
    changeDocuments([]);
    setAttachmentError("");
  };

  const regenerate = () => {
    if (
      activeRequest ||
      conversationOperationPendingRef.current ||
      runtime.phase !== "ready" ||
      persistenceMode === "loading"
    ) return;
    const baseMessages = regenerationBaseMessages(messagesRef.current);
    if (!baseMessages) return;
    if (tts.phase === "speaking") void onStopSpeaking();
    setAttachmentError("");
    startGeneration(baseMessages);
  };

  const removeImage = (index: number) => {
    changeImages(images.filter((_image, imageIndex) => imageIndex !== index));
  };

  const removeDocument = (index: number) => {
    changeDocuments(documents.filter((_document, documentIndex) => documentIndex !== index));
  };

  const resolveToolApproval = useCallback((
    requestId: string,
    toolCallId: string,
    approved: boolean,
  ) => {
    window.desktopPet.resolveToolApproval(requestId, toolCallId, approved);
  }, []);

  const speechBusy = speech.phase === "recording" || speech.phase === "transcribing";
  const visibleChatTemplates = useMemo(
    () => chatTemplates.map((template) => template.trim()).filter(Boolean),
    [chatTemplates],
  );
  const contextUsage = useMemo(
    () => latestContextUsage(messages),
    [messages],
  );

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
            className={`icon-button history-toggle${conversationOperationPending ? " history-toggle--busy" : ""}`}
            type="button"
            onClick={() => {
              if (historyOpen) {
                closeHistoryAndFocusComposer();
              } else {
                setHistoryOperationError("");
                setHistoryOpen(true);
              }
            }}
            aria-label="聊天历史"
            aria-expanded={historyOpen}
            disabled={
              persistenceMode !== "database" ||
              Boolean(activeRequest) ||
              conversationOperationPending
            }
          >
            <PixelIcon name="history" />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={onSettings}
            aria-label="设置"
          >
            <PixelIcon name="settings" />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="收起"
          >
            <PixelIcon name="close" />
          </button>
        </div>
      </header>

      {historyOpen && (
        <section
          className={`history-drawer${conversationOperationPending ? " history-drawer--busy" : ""}${deleteTargets.length ? " history-drawer--dialog-open" : ""}`}
          aria-label="聊天历史"
          aria-busy={conversationOperationPending}
          inert={deleteTargets.length ? true : undefined}
        >
          <div className="history-drawer__header">
            <div className="history-drawer__title">
              <b>聊天历史</b>
              <small>本地保存最近 30 个会话</small>
            </div>
            <div className="history-drawer__actions">
              <button
                className="text-button"
                type="button"
                disabled={Boolean(activeRequest) || conversationOperationPending || conversations.length === 0}
                onClick={() => {
                  setHistoryBatchMode((current) => !current);
                  setSelectedConversationIds(new Set());
                }}
              >
                {historyBatchMode ? "完成" : "管理"}
              </button>
              <button
                ref={historyNewButtonRef}
                className="text-button text-button--with-icon"
                type="button"
                disabled={Boolean(activeRequest) || conversationOperationPending}
                onClick={() => void createConversation("history")}
              >
                <PixelIcon name="plus" />
                新建
              </button>
            </div>
          </div>
          {historyOperationError && (
            <p className="history-drawer__error" role="alert">
              {historyOperationError}
            </p>
          )}
          {historyBatchMode && (
            <div className="history-batch-toolbar">
              <button
                className="text-button"
                type="button"
                onClick={() => setSelectedConversationIds(
                  selectedConversationIds.size === conversations.length
                    ? new Set()
                    : new Set(conversations.map((conversation) => conversation.id)),
                )}
              >
                {selectedConversationIds.size === conversations.length ? "取消全选" : "全选"}
              </button>
              <span>已选择 {selectedConversationIds.size} 个</span>
              <button
                className="button button--danger history-batch-toolbar__delete"
                type="button"
                disabled={selectedConversationIds.size === 0 || conversationOperationPending}
                onClick={requestDeleteSelectedConversations}
              >
                <PixelIcon name="trash" />
                删除
              </button>
            </div>
          )}
          <div className="history-drawer__list">
            {conversations.map((conversation) => (
              <div
                className={`history-item ${conversation.id === conversationId ? "history-item--active" : ""}${selectedConversationIds.has(conversation.id) ? " history-item--selected" : ""}`}
                key={conversation.id}
              >
                {historyBatchMode && (
                  <label className="history-item__checkbox" aria-label={`选择 ${conversation.title}`}>
                    <input
                      type="checkbox"
                      checked={selectedConversationIds.has(conversation.id)}
                      disabled={Boolean(activeRequest) || conversationOperationPending}
                      onChange={() => toggleConversationSelection(conversation.id)}
                    />
                  </label>
                )}
                <button
                  className="history-item__select"
                  type="button"
                  disabled={Boolean(activeRequest) || conversationOperationPending}
                  onClick={() => historyBatchMode
                    ? toggleConversationSelection(conversation.id)
                    : void switchConversation(conversation.id)}
                >
                  <b>{conversation.title}</b>
                  <small>
                    {formatConversationTime(conversation.updatedAt)} · {conversation.messageCount} 条消息
                  </small>
                </button>
                {!historyBatchMode && <button
                  className="history-item__delete"
                  type="button"
                  disabled={Boolean(activeRequest) || conversationOperationPending}
                  aria-label={`删除 ${conversation.title}`}
                  onClick={(event) => requestDeleteConversation(conversation, event.currentTarget)}
                >
                  <PixelIcon name="trash" />
                </button>}
              </div>
            ))}
          </div>
        </section>
      )}

      {deleteTargets.length > 0 && (
        <ConfirmDialog
          title={deleteTargets.length === 1 ? "删除这个对话？" : `删除 ${deleteTargets.length} 个对话？`}
          description={deleteTargets.length === 1
            ? `“${deleteTargets[0].title}”及其中 ${deleteTargets[0].messageCount} 条消息将被永久删除，无法恢复。`
            : `所选对话及其中 ${deleteTargets.reduce((total, target) => total + target.messageCount, 0)} 条消息将被永久删除，无法恢复。`}
          confirmLabel={deleteTargets.length === 1 ? "删除对话" : "批量删除"}
          pendingLabel="删除中…"
          pending={deletePending}
          error={deleteDialogError}
          onCancel={closeDeleteDialog}
          onConfirm={() => void confirmDeleteConversation()}
        />
      )}

      <section className="chat-log" ref={scrollRef} onScroll={handleChatScroll}>
        {messages.length === 0 ? (
          <div className="empty-chat">
            <Pet
              mood={mood}
              clipMood={resolveSpeechPetClipMood(speech.phase)}
              compact
            />
            <h2>今天想聊点什么？</h2>
            <p className="empty-chat__voice-status" aria-live="polite">
              {speech.phase === "recording"
                ? "团子在认真听…"
                : speech.phase === "transcribing"
                  ? "团子正在转成文字…"
                  : "\u00a0"}
            </p>
            <div className="chat-template-grid" aria-label="快捷模板">
              {visibleChatTemplates.map((template, index) => (
                <button
                  key={`${index}-${template}`}
                  type="button"
                  onClick={() => {
                    changeDraft(template);
                  }}
                >
                  {template}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message, messageIndex) => (
            <article
              key={message.id}
              className={`message message--${message.role}`}
            >
              {message.role === "assistant" && (
                <span className="message-avatar">团</span>
              )}
              <div className="message-content">
                <ImageAttachmentTray images={message.images ?? []} />
                <DocumentAttachmentTray documents={message.documents ?? []} />
                {message.reasoning && (
                  <details className="reasoning">
                    <summary>团子的思考</summary>
                    <MarkdownMessage content={message.reasoning} className="reasoning__content" />
                  </details>
                )}
                {message.toolCalls?.map((call) => (
                  <ToolCallCard
                    key={call.id}
                    call={call}
                    requestId={
                      activeRequest && assistantByRequest.current.get(activeRequest) === message.id
                        ? activeRequest
                        : undefined
                    }
                    onApproval={resolveToolApproval}
                  />
                ))}
                {message.role === "assistant" ? (
                  message.content ? (
                    <MarkdownMessage content={message.content} />
                  ) : message.toolCalls?.length ? null : (
                    <p className="typing-dots">
                      <i />
                      <i />
                      <i />
                    </p>
                  )
                ) : message.content ? (
                  <p className="message-plain-text">{message.content}</p>
                ) : null}
                {message.role === "assistant" && (message.content.trim() || (
                  messageIndex === messages.length - 1 && !activeRequest
                )) && (
                  <div className="message-actions">
                    {message.content.trim() && (
                      <button
                        className="message-action message-action--copy"
                        type="button"
                        aria-label="复制这段回答"
                        title="复制"
                        onClick={() => void copyMessage(message)}
                      >
                        <PixelIcon name="copy" />
                      </button>
                    )}
                    {message.content.trim() && (
                      <button
                        className={`message-action${tts.phase === "speaking" ? " message-action--active" : ""}`}
                        type="button"
                        disabled={!tts.enabled}
                        aria-label={tts.phase === "speaking" ? "停止朗读" : "朗读这段回答"}
                        title={
                          !tts.enabled
                            ? "请先在设置中启用语音朗读"
                            : tts.phase === "speaking"
                              ? "停止朗读"
                              : "朗读这段回答"
                        }
                        onClick={() => void (tts.phase === "speaking" ? onStopSpeaking() : onSpeakText(message.content))}
                      >
                        <PixelIcon name={tts.phase === "speaking" ? "stop" : "volume"} />
                      </button>
                    )}
                    {messageIndex === messages.length - 1 && !activeRequest && (
                      <>
                        {message.content.trim() && (
                          <button
                            className="message-action message-action--continue"
                            type="button"
                            disabled={runtime.phase !== "ready" || conversationOperationPending}
                            aria-label="继续生成这段回答"
                            title="继续生成"
                            onClick={() => continueGeneration(message)}
                          >
                            <PixelIcon name="continue" />
                          </button>
                        )}
                        <button
                          className="message-action message-action--regenerate"
                          type="button"
                          disabled={runtime.phase !== "ready" || conversationOperationPending}
                          aria-label="重新生成回答"
                          title="重新生成回答"
                          onClick={regenerate}
                        >
                          <PixelIcon name="refresh" />
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </article>
          ))
        )}
      </section>

      {showScrollToLatest ? (
        <button className="scroll-to-latest" type="button" onClick={scrollToLatest}>
          回到最新
        </button>
      ) : null}

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

      {messages.length > 0 && (speech.phase === "recording" || speech.phase === "transcribing") && (
        <section className={`voice-pet-indicator phase-${speech.phase}`} aria-live="polite">
          <Pet
            mood={speech.phase === "recording" ? "listening" : "transcribing"}
            clipMood={resolveSpeechPetClipMood(speech.phase)}
            compact
          />
          <div>
            <b>{speech.phase === "recording" ? "团子在认真听" : "团子正在转成文字"}</b>
            <span>{speech.message}</span>
          </div>
        </section>
      )}

      {copyPopupVisible && (
        <div className="copy-popup" role="status" aria-live="polite">
          <PixelIcon name="copy" />
          <span>已复制到剪贴板</span>
        </div>
      )}
      <footer className="composer">
        <div className="composer__toolbar">
          <div className="composer__tools">
            <ThinkingToggle onChange={handleThinkingChange} maxTokens={maxTokens} />
            <ImageAttachButton
              images={images}
              disabled={
                !visionEnabled ||
                runtime.phase !== "ready" ||
                Boolean(activeRequest) ||
                conversationOperationPending ||
                speechBusy
              }
              onChange={changeImages}
              onError={setAttachmentError}
            />
            <DocumentAttachButton
              documents={documents}
              disabled={
                runtime.phase !== "ready" ||
                Boolean(activeRequest) ||
                conversationOperationPending ||
                speechBusy
              }
              onChange={changeDocuments}
              onError={setAttachmentError}
            />
          </div>
          <div className="composer__status">
            <ContextUsageIndicator usage={contextUsage} contextSize={contextSize} />
            {persistenceMode !== "loading" && !activeRequest && (
              <button
                className="text-button"
                type="button"
                disabled={conversationOperationPending}
                onClick={() => {
                  if (persistenceMode === "database") {
                    void createConversation("composer");
                  } else {
                    updateMessages([], true);
                  }
                }}
              >
                新建对话
              </button>
            )}
          </div>
        </div>
        <ImageAttachmentTray images={images} onRemove={removeImage} />
        <DocumentAttachmentTray documents={documents} onRemove={removeDocument} />
        {attachmentError && <p className="composer__error">{attachmentError}</p>}
        <div className="composer__input">
          <textarea
            ref={textareaRef}
            rows={3}
            value={draft}
            onChange={(event) => changeDraft(event.target.value)}
            onFocus={() => {
              window.desktopPet.setSpeechComposerFocused(true);
            }}
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
            disabled={speechBusy}
          />
          <VoiceButton
            speech={speech}
            compact
            onPrepare={onPrepareSpeech}
            onStart={onStartSpeech}
            onStop={onStopSpeech}
          />
          {activeRequest ? (
            <button
              className="send-button stop-button"
              type="button"
              onClick={() => window.desktopPet.abortChat(activeRequest)}
              aria-label="停止生成"
            >
              <PixelIcon name="stop" />
            </button>
          ) : (
            <button
              className="send-button"
              type="button"
              onClick={send}
              disabled={
                (!draft.trim() && !images.length && !documents.length) ||
                runtime.phase !== "ready" ||
                conversationOperationPending ||
                speechBusy
              }
              aria-label="发送"
            >
              <PixelIcon name="arrow-up" />
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
