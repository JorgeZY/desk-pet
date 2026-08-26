import { ipcMain } from "electron";
import type { ChatMessage, ChatRequest } from "../shared/types";
import type { ChatHistoryStore } from "./chat-history-store";
import type { LlamaRuntime } from "./llama-runtime";
import type { TtsRuntime } from "./tts-runtime";

export interface ChatIpcDependencies {
  runtime: LlamaRuntime;
  tts: TtsRuntime;
  getHistoryStore: () => ChatHistoryStore | null;
  isQuitting: () => boolean;
}

export function registerChatIpc(dependencies: ChatIpcDependencies): void {
  const history = (): ChatHistoryStore => {
    const store = dependencies.getHistoryStore();
    if (!store) throw new Error("本地聊天数据库不可用。");
    return store;
  };

  ipcMain.handle("chat-history:list", () => history().listConversations());
  ipcMain.handle("chat-history:create", () => history().createConversation());
  ipcMain.handle("chat-history:load", (_event, conversationId: string) =>
    history().loadMessages(conversationId));
  ipcMain.handle(
    "chat-history:save",
    (_event, conversationId: string, messages: ChatMessage[]) =>
      history().saveMessages(conversationId, messages),
  );
  ipcMain.handle("chat-history:delete", (_event, conversationId: string) => {
    history().deleteConversation(conversationId);
  });
  ipcMain.handle("chat-history:delete-many", (_event, conversationIds: string[]) => {
    if (!Array.isArray(conversationIds)) throw new Error("批量删除参数无效。");
    history().deleteConversations(conversationIds);
  });

  ipcMain.on("chat:start", (event, request: ChatRequest) => {
    if (dependencies.isQuitting()) {
      if (!event.sender.isDestroyed()) {
        event.sender.send("chat:event", {
          requestId: request.requestId,
          type: "error",
          message: "应用正在退出，未开始新的任务。",
        });
      }
      return;
    }
    dependencies.tts.onChatStart(request.requestId);
    void dependencies.runtime.streamChat(request, (chatEvent) => {
      dependencies.tts.onChatEvent(chatEvent);
      if (!event.sender.isDestroyed()) event.sender.send("chat:event", chatEvent);
    });
  });
  ipcMain.on("chat:abort", (_event, requestId: string) => {
    dependencies.runtime.abortChat(requestId);
    dependencies.tts.interrupt(requestId);
  });
  ipcMain.on(
    "chat:tool-approval",
    (_event, payload: { requestId: string; toolCallId: string; approved: boolean }) => {
      dependencies.runtime.resolveToolApproval(
        payload.requestId,
        payload.toolCallId,
        payload.approved === true,
      );
    },
  );
}
