import type { DynamicToolUIPart } from "ai";
import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type {
  ChatDocument,
  ChatImage,
  ChatMessage,
  RuntimeState,
  TtsState,
} from "../../shared/types";
import {
  desktopUIMessageToChatMessage,
  readDesktopToolMetadata,
  type DesktopUIMessage,
} from "../chat/desktop-ui-message";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  Attachments,
  type AttachmentData,
} from "./ai-elements/attachments";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "./ai-elements/confirmation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "./ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "./ai-elements/reasoning";
import { Shimmer } from "./ai-elements/shimmer";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "./ai-elements/tool";
import { PixelIcon } from "./PixelIcon";

interface ChatMessageViewProps {
  message: DesktopUIMessage;
  isLast: boolean;
  activeRequestId?: string;
  runtime: RuntimeState;
  tts: TtsState;
  conversationOperationPending: boolean;
  onApproval: (
    requestId: string,
    toolCallId: string,
    approved: boolean,
  ) => void;
  onContinue: (message: ChatMessage) => void;
  onCopy: (message: ChatMessage) => Promise<void>;
  onRegenerate: () => void;
  onSpeakText: (text: string) => Promise<void>;
  onStopSpeaking: () => Promise<void>;
}

function imageAttachment(image: ChatImage, index: number): AttachmentData {
  return {
    id: `image-${index}-${image.path}`,
    type: "file",
    mediaType: image.mimeType,
    filename: image.name,
    // History intentionally omits the in-memory preview. An empty URL lets the
    // AI Elements attachment render its image icon instead of a broken <img>.
    url: image.previewUrl ?? "",
  };
}

function attachmentAccessibleName(attachment: AttachmentData): string {
  const filename =
    attachment.type === "source-document"
      ? attachment.title || attachment.filename
      : attachment.filename;
  return `附件：${filename || "未命名文件"}`;
}

function documentAttachment(
  document: ChatDocument,
  index: number,
): AttachmentData {
  return {
    id: `document-${index}-${document.path}`,
    type: "source-document",
    sourceId: document.path,
    mediaType: document.mimeType,
    title: document.name,
    filename: document.name,
  };
}

function MessageAttachments({
  images = [],
  documents = [],
}: {
  images?: ChatImage[];
  documents?: ChatDocument[];
}) {
  const attachments = [
    ...images.map(imageAttachment),
    ...documents.map(documentAttachment),
  ];

  if (!attachments.length) return null;

  return (
    <Attachments className="mb-1" variant="inline">
      {attachments.map((attachment) => (
        <Attachment
          aria-label={attachmentAccessibleName(attachment)}
          data={attachment}
          key={attachment.id}
          role="group"
        >
          <AttachmentPreview />
          <AttachmentInfo />
        </Attachment>
      ))}
    </Attachments>
  );
}

function AgentToolCall({
  part,
  requestId,
  onApproval,
}: {
  part: DynamicToolUIPart;
  requestId?: string;
  onApproval: ChatMessageViewProps["onApproval"];
}) {
  const metadata = readDesktopToolMetadata(part);
  const requiresAttention =
    part.state === "approval-requested" || part.state === "output-error";
  const [open, setOpen] = useState(requiresAttention);
  const approval = "approval" in part ? part.approval : undefined;
  const output = part.state === "output-available" ? part.output : undefined;
  const errorText =
    part.state === "output-error"
      ? part.errorText
      : part.state === "output-denied"
        ? "已拒绝这次工具调用。"
        : undefined;

  useEffect(() => {
    if (requiresAttention) setOpen(true);
  }, [requiresAttention]);

  return (
    <Tool onOpenChange={setOpen} open={open}>
      <ToolHeader
        state={part.state}
        title={metadata.displayName}
        toolName={part.toolName}
        type="dynamic-tool"
      />
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput errorText={errorText} output={output} />
        {part.state === "approval-requested" ? (
          <Confirmation approval={approval} state={part.state}>
            <ConfirmationRequest>
              <ConfirmationTitle>
                此工具会访问本机或外部服务，是否允许本次调用？
              </ConfirmationTitle>
              <ConfirmationActions>
                <ConfirmationAction
                  disabled={!requestId}
                  onClick={() =>
                    requestId && onApproval(requestId, part.toolCallId, false)
                  }
                  variant="outline"
                >
                  拒绝
                </ConfirmationAction>
                <ConfirmationAction
                  disabled={!requestId}
                  onClick={() =>
                    requestId && onApproval(requestId, part.toolCallId, true)
                  }
                >
                  允许本次调用
                </ConfirmationAction>
              </ConfirmationActions>
            </ConfirmationRequest>
          </Confirmation>
        ) : null}
      </ToolContent>
    </Tool>
  );
}

export function ChatMessageView({
  message,
  isLast,
  activeRequestId,
  runtime,
  tts,
  conversationOperationPending,
  onApproval,
  onContinue,
  onCopy,
  onRegenerate,
  onSpeakText,
  onStopSpeaking,
}: ChatMessageViewProps) {
  const isStreaming = Boolean(activeRequestId);
  const canRetry = isLast && !activeRequestId;
  const messageSnapshot = useMemo(
    () => desktopUIMessageToChatMessage(message, 0),
    [message],
  );
  const finalMeaningfulPart = [...message.parts]
    .reverse()
    .find(
      (part) =>
        part.type === "data-image-attachment" ||
        part.type === "data-document-attachment" ||
        part.type === "reasoning" ||
        part.type === "dynamic-tool" ||
        part.type === "text",
    );
  const hasRenderablePart = Boolean(finalMeaningfulPart);
  const waitingForAssistant =
    message.role === "assistant" && isStreaming && !hasRenderablePart;

  return (
    <Message data-message-id={message.id} from={message.role}>
      <MessageContent
        className={cn(
          waitingForAssistant &&
            "relative min-w-36 border-primary/25 bg-accent/30 py-4 shadow-[inset_0_1px_0_var(--ui-control-highlight),0_8px_24px_rgba(74,48,30,0.08)]",
        )}
        data-loading={waitingForAssistant}
      >
        {message.parts.map((part, index) => {
          const key = `${part.type}-${"id" in part ? part.id : index}`;
          switch (part.type) {
            case "data-image-attachment":
              return <MessageAttachments images={[part.data]} key={key} />;
            case "data-document-attachment":
              return <MessageAttachments documents={[part.data]} key={key} />;
            case "reasoning":
              return (
                <Reasoning
                  isStreaming={
                    message.role === "assistant" &&
                    isStreaming &&
                    part === finalMeaningfulPart
                  }
                  key={key}
                >
                  <ReasoningTrigger
                    getThinkingMessage={(streaming) =>
                      streaming ? "正在思考…" : "查看思考过程"
                    }
                  />
                  <ReasoningContent>{part.text}</ReasoningContent>
                </Reasoning>
              );
            case "dynamic-tool":
              return (
                <AgentToolCall
                  key={key}
                  onApproval={onApproval}
                  part={part}
                  requestId={activeRequestId}
                />
              );
            case "text":
              if (!part.text) return null;
              return message.role === "assistant" ? (
                <MessageResponse
                  isAnimating={isStreaming && part === finalMeaningfulPart}
                  key={key}
                >
                  {part.text}
                </MessageResponse>
              ) : (
                <p className="whitespace-pre-wrap" key={key}>
                  {part.text}
                </p>
              );
            case "data-tool-result":
            default:
              return null;
          }
        })}
        {waitingForAssistant ? (
          <div
            className="flex w-full items-center justify-center gap-2 py-0.5 text-center"
            role="status"
          >
            <span
              aria-hidden="true"
              className="grid size-6 shrink-0 place-items-center text-primary motion-safe:animate-spin motion-reduce:opacity-70 [animation-duration:1.25s]"
              data-slot="assistant-loading-icon"
            >
              <LoaderCircle className="size-4" />
            </span>
            <Shimmer
              baseColor="var(--ui-foreground)"
              className="text-sm font-medium"
              duration={1.8}
              highlightColor="var(--ui-primary)"
            >
              回答生成中…
            </Shimmer>
          </div>
        ) : message.role === "assistant" && !hasRenderablePart ? (
          <span className="py-1 text-sm text-muted-foreground">
            尚未生成内容
          </span>
        ) : null}
      </MessageContent>

      {message.role === "assistant" &&
      (messageSnapshot.content.trim() || canRetry) ? (
        <MessageActions>
          {messageSnapshot.content.trim() ? (
            <>
              <MessageAction
                label="复制这段回答"
                onClick={() => void onCopy(messageSnapshot)}
                tooltip="复制"
              >
                <PixelIcon name="copy" />
              </MessageAction>
              <MessageAction
                disabled={!tts.enabled}
                label={tts.phase === "speaking" ? "停止朗读" : "朗读这段回答"}
                onClick={() =>
                  void (tts.phase === "speaking"
                    ? onStopSpeaking()
                    : onSpeakText(messageSnapshot.content))
                }
                tooltip={
                  !tts.enabled
                    ? "请先在设置中启用语音朗读"
                    : tts.phase === "speaking"
                      ? "停止朗读"
                      : "朗读"
                }
              >
                <PixelIcon
                  name={tts.phase === "speaking" ? "stop" : "volume"}
                />
              </MessageAction>
            </>
          ) : null}
          {canRetry ? (
            <>
              {messageSnapshot.content.trim() ? (
                <MessageAction
                  disabled={
                    runtime.phase !== "ready" || conversationOperationPending
                  }
                  label="继续生成这段回答"
                  onClick={() => onContinue(messageSnapshot)}
                  tooltip="继续生成"
                >
                  <PixelIcon name="continue" />
                </MessageAction>
              ) : null}
              <MessageAction
                disabled={
                  runtime.phase !== "ready" || conversationOperationPending
                }
                label="重新生成回答"
                onClick={onRegenerate}
                tooltip="重新生成"
              >
                <PixelIcon name="refresh" />
              </MessageAction>
            </>
          ) : null}
        </MessageActions>
      ) : null}
    </Message>
  );
}
