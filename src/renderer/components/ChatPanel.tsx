import { useChat } from "@ai-sdk/react";
import type { DynamicToolUIPart } from "ai";
import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type {
  ChatContextUsage,
  ChatConversation,
  ChatDocument,
  ChatImage,
  ChatMessage,
  RuntimeState,
  SpeechState,
  TtsState,
  ThinkingEffort,
} from "../../shared/types";
import { clearLegacyChatHistory, readChatHistory, writeChatHistory } from "../chat-history";
import {
  chatMessageToDesktopUIMessage,
  chatMessagesToDesktopUIMessages,
  desktopUIMessagesToChatMessages,
  readDesktopToolMetadata,
  type DesktopUIMessage,
} from "../chat/desktop-ui-message";
import { ElectronChatTransport } from "../chat/electron-chat-transport";
import {
  registerChatPersistenceFlush,
  trackChatPersistence,
} from "../chat-persistence-coordinator";
import { copyTextViaDocument, copyTextWithFallback } from "../clipboard";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { VoiceButton } from "./VoiceButton";
import { ImageAttachButton, ImageAttachmentTray } from "./ImageAttachments";
import { DocumentAttachButton, DocumentAttachmentTray } from "./DocumentAttachments";
import { PixelIcon } from "./PixelIcon";
import { ContextUsageIndicator, ModelReasoningControl } from "./ChatComposerControls";
import { ChatHistoryList } from "./ChatHistoryList";
import { ChatMessageView } from "./ChatMessageView";
import { RuntimeLoadingDock } from "./RuntimeLoadingDock";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./ai-elements/conversation";
import {
  PromptInput,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "./ai-elements/prompt-input";
import { Suggestion, Suggestions } from "./ai-elements/suggestion";
import {
  conversationOperationUiPolicy,
  regenerationBaseMessages,
  terminalizeAssistantGeneration,
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
  modelLabel: string;
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
  onStartRuntime: () => Promise<void>;
  activePage?: "chat" | "tasks" | "settings";
  taskContent?: ReactNode;
  settingsContent?: ReactNode;
  onNavigate?: (page: "chat" | "tasks" | "settings") => boolean;
  onOpenCaption?: () => void;
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

interface ChatSession {
  id: string;
  initialMessages: DesktopUIMessage[];
}

const sidebarActionClassName = [
  "text-sidebar-foreground/70",
  "data-[active=true]:text-primary",
].join(" ");

function showChatError(message: string): void {
  toast.error("对话出错", {
    description: message,
    id: `chat-error:${message}`,
  });
}

function showChatWarning(message: string): void {
  toast.warning("对话提示", {
    description: message,
    id: `chat-warning:${message}`,
  });
}

function latestContextUsage(messages: ChatMessage[]): ChatContextUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].contextUsage) return messages[index].contextUsage;
  }
  return undefined;
}

function terminalizeLatestAssistant(
  messages: ChatMessage[],
  fallbackContent: string,
  activeToolError: string,
): ChatMessage[] {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  return assistant
    ? terminalizeAssistantGeneration(
        assistant.id,
        messages,
        fallbackContent,
        activeToolError,
      )
    : messages;
}

export function ChatPanel({
  runtime,
  speech,
  tts,
  chatTemplates,
  maxTokens,
  contextSize,
  modelLabel,
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
  onStartRuntime,
  activePage = "chat",
  taskContent,
  settingsContent,
  onNavigate,
  onOpenCaption,
}: ChatPanelProps) {
  const [chatSession, setChatSession] = useState<ChatSession>({
    id: "desktop-chat:loading",
    initialMessages: [],
  });
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [persistenceMode, setPersistenceMode] = useState<PersistenceMode>("loading");
  const [conversationOperationPending, setConversationOperationPending] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<ChatConversation[]>([]);
  const [deletePending, setDeletePending] = useState(false);
  const [historyBatchMode, setHistoryBatchMode] = useState(false);
  const [selectedConversationIds, setSelectedConversationIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [copyPopupVisible, setCopyPopupVisible] = useState(false);
  const [workbenchState, setWorkbenchState] = useState({
    maximized: false,
    sidebarCollapsed: false,
  });
  const [sidebarTogglePending, setSidebarTogglePending] = useState(false);
  const mountedRef = useRef(true);
  const finishChatRef = useRef<((
    messages: DesktopUIMessage[],
    isAbort: boolean,
    isError: boolean,
  ) => void) | null>(null);
  const lastChatErrorRef = useRef("");
  const transport = useMemo(() => new ElectronChatTransport({
    startChat: (request) => window.desktopPet.startChat(request),
    abortChat: (requestId) => window.desktopPet.abortChat(requestId),
    onChatEvent: (listener) => window.desktopPet.onChatEvent(listener),
  }), []);
  const chat = useChat<DesktopUIMessage>({
    id: chatSession.id,
    messages: chatSession.initialMessages,
    transport,
    onData: (part) => {
      if (part.type === "data-warning" && mountedRef.current) {
        showChatWarning(part.data.message);
      }
    },
    onError: (error) => {
      lastChatErrorRef.current = error.message;
      if (mountedRef.current) showChatError(error.message);
    },
    onFinish: ({ messages: finishedMessages, isAbort, isError }) => {
      finishChatRef.current?.(finishedMessages, isAbort, isError);
    },
  });
  const uiMessages = chat.messages;
  const messages = useMemo(
    () => desktopUIMessagesToChatMessages(uiMessages),
    [uiMessages],
  );
  const generationActive = chat.status === "submitted" || chat.status === "streaming";
  const activeRequest = generationActive
    ? [...uiMessages].reverse().find((message) => message.role === "assistant")
      ?.metadata?.requestId ?? "desktop-chat:active"
    : null;
  const thinkingRef = useRef(false);
  const thinkingEffortRef = useRef<ThinkingEffort>("medium");
  const messagesRef = useRef<ChatMessage[]>([]);
  const uiMessagesRef = useRef<DesktopUIMessage[]>(uiMessages);
  const generationActiveRef = useRef(generationActive);
  const activeGenerationPromiseRef = useRef<Promise<void> | null>(null);
  const stopChatRef = useRef(chat.stop);
  const setUiMessagesRef = useRef(chat.setMessages);
  const lastSyncedChatIdRef = useRef(chatSession.id);
  const lastSyncedUIMessagesRef = useRef(uiMessages);
  uiMessagesRef.current = uiMessages;
  generationActiveRef.current = generationActive;
  stopChatRef.current = chat.stop;
  setUiMessagesRef.current = chat.setMessages;
  const conversationIdRef = useRef<string | null>(null);
  const persistenceModeRef = useRef<PersistenceMode>("loading");
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyPopupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const initializationRef = useRef<Promise<ChatInitialization> | null>(null);
  const conversationOperationTokenRef = useRef(0);
  const conversationOperationPendingRef = useRef(false);
  const approvalResponsesRef = useRef(new Set<string>());
  const composerRevisionRef = useRef(0);
  const observedDraftRef = useRef(draft);
  const observedImagesRef = useRef(images);
  const observedDocumentsRef = useRef(documents);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyNewButtonRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const deleteTargetsSnapshotRef = useRef<ChatConversation[]>([]);
  const sidebarTogglePendingRef = useRef(false);
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

  const applyChatTemplate = useCallback((value: string) => {
    changeDraft(value);
    requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
  }, [changeDraft]);

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
          showChatError(
            `聊天记录保存失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    trackChatPersistence(saveOperation, currentConversationId);
    return requireSuccess ? saveOperation : saveChainRef.current;
  }, []);

  useEffect(() => registerChatPersistenceFlush(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (generationActiveRef.current) {
      await stopChatRef.current();
      await activeGenerationPromiseRef.current?.catch(() => undefined);
    }
    await persistMessages(false, true);
  }), [persistMessages]);

  useEffect(() => {
    void window.desktopPet.getWorkbenchWindowState().then(setWorkbenchState);
    return window.desktopPet.onWorkbenchWindowState(setWorkbenchState);
  }, []);

  const toggleSidebar = (): void => {
    if (sidebarTogglePendingRef.current) return;
    const previousCollapsed = workbenchState.sidebarCollapsed;
    sidebarTogglePendingRef.current = true;
    setSidebarTogglePending(true);
    setWorkbenchState((current) => ({
      ...current,
      sidebarCollapsed: !previousCollapsed,
    }));
    void window.desktopPet
      .setSidebarCollapsed(!previousCollapsed)
      .then((state) => {
        if (mountedRef.current) setWorkbenchState(state);
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        setWorkbenchState((current) => ({
          ...current,
          sidebarCollapsed: previousCollapsed,
        }));
        showChatError(
          `侧栏状态保存失败：${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        sidebarTogglePendingRef.current = false;
        if (mountedRef.current) setSidebarTogglePending(false);
      });
  };

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
    setUiMessagesRef.current(chatMessagesToDesktopUIMessages(next));
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
    setChatSession({
      id: id ?? "desktop-chat:legacy",
      initialMessages: chatMessagesToDesktopUIMessages(nextMessages),
    });
    if (resetComposer) {
      changeDraft("");
      changeImages([]);
      changeDocuments([]);
    }
  }, [changeDocuments, changeDraft, changeImages]);

  useEffect(() => {
    if (
      lastSyncedChatIdRef.current === chatSession.id
      && lastSyncedUIMessagesRef.current === uiMessages
    ) return;
    messagesRef.current = messages;
    if (lastSyncedChatIdRef.current === chatSession.id) {
      dirtyRef.current = true;
      scheduleSave();
    }
    lastSyncedChatIdRef.current = chatSession.id;
    lastSyncedUIMessagesRef.current = uiMessages;
  }, [chatSession.id, messages, scheduleSave, uiMessages]);

  finishChatRef.current = (finishedMessages, isAbort, isError) => {
    let next = desktopUIMessagesToChatMessages(finishedMessages);
    if (isAbort || isError) {
      const errorMessage = isAbort
        ? "任务已由用户停止。"
        : `任务因生成错误而终止：${lastChatErrorRef.current || "未知错误"}`;
      next = terminalizeLatestAssistant(
        next,
        isAbort ? "（团子停下了）" : `⚠ ${lastChatErrorRef.current || "生成失败"}`,
        errorMessage,
      );
      if (mountedRef.current) {
        setUiMessagesRef.current(chatMessagesToDesktopUIMessages(next));
      }
    }
    messagesRef.current = next;
    dirtyRef.current = true;
    scheduleSave(true, true);
    lastChatErrorRef.current = "";
  };

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
        showChatWarning("本地聊天数据库暂不可用，当前使用浏览器存储兜底。");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadIntoState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      conversationOperationTokenRef.current += 1;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (copyPopupTimerRef.current) clearTimeout(copyPopupTimerRef.current);
      if (generationActiveRef.current) {
        void stopChatRef.current();
        const generation = activeGenerationPromiseRef.current;
        if (generation) {
          void generation
            .catch(() => undefined)
            .finally(() => persistMessages());
          return;
        }
      }
      void persistMessages();
    };
  }, [persistMessages]);

  const operationIsCurrent = (operation: ConversationOperation): boolean =>
    mountedRef.current && isCurrentConversationOperation(
      operation.token,
      conversationOperationTokenRef.current,
    );

  const closeHistoryAndFocusComposer = (): void => {
    setHistoryBatchMode(false);
    setSelectedConversationIds(new Set());
    requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
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

  const createConversation = async () => {
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
        showChatError(message);
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
        showChatError(
          `切换对话失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      finishConversationOperation(operation);
    }
  };

  const requestDeleteConversation = (
    target: ChatConversation,
    trigger?: HTMLButtonElement,
  ): void => {
    if (
      activeRequest ||
      persistenceMode !== "database" ||
      conversationOperationPendingRef.current
    ) return;
    deleteTriggerRef.current = trigger ?? null;
    deleteTargetsSnapshotRef.current = [target];
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
    deleteTargetsSnapshotRef.current = targets;
    setDeleteTargets(targets);
  };

  const closeDeleteDialog = (): void => {
    if (deletePending) return;
    const trigger = deleteTriggerRef.current;
    deleteTriggerRef.current = null;
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
        showChatError(
          `删除对话失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      finishConversationOperation(operation);
      if (operationIsCurrent(operation)) {
        setDeletePending(false);
        if (succeeded) {
          setDeleteTargets([]);
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
      setCopyPopupVisible(true);
      if (copyPopupTimerRef.current) clearTimeout(copyPopupTimerRef.current);
      copyPopupTimerRef.current = setTimeout(() => {
        copyPopupTimerRef.current = null;
        setCopyPopupVisible(false);
      }, 1_600);
    } catch (error) {
      showChatError(`复制失败：${error instanceof Error ? error.message : String(error)}`);
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
    lastChatErrorRef.current = "";
    const generation = chat.sendMessage(undefined, {
      body: {
        mode: "continue",
        thinking: thinkingRef.current,
        thinkingEffort: thinkingEffortRef.current,
      },
    });
    activeGenerationPromiseRef.current = generation;
    void generation.catch((error) => {
      if (mountedRef.current) {
        showChatError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (activeGenerationPromiseRef.current === generation) {
        activeGenerationPromiseRef.current = null;
      }
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
    const nextMessages = [...messagesRef.current, user];
    messagesRef.current = nextMessages;
    dirtyRef.current = true;
    scheduleSave(true, true);
    lastChatErrorRef.current = "";
    const generation = chat.sendMessage(chatMessageToDesktopUIMessage(user), {
      body: {
        thinking: thinkingRef.current,
        thinkingEffort: thinkingEffortRef.current,
      },
    });
    activeGenerationPromiseRef.current = generation;
    void generation.catch((error) => {
      if (mountedRef.current) {
        showChatError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (activeGenerationPromiseRef.current === generation) {
        activeGenerationPromiseRef.current = null;
      }
    });
    changeDraft("");
    changeImages([]);
    changeDocuments([]);
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
    const targetAssistantId = messagesRef.current.at(-1)?.id;
    if (!targetAssistantId) return;
    if (tts.phase === "speaking") void onStopSpeaking();
    messagesRef.current = baseMessages;
    dirtyRef.current = true;
    scheduleSave(true, true);
    lastChatErrorRef.current = "";
    const generation = chat.regenerate({
      messageId: targetAssistantId,
      body: {
        thinking: thinkingRef.current,
        thinkingEffort: thinkingEffortRef.current,
      },
    });
    activeGenerationPromiseRef.current = generation;
    void generation.catch((error) => {
      if (mountedRef.current) {
        showChatError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (activeGenerationPromiseRef.current === generation) {
        activeGenerationPromiseRef.current = null;
      }
    });
  };

  const removeImage = (index: number) => {
    changeImages(images.filter((_image, imageIndex) => imageIndex !== index));
  };

  const removeDocument = (index: number) => {
    changeDocuments(documents.filter((_document, documentIndex) => documentIndex !== index));
  };

  const resolveToolApproval = useCallback((
    _requestId: string,
    toolCallId: string,
    approved: boolean,
  ) => {
    let target: DynamicToolUIPart | undefined;
    for (let messageIndex = uiMessagesRef.current.length - 1; messageIndex >= 0; messageIndex -= 1) {
      target = uiMessagesRef.current[messageIndex].parts.find((part) => (
        part.type === "dynamic-tool"
        && part.toolCallId === toolCallId
        && part.state === "approval-requested"
      )) as DynamicToolUIPart | undefined;
      if (target) break;
    }
    if (!target || target.state !== "approval-requested") return;
    const routing = readDesktopToolMetadata(target);
    if (!routing.requestId) {
      showChatError("无法确认工具调用所属的生成请求，请停止后重试。");
      return;
    }
    const approvalId = target.approval.id;
    const requestId = routing.requestId;
    if (approvalResponsesRef.current.has(approvalId)) return;
    approvalResponsesRef.current.add(approvalId);
    void Promise.resolve(chat.addToolApprovalResponse({
      id: approvalId,
      approved,
    })).then(() => {
      window.desktopPet.resolveToolApproval(requestId, toolCallId, approved);
    }).catch((error) => {
      approvalResponsesRef.current.delete(approvalId);
      if (mountedRef.current) {
        showChatError(error instanceof Error ? error.message : String(error));
      }
    });
  }, [chat.addToolApprovalResponse]);

  const stopGeneration = (): void => {
    if (!generationActiveRef.current) return;
    void chat.stop();
  };

  const speechBusy = speech.phase === "recording" || speech.phase === "transcribing";
  const composerBusy = runtime.phase !== "ready"
    || Boolean(activeRequest)
    || conversationOperationPending
    || speechBusy;
  const imageAttachDisabled = !visionEnabled || composerBusy;
  const documentAttachDisabled = composerBusy;
  const imageAttachDisabledReason = !visionEnabled
    ? "请先在设置中选择视觉投影模型"
    : runtime.phase !== "ready"
      ? "等待本地模型就绪后再上传图片"
      : activeRequest
        ? "回答生成期间不能更改附件"
        : speechBusy
          ? "语音输入期间不能更改附件"
          : "正在切换对话，请稍候";
  const documentAttachDisabledReason = runtime.phase !== "ready"
    ? "等待本地模型就绪后再上传文档"
    : activeRequest
      ? "回答生成期间不能更改附件"
      : speechBusy
        ? "语音输入期间不能更改附件"
        : "正在切换对话，请稍候";
  const visibleChatTemplates = useMemo(
    () => chatTemplates.map((template) => template.trim()).filter(Boolean),
    [chatTemplates],
  );
  const contextUsage = useMemo(
    () => latestContextUsage(messages),
    [messages],
  );
  const visibleDeleteTargets = deleteTargets.length > 0
    ? deleteTargets
    : deleteTargetsSnapshotRef.current;
  const latestMessage = messages.at(-1);
  const streamingAssistantId = generationActive && latestMessage?.role === "assistant"
    ? latestMessage.id
    : undefined;

  return (
    <main className="workbench-shell h-screen w-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-full min-h-0">
        <aside
          aria-label="工作台侧栏"
          className={cn(
            "workbench-sidebar flex h-full min-w-0 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar p-3 text-sidebar-foreground transition-[width] duration-200",
            workbenchState.sidebarCollapsed ? "w-[72px]" : "w-[264px]",
          )}
        >
          <div className={cn(
            "mb-3 flex h-9 items-center gap-2",
            workbenchState.sidebarCollapsed && "justify-center",
          )}>
            {!workbenchState.sidebarCollapsed ? (
              <>
                <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg border bg-card">
                  <img className="size-7 object-contain" src="./app-icon.png" alt="" />
                </span>
                <b className="min-w-0 flex-1 truncate text-sm">团子</b>
              </>
            ) : null}
            <Button
              aria-label={workbenchState.sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
              disabled={sidebarTogglePending}
              onClick={toggleSidebar}
              size="icon-sm"
              title={workbenchState.sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
              type="button"
              variant="soft"
            >
              <PixelIcon name={workbenchState.sidebarCollapsed ? "sidebar-open" : "sidebar-close"} />
            </Button>
          </div>

          <Button
            ref={historyNewButtonRef}
            className={cn(
              "mb-3 w-full",
              workbenchState.sidebarCollapsed ? "px-0" : "justify-start",
            )}
            disabled={Boolean(activeRequest) || conversationOperationPending}
            onClick={() => {
              if (onNavigate?.("chat") !== false) void createConversation();
            }}
            title="新建对话"
            type="button"
          >
            <PixelIcon name="plus" />
            {!workbenchState.sidebarCollapsed ? <span>新建对话</span> : null}
          </Button>

          <section
            aria-busy={conversationOperationPending}
            aria-label="聊天历史"
            className={cn(
              "flex min-h-0 min-w-0 flex-1 overflow-hidden",
              workbenchState.sidebarCollapsed && "invisible pointer-events-none",
            )}
            inert={deleteTargets.length ? true : undefined}
          >
            <ChatHistoryList
              batchMode={historyBatchMode}
              busy={conversationOperationPending}
              conversationId={conversationId}
              conversations={conversations}
              generationActive={Boolean(activeRequest)}
              pendingDeleteId={deleteTargets.length === 1
                ? deleteTargets[0]?.id
                : undefined}
              onDeleteSelected={requestDeleteSelectedConversations}
              onRequestDelete={requestDeleteConversation}
              onSwitch={(id) => {
                if (onNavigate?.("chat") !== false) void switchConversation(id);
              }}
              onToggleBatch={() => {
                setHistoryBatchMode((current) => !current);
                setSelectedConversationIds(new Set());
              }}
              onToggleSelectAll={() => setSelectedConversationIds(
                selectedConversationIds.size === conversations.length
                  ? new Set()
                  : new Set(conversations.map((conversation) => conversation.id)),
              )}
              onToggleSelection={toggleConversationSelection}
              selectedIds={selectedConversationIds}
            />
          </section>

          <Separator className="my-2 bg-sidebar-border" />
          <div className={cn(
            "flex items-center gap-1",
            workbenchState.sidebarCollapsed ? "flex-col" : "justify-between px-1",
          )}>
            <Button
              aria-label="打开实时字幕"
              className={sidebarActionClassName}
              onClick={onOpenCaption}
              size="icon-sm"
              title="打开实时字幕"
              type="button"
              variant="soft"
            >
              <PixelIcon name="captions" />
            </Button>
            <Button
              aria-label="长期任务"
              aria-current={activePage === "tasks" ? "page" : undefined}
              className={sidebarActionClassName}
              data-active={activePage === "tasks"}
              onClick={() => onNavigate?.("tasks")}
              size="icon-sm"
              title="打开长期任务"
              type="button"
              variant="soft"
            >
              <PixelIcon name="tasks" />
            </Button>
            <Button
              aria-label="设置"
              aria-current={activePage === "settings" ? "page" : undefined}
              className={sidebarActionClassName}
              data-active={activePage === "settings"}
              onClick={() => onNavigate?.("settings")}
              size="icon-sm"
              title="打开设置"
              type="button"
              variant="soft"
            >
              <PixelIcon name="settings" />
            </Button>
            <Button
              aria-label="返回桌面宠物"
              className={sidebarActionClassName}
              onClick={onClose}
              size="icon-sm"
              title="返回桌面宠物"
              type="button"
              variant="soft"
            >
              <PixelIcon name="cat" />
            </Button>
          </div>
        </aside>

        <section className="workbench-content min-w-0 flex-1 bg-background">
          <div className="chat-panel relative flex h-full min-h-0 flex-col">
            <header className="flex h-12 shrink-0 items-center border-b px-5">
              <b className="truncate text-sm font-medium">
                {conversations.find((item) => item.id === conversationId)?.title ?? "新对话"}
              </b>
            </header>

            <AlertDialog
              open={deleteTargets.length > 0}
              onOpenChange={(open) => {
                if (!open) closeDeleteDialog();
              }}
            >
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {visibleDeleteTargets.length === 1
                      ? "删除这个对话？"
                      : `删除 ${visibleDeleteTargets.length} 个对话？`}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {visibleDeleteTargets.length === 1
                      ? `“${visibleDeleteTargets[0]?.title ?? ""}”及其中 ${visibleDeleteTargets[0]?.messageCount ?? 0} 条消息将被永久删除，无法恢复。`
                      : `所选对话及其中 ${visibleDeleteTargets.reduce((total, target) => total + target.messageCount, 0)} 条消息将被永久删除，无法恢复。`}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deletePending} onClick={closeDeleteDialog}>
                    取消
                  </AlertDialogCancel>
                  <AlertDialogAction
                    disabled={deletePending}
                    onClick={(event) => {
                      event.preventDefault();
                      void confirmDeleteConversation();
                    }}
                    variant="destructive"
                  >
                    {deletePending
                      ? "删除中…"
                      : visibleDeleteTargets.length === 1
                        ? "删除对话"
                        : "批量删除"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <Conversation className="min-h-0">
              <ConversationContent className="mx-auto w-full max-w-4xl gap-6 px-6 py-8">
                {messages.length === 0 ? (
                  <ConversationEmptyState
                    className="min-h-[clamp(180px,32vh,420px)]"
                  >
                    <div className="w-full max-w-2xl space-y-5">
                      <div className="space-y-2 text-center">
                        <h2 className="workbench-empty-title">今天想完成什么？</h2>
                        <p className="text-sm text-muted-foreground">
                          让本地模型调用工具、分析文件或继续完善你的想法。
                        </p>
                      </div>
                      {visibleChatTemplates.length ? (
                        <Suggestions
                          aria-label="快捷模板"
                          className="w-full flex-wrap justify-center"
                        >
                          {visibleChatTemplates.map((template, index) => (
                            <Suggestion
                              className="h-auto min-h-11 max-w-72 gap-2.5 whitespace-normal px-3.5 py-2.5 text-left leading-snug"
                              key={`${index}-${template}`}
                              onClick={applyChatTemplate}
                              suggestion={template}
                            >
                              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                                <Sparkles className="size-3.5" />
                              </span>
                              <span className="line-clamp-2">{template}</span>
                            </Suggestion>
                          ))}
                        </Suggestions>
                      ) : null}
                    </div>
                  </ConversationEmptyState>
                ) : (
                  uiMessages.map((message, messageIndex) => (
                    <ChatMessageView
                      activeRequestId={
                        activeRequest && streamingAssistantId === message.id
                          ? activeRequest
                          : undefined
                      }
                      conversationOperationPending={conversationOperationPending}
                      isLast={messageIndex === uiMessages.length - 1}
                      key={message.id}
                      message={message}
                      onApproval={resolveToolApproval}
                      onContinue={continueGeneration}
                      onCopy={copyMessage}
                      onRegenerate={regenerate}
                      onSpeakText={onSpeakText}
                      onStopSpeaking={onStopSpeaking}
                      runtime={runtime}
                      tts={tts}
                    />
                  ))
                )}
              </ConversationContent>
              <ConversationScrollButton aria-label="回到最新消息" />
            </Conversation>

            {copyPopupVisible ? (
              <Badge
                className="pointer-events-none absolute right-6 top-16 z-20 gap-1 shadow-md"
                role="status"
                aria-live="polite"
              >
                <PixelIcon name="copy" />
                已复制到剪贴板
              </Badge>
            ) : null}
            <footer className="shrink-0 border-t bg-background/95 px-6 pb-3 pt-3">
              <div className="mx-auto max-w-4xl">
                <PromptInput
                  attachmentsEnabled={false}
                  className="w-full rounded-2xl"
                  onSubmit={({ files }) => {
                    if (files.length) {
                      showChatWarning("请使用输入框下方的图片或文档按钮选择附件。");
                      return;
                    }
                    send();
                  }}
                >
                  {runtime.phase !== "ready" ? (
                    <PromptInputHeader className="block p-0">
                      <RuntimeLoadingDock
                        modelLabel={modelLabel}
                        onStart={onStartRuntime}
                        runtime={runtime}
                      />
                    </PromptInputHeader>
                  ) : null}
                  {(images.length || documents.length) ? (
                    <PromptInputHeader className="block space-y-2 px-3 pt-3">
                      <ImageAttachmentTray images={images} onRemove={removeImage} />
                      <DocumentAttachmentTray documents={documents} onRemove={removeDocument} />
                    </PromptInputHeader>
                  ) : null}
                  <PromptInputBody>
                    <PromptInputTextarea
                      ref={textareaRef}
                      className="min-h-20 max-h-64 px-4 pt-3 text-[15px] leading-6"
                      disabled={speechBusy}
                      onBlur={() => window.desktopPet.setSpeechComposerFocused(false)}
                      onChange={(event) => changeDraft(event.target.value)}
                      onFocus={() => {
                        window.desktopPet.setSpeechComposerFocused(true);
                      }}
                      placeholder={runtime.phase === "ready"
                        ? "描述你想完成的任务…"
                        : "等待本地模型就绪…"}
                      rows={3}
                      value={draft}
                    />
                  </PromptInputBody>
                  <PromptInputFooter>
                    <PromptInputTools>
                      <PromptInputActionMenu>
                        <PromptInputActionMenuTrigger
                          aria-label="添加附件"
                          disabled={imageAttachDisabled && documentAttachDisabled}
                          title="添加附件"
                        />
                        <PromptInputActionMenuContent>
                          <ImageAttachButton
                            disabled={imageAttachDisabled}
                            disabledReason={imageAttachDisabledReason}
                            images={images}
                            menuItem
                            onChange={changeImages}
                            onError={showChatError}
                          />
                          <DocumentAttachButton
                            disabled={documentAttachDisabled}
                            disabledReason={documentAttachDisabledReason}
                            documents={documents}
                            menuItem
                            onChange={changeDocuments}
                            onError={showChatError}
                          />
                        </PromptInputActionMenuContent>
                      </PromptInputActionMenu>
                    </PromptInputTools>
                    <div className="flex min-w-0 items-center gap-1">
                      <ModelReasoningControl
                        maxTokens={maxTokens}
                        modelLabel={modelLabel}
                        onChange={handleThinkingChange}
                        runtime={runtime}
                      />
                      <ContextUsageIndicator contextSize={contextSize} usage={contextUsage} />
                      <VoiceButton
                        compact
                        onPrepare={onPrepareSpeech}
                        onStart={onStartSpeech}
                        onStop={onStopSpeech}
                        speech={speech}
                      />
                      <PromptInputSubmit
                        aria-label={activeRequest ? "停止生成" : "发送"}
                        disabled={!activeRequest && (
                          (!draft.trim() && !images.length && !documents.length) ||
                          runtime.phase !== "ready" ||
                          conversationOperationPending ||
                          speechBusy
                        )}
                        onStop={stopGeneration}
                        status={activeRequest ? "streaming" : "ready"}
                      />
                    </div>
                  </PromptInputFooter>
                </PromptInput>
                <p className="mt-2 text-center text-[11px] text-muted-foreground">
                  AI 生成可能不准确，请核实重要信息
                </p>
              </div>
            </footer>
          </div>
          <Dialog
            open={activePage === "tasks"}
            onOpenChange={(open) => {
              if (!open) onNavigate?.("chat");
            }}
          >
            <DialogContent
              className="h-[calc(100vh-28px)] max-h-[calc(100vh-28px)] w-[calc(100vw-28px)] max-w-none overflow-hidden border p-0 sm:max-w-none"
            >
              <DialogTitle className="sr-only">长期任务</DialogTitle>
              <DialogDescription className="sr-only">
                创建、执行、暂停和恢复可跨应用重启保存的长期任务。
              </DialogDescription>
              {taskContent}
            </DialogContent>
          </Dialog>
          <Dialog
            open={activePage === "settings"}
            onOpenChange={(open) => {
              if (!open) onNavigate?.("chat");
            }}
          >
            <DialogContent
              className="h-[min(760px,calc(100vh-48px))] w-[min(1040px,calc(100vw-48px))] max-w-none overflow-hidden p-0 sm:max-w-none"
              showCloseButton={false}
            >
              <DialogTitle className="sr-only">设置</DialogTitle>
              <DialogDescription className="sr-only">
                配置本地模型、Agent、工具、MCP 与语音功能。
              </DialogDescription>
              {settingsContent}
            </DialogContent>
          </Dialog>
        </section>
      </div>
    </main>
  );
}
