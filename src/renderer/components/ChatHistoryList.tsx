import { useRef } from "react";
import { Check, ListChecks, MoreHorizontal } from "lucide-react";
import type { ChatConversation } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PixelIcon } from "./PixelIcon";

export interface ChatHistoryListProps {
  conversations: ChatConversation[];
  conversationId: string | null;
  batchMode: boolean;
  selectedIds: Set<string>;
  busy: boolean;
  generationActive: boolean;
  pendingDeleteId?: string;
  onToggleBatch: () => void;
  onToggleSelection: (id: string) => void;
  onToggleSelectAll: () => void;
  onDeleteSelected: () => void;
  onSwitch: (id: string) => void;
  onRequestDelete: (
    conversation: ChatConversation,
    trigger?: HTMLButtonElement,
  ) => void;
}

interface ConversationHistoryItemProps {
  conversation: ChatConversation;
  active: boolean;
  selected: boolean;
  batchMode: boolean;
  disabled: boolean;
  deleteRequested: boolean;
  onToggleSelection: () => void;
  onSwitch: () => void;
  onRequestDelete: (trigger?: HTMLButtonElement) => void;
}

function ConversationHistoryItem({
  conversation,
  active,
  selected,
  batchMode,
  disabled,
  deleteRequested,
  onToggleSelection,
  onSwitch,
  onRequestDelete,
}: ConversationHistoryItemProps) {
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const titleViewportRef = useRef<HTMLSpanElement>(null);
  const titleTrackRef = useRef<HTMLElement>(null);

  const prepareTitleMarquee = () => {
    const viewport = titleViewportRef.current;
    const track = titleTrackRef.current;
    if (!viewport || !track) return;
    const overflow = Math.max(0, track.scrollWidth - viewport.clientWidth);
    viewport.style.setProperty("--conversation-title-overflow", `${overflow}px`);
    viewport.style.setProperty(
      "--conversation-title-duration",
      `${Math.max(3, overflow / 24).toFixed(2)}s`,
    );
    viewport.dataset.overflowing = overflow > 0 ? "true" : "false";
  };

  return (
    <div
      className={`group grid w-full min-w-0 max-w-full items-center gap-1 overflow-x-hidden rounded-lg px-1 py-0.5 transition-colors hover:bg-sidebar-accent/65 data-[active=true]:bg-sidebar-accent data-[selected=true]:bg-sidebar-accent data-[selected=true]:ring-1 data-[selected=true]:ring-primary/25 ${batchMode ? "grid-cols-[auto_minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)_auto]"}`}
      data-active={active}
      data-selected={selected}
      data-slot="conversation-history-item"
    >
      {batchMode ? (
        <Checkbox
          aria-label={`选择 ${conversation.title}`}
          checked={selected}
          className="ml-2 shrink-0"
          disabled={disabled}
          onCheckedChange={onToggleSelection}
        />
      ) : null}
      <Button
        className="h-auto min-w-0 w-full justify-start overflow-hidden px-2 py-2 text-left hover:bg-transparent active:bg-transparent"
        disabled={disabled}
        onClick={batchMode ? onToggleSelection : onSwitch}
        title={conversation.title}
        type="button"
        variant="ghost"
      >
        <span className="min-w-0 flex-1 overflow-hidden">
          <span
            ref={titleViewportRef}
            className="conversation-history-title-viewport block min-w-0 overflow-hidden"
            onPointerEnter={prepareTitleMarquee}
          >
            <b ref={titleTrackRef} className="conversation-history-title-track block w-max min-w-full whitespace-nowrap text-sm font-medium">{conversation.title}</b>
          </span>
          <small className="block truncate text-xs text-muted-foreground">
            {formatConversationTime(conversation.updatedAt)} · {conversation.messageCount} 条消息
          </small>
        </span>
      </Button>
      {!batchMode ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={menuTriggerRef}
              aria-label={`管理 ${conversation.title}`}
              className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[active=true]:opacity-100 data-[state=open]:opacity-100"
              data-active={deleteRequested}
              disabled={disabled}
              size="icon-sm"
              type="button"
              variant="soft"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => onRequestDelete(menuTriggerRef.current ?? undefined)}
              variant="destructive"
            >
              <PixelIcon name="trash" />
              删除对话
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

export function ChatHistoryList(props: ChatHistoryListProps) {
  const disabled = props.generationActive || props.busy;
  const allSelected = props.conversations.length > 0
    && props.selectedIds.size === props.conversations.length;

  return (
    <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-2 overflow-hidden">
      <div className="flex min-w-0 items-center justify-between px-2">
        <div className="min-w-0">
          <b className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            最近对话
          </b>
          <small className="block truncate text-[11px] text-muted-foreground">
            本地保存最近 30 个会话
          </small>
        </div>
        <Button
          className="shrink-0"
          disabled={disabled || props.conversations.length === 0}
          onClick={props.onToggleBatch}
          aria-label={props.batchMode ? "完成管理" : "管理对话"}
          size="icon-xs"
          type="button"
          variant="soft"
          title={props.batchMode ? "完成管理" : "管理对话"}
        >
          {props.batchMode ? <Check /> : <ListChecks />}
        </Button>
      </div>

      {props.batchMode ? (
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-sidebar-border bg-card px-2 py-1.5 text-xs shadow-sm">
          <Button
            className="hover:border-primary/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onClick={props.onToggleSelectAll}
            size="sm"
            type="button"
            variant={allSelected ? "secondary" : "outline"}
          >
            {allSelected ? <Check /> : <ListChecks />}
            {allSelected ? "取消全选" : "全选"}
          </Button>
          <span className="min-w-0 truncate whitespace-nowrap text-center text-muted-foreground">
            已选中 {props.selectedIds.size} 个
          </span>
          <Button
            aria-label={`删除已选中的 ${props.selectedIds.size} 个对话`}
            disabled={props.selectedIds.size === 0 || props.busy}
            onClick={props.onDeleteSelected}
            size="icon-sm"
            title="删除已选中的对话"
            type="button"
            variant="destructive"
          >
            <PixelIcon name="trash" />
          </Button>
        </div>
      ) : null}

      <ScrollArea className="min-h-0 min-w-0 w-full flex-1 overflow-hidden [&_[data-slot=scroll-area-viewport]]:overflow-x-hidden">
        <div className="w-full min-w-0 max-w-full space-y-1 overflow-x-hidden pr-2">
          {props.conversations.map((conversation) => (
            <ConversationHistoryItem
              active={conversation.id === props.conversationId}
              batchMode={props.batchMode}
              conversation={conversation}
              deleteRequested={conversation.id === props.pendingDeleteId}
              disabled={disabled}
              key={conversation.id}
              onRequestDelete={(trigger) => props.onRequestDelete(conversation, trigger)}
              onSwitch={() => props.onSwitch(conversation.id)}
              onToggleSelection={() => props.onToggleSelection(conversation.id)}
              selected={props.selectedIds.has(conversation.id)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function formatConversationTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
