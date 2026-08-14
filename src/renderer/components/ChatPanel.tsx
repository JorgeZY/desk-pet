import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ChatConversation,
  ChatEvent,
  ChatImage,
  ChatMessage,
  RuntimeState,
  SpeechState,
  TtsState,
} from "../../shared/types";
import { clearLegacyChatHistory, readChatHistory, writeChatHistory } from "../chat-history";
import { Pet, type PetMood } from "./Pet";
import { RuntimeBadge } from "./RuntimeBadge";
import { VoiceButton } from "./VoiceButton";
import { ImageAttachButton, ImageAttachmentTray } from "./ImageAttachments";
import { PixelIcon } from "./PixelIcon";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  conversationOperationUiPolicy,
  type ConversationOperationKind,
  isCurrentConversationOperation,
  shouldResetComposer,
  shouldResetComposerAfterInitialization,
} from "./chat-panel-state";

interface ChatPanelProps {
  runtime: RuntimeState;
  speech: SpeechState;
  tts: TtsState;
  draft: string;
  images: ChatImage[];
  onDraftChange: (value: string) => void;
  onImagesChange: (images: ChatImage[]) => void;
  visionEnabled: boolean;
  onPrepareSpeech: () => Promise<void>;
  onStartSpeech: () => Promise<string | undefined>;
  onStopSpeech: (sessionId: string) => Promise<void>;
  onCancelSpeech: (sessionId: string) => Promise<void>;
  onSpeakText: (text: string) => Promise<void>;
  onClose: () => void;
  onSettings: () => void;
  onStartRuntime: () => Promise<void>;
}

interface ThinkingToggleProps {
  onChange: (thinking: boolean) => void;
}

const DEFAULT_SUGGESTIONS = [
  "给今天的我来一句橘猫式鼓励",
  "用橘猫口吻吐槽一下加班",
  "编一个橘猫偷吃却拒不承认的故事",
];

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

function formatConversationTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

const ThinkingToggle = memo(function ThinkingToggle({ onChange }: ThinkingToggleProps) {
  const [thinking, setThinking] = useState(false);

  const toggle = () => {
    const nextThinking = !thinking;
    setThinking(nextThinking);
    onChange(nextThinking);
  };

  return (
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
  );
});

export function ChatPanel({
  runtime,
  speech,
  tts,
  draft,
  images,
  onDraftChange,
  onImagesChange,
  visionEnabled,
  onPrepareSpeech,
  onStartSpeech,
  onStopSpeech,
  onCancelSpeech,
  onSpeakText,
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
  const [deleteTarget, setDeleteTarget] = useState<ChatConversation | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteDialogError, setDeleteDialogError] = useState("");
  const [recommendations, setRecommendations] = useState(DEFAULT_SUGGESTIONS);
  const [activeRequest, setActiveRequest] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const assistantByRequest = useRef(new Map<string, string>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef(false);
  const mountedRef = useRef(true);
  const messagesRef = useRef<ChatMessage[]>([]);
  const conversationIdRef = useRef<string | null>(null);
  const persistenceModeRef = useRef<PersistenceMode>("loading");
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const initializationRef = useRef<Promise<ChatInitialization> | null>(null);
  const conversationOperationTokenRef = useRef(0);
  const conversationOperationPendingRef = useRef(false);
  const recommendationRequestTokenRef = useRef(0);
  const composerRevisionRef = useRef(0);
  const observedDraftRef = useRef(draft);
  const observedImagesRef = useRef(images);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyNewButtonRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusAfterHistoryCloseRef = useRef(false);
  const onDraftChangeRef = useRef(onDraftChange);
  const onImagesChangeRef = useRef(onImagesChange);
  onDraftChangeRef.current = onDraftChange;
  onImagesChangeRef.current = onImagesChange;
  if (observedDraftRef.current !== draft) {
    observedDraftRef.current = draft;
    composerRevisionRef.current += 1;
  }
  if (observedImagesRef.current !== images) {
    observedImagesRef.current = images;
    composerRevisionRef.current += 1;
  }

  const handleThinkingChange = useCallback((thinking: boolean) => {
    thinkingRef.current = thinking;
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

  const readCachedRecommendations = useCallback(async (): Promise<string[]> => {
    try {
      const nextRecommendations = await window.desktopPet.getChatRecommendations();
      return nextRecommendations.length === 3 ? nextRecommendations : DEFAULT_SUGGESTIONS;
    } catch {
      return DEFAULT_SUGGESTIONS;
    }
  }, []);

  const refreshCachedRecommendations = useCallback((
    expectedConversationId: string | null,
  ): void => {
    const requestToken = ++recommendationRequestTokenRef.current;
    void readCachedRecommendations().then((nextRecommendations) => {
      if (
        !mountedRef.current ||
        requestToken !== recommendationRequestTokenRef.current ||
        conversationIdRef.current !== expectedConversationId ||
        messagesRef.current.length
      ) return;
      setRecommendations(nextRecommendations);
    });
  }, [readCachedRecommendations]);

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
    setAttachmentError("");
    if (resetComposer) {
      changeDraft("");
      changeImages([]);
    }
  }, [changeDraft, changeImages]);

  useEffect(() => {
    let cancelled = false;
    const initializationComposerRevision = composerRevisionRef.current;
    const initializationComposerWasEmpty =
      observedDraftRef.current.length === 0 && observedImagesRef.current.length === 0;
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
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  useLayoutEffect(() => {
    if (historyOpen || !focusAfterHistoryCloseRef.current) return;
    focusAfterHistoryCloseRef.current = false;
    textareaRef.current?.focus({ preventScroll: true });
  }, [conversationId, historyOpen]);

  useEffect(() => {
    if (persistenceMode !== "database" || messages.length) {
      recommendationRequestTokenRef.current += 1;
      setRecommendations(DEFAULT_SUGGESTIONS);
      return;
    }
    // Cache-only IPC: this never starts model inference from the interactive
    // Chat Panel. Idle precomputation is owned by the main process.
    refreshCachedRecommendations(conversationId);
  }, [conversationId, messages.length, persistenceMode, refreshCachedRecommendations]);

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
        if (event.type === "done" || event.type === "error") {
          if (event.type === "error") {
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
            scheduleSave(true, true);
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
      setRecommendations(DEFAULT_SUGGESTIONS);
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
      setRecommendations(DEFAULT_SUGGESTIONS);
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
    setDeleteTarget(target);
  };

  const closeDeleteDialog = (): void => {
    if (deletePending) return;
    const trigger = deleteTriggerRef.current;
    setDeleteDialogError("");
    setDeleteTarget(null);
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      else historyNewButtonRef.current?.focus({ preventScroll: true });
    });
  };

  const confirmDeleteConversation = async (): Promise<void> => {
    const target = deleteTarget;
    if (!target) return;
    const operation = beginConversationOperation("delete");
    if (!operation) return;
    setDeletePending(true);
    setDeleteDialogError("");
    let succeeded = false;
    try {
      await persistMessages(false, true);
      if (!operationIsCurrent(operation)) return;
      await window.desktopPet.deleteChatConversation(target.id);
      if (!operationIsCurrent(operation)) return;
      let nextConversations = await window.desktopPet.listChatConversations();
      if (!operationIsCurrent(operation)) return;
      let nextConversationId = conversationIdRef.current;
      let nextMessages: ChatMessage[] | null = null;
      if (target.id === conversationIdRef.current) {
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
      const visibleMessages = nextMessages ?? messagesRef.current;
      if (nextMessages && nextConversationId) {
        loadIntoState(
          nextConversationId,
          nextMessages,
          shouldResetComposer(operation.composerRevision, composerRevisionRef.current),
        );
      }
      setConversations(nextConversations);
      setRecommendations(DEFAULT_SUGGESTIONS);
      if (visibleMessages.length) {
        recommendationRequestTokenRef.current += 1;
      } else {
        refreshCachedRecommendations(nextConversationId);
      }
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
          setDeleteTarget(null);
          setDeleteDialogError("");
          deleteTriggerRef.current = null;
          requestAnimationFrame(() => {
            historyNewButtonRef.current?.focus({ preventScroll: true });
          });
        }
      }
    }
  };

  const send = () => {
    const text = draft.trim();
    if (
      (!text && !images.length) ||
      activeRequest ||
      conversationOperationPendingRef.current ||
      runtime.phase !== "ready" ||
      persistenceMode === "loading"
    ) return;
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
    const nextMessages = [...messagesRef.current, user];
    assistantByRequest.current.set(requestId, assistant.id);
    updateMessages([...nextMessages, assistant], true, true);
    changeDraft("");
    changeImages([]);
    setAttachmentError("");
    setActiveRequest(requestId);
    window.desktopPet.startChat({
      requestId,
      messages: nextMessages,
      thinking: thinkingRef.current,
    });
  };

  const removeImage = (index: number) => {
    changeImages(images.filter((_image, imageIndex) => imageIndex !== index));
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
          className={`history-drawer${conversationOperationPending ? " history-drawer--busy" : ""}${deleteTarget ? " history-drawer--dialog-open" : ""}`}
          aria-label="聊天历史"
          aria-busy={conversationOperationPending}
          inert={deleteTarget ? true : undefined}
        >
          <div className="history-drawer__header">
            <div>
              <b>聊天历史</b>
              <small>本地保存最近 30 个会话</small>
            </div>
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
          {historyOperationError && (
            <p className="history-drawer__error" role="alert">
              {historyOperationError}
            </p>
          )}
          <div className="history-drawer__list">
            {conversations.map((conversation) => (
              <div
                className={`history-item ${conversation.id === conversationId ? "history-item--active" : ""}`}
                key={conversation.id}
              >
                <button
                  className="history-item__select"
                  type="button"
                  disabled={Boolean(activeRequest) || conversationOperationPending}
                  onClick={() => void switchConversation(conversation.id)}
                >
                  <b>{conversation.title}</b>
                  <small>
                    {formatConversationTime(conversation.updatedAt)} · {conversation.messageCount} 条消息
                  </small>
                </button>
                <button
                  className="history-item__delete"
                  type="button"
                  disabled={Boolean(activeRequest) || conversationOperationPending}
                  aria-label={`删除 ${conversation.title}`}
                  onClick={(event) => requestDeleteConversation(conversation, event.currentTarget)}
                >
                  <PixelIcon name="trash" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="删除这个对话？"
          description={`“${deleteTarget.title}”及其中 ${deleteTarget.messageCount} 条消息将被永久删除，无法恢复。`}
          confirmLabel="删除对话"
          pendingLabel="删除中…"
          pending={deletePending}
          error={deleteDialogError}
          onCancel={closeDeleteDialog}
          onConfirm={() => void confirmDeleteConversation()}
        />
      )}

      <section className="chat-log" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="empty-chat">
            <Pet
              mood={mood}
              clipMood={speech.phase === "recording" ? "idle" : undefined}
              compact
            />
            <h2>今天想聊点什么？</h2>
            <p></p>
            <div className="suggestion-grid">
              {recommendations.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    changeDraft(suggestion);
                  }}
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
                {message.role === "assistant" && message.content.trim() && (
                  <button
                    className={`message-speak${tts.phase === "speaking" ? " message-speak--active" : ""}`}
                    type="button"
                    disabled={!tts.enabled}
                    aria-label={tts.phase === "speaking" ? "正在朗读" : "朗读这段回答"}
                    title={tts.enabled ? "朗读这段回答" : "请先在设置中启用语音朗读"}
                    onClick={() => void onSpeakText(message.content)}
                  >
                    <PixelIcon name="volume" />
                  </button>
                )}
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
            clipMood={speech.phase === "recording" ? "idle" : undefined}
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
            <ThinkingToggle onChange={handleThinkingChange} />
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
          </div>
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
        <ImageAttachmentTray images={images} onRemove={removeImage} />
        {attachmentError && <p className="composer__error">{attachmentError}</p>}
        <div className="composer__input">
          <textarea
            ref={textareaRef}
            rows={2}
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
            onCancel={onCancelSpeech}
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
                (!draft.trim() && !images.length) ||
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
