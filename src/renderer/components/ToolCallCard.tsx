import type { ChatToolCall } from "../../shared/types";

interface ToolCallCardProps {
  call: ChatToolCall;
  requestId?: string;
  onApproval?: (requestId: string, toolCallId: string, approved: boolean) => void;
}

const STATUS_LABELS: Record<ChatToolCall["status"], string> = {
  "pending-approval": "等待授权",
  running: "执行中",
  completed: "已完成",
  denied: "已拒绝",
  error: "失败",
};

export function ToolCallCard({ call, requestId, onApproval }: ToolCallCardProps) {
  const canApprove = call.status === "pending-approval" && requestId && onApproval;
  return (
    <details className={`tool-call tool-call--${call.status}`} open={call.status === "pending-approval"}>
      <summary>
        <span>{call.displayName}</span>
        <small>{STATUS_LABELS[call.status]}</small>
      </summary>
      <div className="tool-call__body">
        <label>参数</label>
        <pre>{call.arguments || "{}"}</pre>
        {call.result ? (
          <>
            <label>结果</label>
            <pre>{call.result}</pre>
          </>
        ) : null}
        {call.error ? <p role="alert">{call.error}</p> : null}
        {canApprove ? (
          <div className="tool-call__actions">
            <button type="button" onClick={() => onApproval(requestId, call.id, false)}>拒绝</button>
            <button type="button" onClick={() => onApproval(requestId, call.id, true)}>允许本次</button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
