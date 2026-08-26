import { memo, useState } from "react";
import type { LanguageModelUsage } from "ai";
import { BrainCircuit, ChevronDown } from "lucide-react";
import type {
  ChatContextUsage,
  RuntimeState,
  ThinkingEffort,
} from "../../shared/types";
import { thinkingBudgetLimitForDisplay } from "../../shared/thinking-effort";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentHeader,
  ContextTrigger,
} from "./ai-elements/context";
import {
  PromptInputButton,
} from "./ai-elements/prompt-input";

const THINKING_EFFORTS: Array<{ value: ThinkingEffort; label: string }> = [
  { value: "minimal", label: "极简" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
  { value: "max", label: "最大" },
];

type ReasoningMode = "off" | ThinkingEffort;

export const ModelReasoningControl = memo(function ModelReasoningControl({
  onChange,
  maxTokens,
  modelLabel,
  runtime,
}: {
  onChange: (thinking: boolean, effort: ThinkingEffort) => void;
  maxTokens: number;
  modelLabel: string;
  runtime: RuntimeState;
}) {
  const [effort, setEffort] = useState<ThinkingEffort>("medium");
  const [mode, setMode] = useState<ReasoningMode>("off");
  const selectedLabel = mode === "off"
    ? "关闭"
    : THINKING_EFFORTS.find((option) => option.value === mode)?.label ?? "关闭";
  const runtimeTone = runtime.phase === "ready"
    ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.12)]"
    : runtime.phase === "error"
      ? "bg-destructive"
      : "animate-pulse bg-amber-500";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PromptInputButton
          aria-label={`模型 ${modelLabel}，推理${selectedLabel}`}
          className="h-8 min-w-0 max-w-[min(18rem,34vw)] gap-1.5 px-2"
          size="sm"
          tooltip={`${runtime.message}；点击调整推理强度`}
          variant={mode === "off" ? "ghost" : "secondary"}
        >
          <i aria-hidden="true" className={`size-2 shrink-0 rounded-full ${runtimeTone}`} />
          <span className="truncate font-medium">{modelLabel}</span>
          <span className="shrink-0 text-muted-foreground">{selectedLabel}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </PromptInputButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="flex items-center gap-2">
          <BrainCircuit className="size-4 text-primary" />
          推理强度
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) => {
            const nextMode = value as ReasoningMode;
            setMode(nextMode);
            if (nextMode === "off") {
              onChange(false, effort);
              return;
            }
            setEffort(nextMode);
            onChange(true, nextMode);
          }}
        >
          <DropdownMenuRadioItem value="off">
            <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
              <span>关闭推理</span>
              <small className="text-muted-foreground">默认</small>
            </span>
          </DropdownMenuRadioItem>
          {THINKING_EFFORTS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                <span>{option.label}推理</span>
                <small className="text-muted-foreground">
                  {option.value === "max" ? "总输出" : "预算"} ≤{" "}
                  {thinkingBudgetLimitForDisplay(option.value, maxTokens).toLocaleString("en-US")}
                </small>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

export const ContextUsageIndicator = memo(function ContextUsageIndicator({
  usage,
  contextSize,
}: {
  usage?: ChatContextUsage;
  contextSize: number;
}) {
  const usedTokens = usage?.totalTokens ?? 0;
  const remainingTokens = Math.max(0, contextSize - usedTokens);
  const remainingPercentage = contextSize > 0 ? remainingTokens / contextSize * 100 : 0;
  const label = usage
    ? `剩余上下文 ${remainingTokens.toLocaleString("en-US")} / ${contextSize.toLocaleString("en-US")} token，${Math.round(remainingPercentage)}% 可用`
    : `上下文上限 ${contextSize.toLocaleString("en-US")} token，完成一次回答后显示用量`;
  const modelUsage: LanguageModelUsage | undefined = usage
    ? {
        inputTokens: usage.promptTokens,
        inputTokenDetails: {
          noCacheTokens: usage.promptTokens,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: usage.completionTokens,
        outputTokenDetails: {
          textTokens: usage.completionTokens,
          reasoningTokens: undefined,
        },
        totalTokens: usage.totalTokens,
      }
    : undefined;

  return (
    <Context maxTokens={contextSize} usage={modelUsage} usedTokens={usedTokens}>
      <ContextTrigger aria-label={label} className="h-7 px-2 text-xs" />
      <ContextContent align="end">
        <ContextContentHeader>
          <div className="flex items-center justify-between text-xs">
            <b>上下文用量</b>
            <span className="font-mono text-muted-foreground">
              {usedTokens.toLocaleString("en-US")} / {contextSize.toLocaleString("en-US")}
            </span>
          </div>
        </ContextContentHeader>
        <ContextContentBody className="space-y-2 text-xs">
          {usage ? (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">当前输入</span>
                <span>{usage.promptTokens.toLocaleString("en-US")} token</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">当前输出</span>
                <span>{usage.completionTokens.toLocaleString("en-US")} token</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">剩余</span>
                <span>{remainingTokens.toLocaleString("en-US")} token</span>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">完成一次回答后显示真实 token 用量。</p>
          )}
        </ContextContentBody>
      </ContextContent>
    </Context>
  );
});
