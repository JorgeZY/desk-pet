import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AudioLines, BookOpen, Bot, CircleHelp, Cpu, FileText, Palette, Trash2, Upload, Wrench } from "lucide-react";
import { toast } from "sonner";
import type { ChatToolDefinition, EmbeddingState, KnowledgeDocumentSummary, RuntimeConfig, RuntimeState, SpeechState, TtsState } from "../../shared/types";
import type { ModelParameterKey } from "../../shared/model-parameters";
import { CHAT_TEMPLATE_COUNT, CHAT_TEMPLATE_MAX_LENGTH } from "../../shared/chat-templates";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PixelIcon } from "./PixelIcon";
import { RuntimeBadge } from "./RuntimeBadge";

interface SettingsProps {
  initialConfig: RuntimeConfig;
  runtime: RuntimeState;
  embedding: EmbeddingState;
  speech: SpeechState;
  tts: TtsState;
  onClose: () => void;
  onSave: (config: RuntimeConfig, restart: boolean) => Promise<void>;
  onPrepareEmbedding: (force?: boolean) => Promise<void>;
  onStopEmbedding: () => Promise<void>;
  onReindexKnowledge: () => Promise<void>;
  onPrepareSpeech: (force?: boolean) => Promise<void>;
  onImportSpeech: () => Promise<void>;
  onPrepareTts: (force?: boolean) => Promise<void>;
  onImportTts: () => Promise<void>;
  onSpeakText: (text: string) => Promise<void>;
  onStopSpeaking: () => Promise<void>;
  onOpenCaption: () => Promise<void>;
  embedded?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}

interface ParameterLabelProps {
  inputId: string;
  label: string;
  tooltip: string;
}

interface NumericTextInputProps {
  id: string;
  value: number;
  min: number;
  max: number;
  integer?: boolean;
  disabled?: boolean;
  onChange: (value: number) => void;
}

interface SettingsSectionProps {
  index: string;
  title: string;
  description: string;
  children: ReactNode;
}

type SettingsCategory = "model" | "agent" | "tools" | "knowledge" | "voice" | "appearance";

const settingsCategoryClassName = [
  "h-10 flex-none border-transparent px-3 py-2.5 transition-[box-shadow,background-color,border-color,color] duration-150 after:hidden",
  "hover:border-primary/30 hover:bg-sidebar-accent/65 hover:text-foreground",
  "hover:shadow-[inset_0_1px_0_var(--ui-control-highlight),0_1px_2px_var(--ui-control-shadow)]",
  "active:bg-sidebar-accent/80",
  "data-[state=active]:border-primary/55 data-[state=active]:bg-sidebar-accent",
  "data-[state=active]:font-semibold data-[state=active]:text-foreground",
  "data-[state=active]:shadow-[inset_0_1px_0_var(--ui-control-highlight),0_2px_0_var(--ui-control-shadow)]",
].join(" ");

export function normalizeNumericDraft(
  draft: string,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number {
  const parsed = draft.trim() === "" ? fallback : Number(draft);
  const finite = Number.isFinite(parsed) ? parsed : fallback;
  const normalized = integer ? Math.round(finite) : finite;
  return Math.min(max, Math.max(min, normalized));
}

function NumericTextInput({
  id,
  value,
  min,
  max,
  integer = false,
  disabled = false,
  onChange,
}: NumericTextInputProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const next = normalizeNumericDraft(draft, value, min, max, integer);
    setDraft(String(next));
    onChange(next);
  };

  return (
    <Input
      id={id}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      value={draft}
      disabled={disabled}
      onChange={(event) => {
        const nextDraft = event.target.value;
        setDraft(nextDraft);
        if (nextDraft.trim() === "") return;
        const parsed = Number(nextDraft);
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function ParameterLabel({ inputId, label, tooltip }: ParameterLabelProps) {
  return (
    <div className="parameter-label flex items-center gap-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <Tooltip delayDuration={120}>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="cursor-help rounded-full border border-transparent text-muted-foreground hover:border-primary/35 hover:bg-accent hover:text-foreground"
            aria-label={`${label}参数说明`}
            title={tooltip}
          >
            <CircleHelp />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8} className="z-[80] max-w-72 leading-relaxed shadow-lg">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function NumericField({
  id,
  label,
  tooltip,
  enabled,
  onEnabledChange,
  ...inputProps
}: NumericTextInputProps & Omit<ParameterLabelProps, "inputId"> & {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <ParameterLabel inputId={id} label={label} tooltip={tooltip} />
        <Switch
          aria-label={`自定义${label}`}
          checked={enabled}
          onCheckedChange={onEnabledChange}
        />
      </div>
      <NumericTextInput id={id} disabled={!enabled} {...inputProps} />
    </div>
  );
}

function SettingsSection({ index, title, description, children }: SettingsSectionProps) {
  return (
    <Card className="m-0 gap-4 border-border/80 py-5">
      <CardHeader className="grid-cols-[auto_1fr] gap-x-3 px-5">
        <Badge variant="secondary" className="row-span-2 mt-0.5 font-mono">{index}</Badge>
        <CardTitle><h2 className="text-sm">{title}</h2></CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 px-5">{children}</CardContent>
    </Card>
  );
}

function StatusProgress({ label, percent }: { label: string; percent?: number }) {
  return (
    <Progress
      value={percent}
      aria-label={label}
      className={percent === undefined ? "indeterminate" : undefined}
    />
  );
}

export function Settings({
  initialConfig,
  runtime,
  embedding,
  speech,
  tts,
  onClose,
  onSave,
  onPrepareEmbedding,
  onStopEmbedding,
  onReindexKnowledge,
  onPrepareSpeech,
  onImportSpeech,
  onPrepareTts,
  onImportTts,
  onSpeakText,
  onStopSpeaking,
  onOpenCaption,
  embedded = false,
  onDirtyChange,
}: SettingsProps) {
  const [config, setConfig] = useState(initialConfig);
  const [saveAction, setSaveAction] = useState<"save" | "restart" | null>(null);
  const [error, setError] = useState("");
  const [tools, setTools] = useState<ChatToolDefinition[]>([]);
  const [toolsStatus, setToolsStatus] = useState("正在读取当前工具…");
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<KnowledgeDocumentSummary[]>([]);
  const [knowledgeStatus, setKnowledgeStatus] = useState("尚未读取本地知识库。");
  const [knowledgeAction, setKnowledgeAction] = useState<"import" | string | null>(null);
  const [category, setCategory] = useState<SettingsCategory>("model");
  const [compactSidebar, setCompactSidebar] = useState(false);
  const embeddingConfigDirty = JSON.stringify(config.embedding)
    !== JSON.stringify(initialConfig.embedding);
  const saveInFlightRef = useRef(false);
  const toolRefreshIdRef = useRef(0);
  const listedToolIds = new Set(tools.map((tool) => tool.id));
  const displayedTools = [
    ...tools,
    ...config.toolSettings.disabledToolIds
      .filter((toolId) => !listedToolIds.has(toolId))
      .map((toolId): ChatToolDefinition => ({
        id: toolId,
        displayName: toolId,
        source: toolId === "search_local_knowledge"
          ? "knowledge"
          : toolId === "create_long_task" || toolId === "list_long_tasks" || toolId === "get_long_task"
            ? "task"
          : toolId.startsWith("mcp__") ? "mcp" : "builtin",
        requiresApproval: toolId.startsWith("mcp__"),
      })),
  ];

  const refreshRuntimeTools = useCallback(async (): Promise<void> => {
    const refreshId = ++toolRefreshIdRef.current;
    if (runtime.phase !== "ready") {
      setTools([]);
      setToolsStatus("启动模型后可查看 llama-server 当前公开的工具。");
      return;
    }
    setToolsStatus("正在读取当前工具…");
    try {
      const currentTools = await window.desktopPet.listRuntimeTools();
      if (toolRefreshIdRef.current !== refreshId) return;
      setTools(currentTools);
      setToolsStatus(currentTools.length ? "" : "当前 llama-server 没有公开可用工具。");
    } catch (toolError) {
      if (toolRefreshIdRef.current !== refreshId) return;
      setTools([]);
      setToolsStatus(`读取工具失败：${toolError instanceof Error ? toolError.message : String(toolError)}`);
    }
  }, [runtime.phase]);

  useEffect(() => {
    setConfig(initialConfig);
  }, [initialConfig]);

  useEffect(() => {
    onDirtyChange?.(JSON.stringify(config) !== JSON.stringify(initialConfig));
  }, [config, initialConfig, onDirtyChange]);

  useEffect(() => {
    let active = true;
    void window.desktopPet.getWorkbenchWindowState().then((state) => {
      if (active) setCompactSidebar(state.sidebarCollapsed);
    });
    const unsubscribe = window.desktopPet.onWorkbenchWindowState((state) => {
      if (active) setCompactSidebar(state.sidebarCollapsed);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    void refreshRuntimeTools();
    return () => {
      toolRefreshIdRef.current += 1;
    };
  }, [refreshRuntimeTools, runtime.updatedAt]);

  useEffect(() => {
    if (category !== "knowledge") return;
    let cancelled = false;
    setKnowledgeStatus("正在读取本地知识库…");
    void window.desktopPet.listKnowledgeDocuments().then((documents) => {
      if (cancelled) return;
      setKnowledgeDocuments(documents);
      setKnowledgeStatus(documents.length ? "" : "知识库为空，可导入文本或 PDF 文档。");
    }).catch((knowledgeError) => {
      if (cancelled) return;
      setKnowledgeDocuments([]);
      setKnowledgeStatus(`读取知识库失败：${knowledgeError instanceof Error ? knowledgeError.message : String(knowledgeError)}`);
    });
    return () => { cancelled = true; };
  }, [category]);

  const update = <K extends keyof RuntimeConfig>(key: K, value: RuntimeConfig[K]) =>
    setConfig((current) => ({ ...current, [key]: value }));

  const updateChatTemplate = (index: number, value: string) => {
    const chatTemplates = Array.from(
      { length: CHAT_TEMPLATE_COUNT },
      (_item, templateIndex) => config.chatTemplates[templateIndex] ?? "",
    );
    chatTemplates[index] = value;
    update("chatTemplates", chatTemplates);
  };

  const updateToolEnabled = (toolId: string, enabled: boolean) => {
    const disabledToolIds = new Set(config.toolSettings.disabledToolIds);
    if (enabled) disabledToolIds.delete(toolId);
    else disabledToolIds.add(toolId);
    update("toolSettings", {
      ...config.toolSettings,
      disabledToolIds: [...disabledToolIds],
    });
  };

  const updateModelParameterEnabled = (key: ModelParameterKey, enabled: boolean) => {
    update("modelParameterOverrides", {
      ...config.modelParameterOverrides,
      [key]: enabled,
    });
  };

  const pickModel = async () => {
    const result = await window.desktopPet.pickModel();
    if (result) update("modelPath", result.path);
  };

  const pickEmbeddingModel = async () => {
    const result = await window.desktopPet.pickEmbeddingModel();
    if (result) {
      update("embedding", {
        ...config.embedding,
        modelMode: "local",
        modelPath: result.path,
      });
    }
  };

  const pickMmproj = async () => {
    const result = await window.desktopPet.pickMmproj();
    if (result) update("mmprojPath", result.path);
  };

  const pickMcpServersConfig = async () => {
    setError("");
    try {
      const result = await window.desktopPet.pickMcpServersConfig();
      if (result) update("mcpServersConfigPath", result.path);
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : String(pickError));
    }
  };

  const importKnowledgeDocuments = async () => {
    if (knowledgeAction) return;
    setError("");
    setKnowledgeAction("import");
    try {
      const documents = await window.desktopPet.importKnowledgeDocuments();
      if (!documents) return;
      setKnowledgeDocuments(documents);
      setKnowledgeStatus(documents.length ? "" : "知识库为空，可导入文本或 PDF 文档。");
      toast.success("本地知识库已更新", {
        description: "新文档会从下一次 Agent 检索开始生效。",
      });
    } catch (knowledgeError) {
      setError(knowledgeError instanceof Error ? knowledgeError.message : String(knowledgeError));
    } finally {
      setKnowledgeAction(null);
    }
  };

  const deleteKnowledgeDocument = async (documentId: string) => {
    if (knowledgeAction) return;
    setError("");
    setKnowledgeAction(documentId);
    try {
      const documents = await window.desktopPet.deleteKnowledgeDocument(documentId);
      setKnowledgeDocuments(documents);
      setKnowledgeStatus(documents.length ? "" : "知识库为空，可导入文本或 PDF 文档。");
      toast.success("已从知识库移除文档", {
        description: "原始文件没有被删除。",
      });
    } catch (knowledgeError) {
      setError(knowledgeError instanceof Error ? knowledgeError.message : String(knowledgeError));
    } finally {
      setKnowledgeAction(null);
    }
  };

  const reindexKnowledge = async () => {
    if (knowledgeAction) return;
    setError("");
    setKnowledgeAction("reindex");
    try {
      await onReindexKnowledge();
      toast.success("向量索引已更新", {
        description: "知识库搜索将组合语义向量与关键词结果。",
      });
    } catch (knowledgeError) {
      setError(knowledgeError instanceof Error ? knowledgeError.message : String(knowledgeError));
    } finally {
      setKnowledgeAction(null);
    }
  };

  const save = async (restart: boolean) => {
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaveAction(restart ? "restart" : "save");
    setError("");
    try {
      await onSave(config, restart);
      if (!restart) void refreshRuntimeTools();
      toast.success(restart ? "设置已保存，本地模型已重启" : "设置已保存", {
        description: restart ? "新配置已经应用到当前 Agent。" : "需要时可继续保存并重启模型。",
      });
      if (restart) onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      saveInFlightRef.current = false;
      setSaveAction(null);
    }
  };

  return (
    <TooltipProvider delayDuration={120} skipDelayDuration={80}>
      <main className="flex h-full min-h-0 flex-col bg-background text-foreground" data-embedded={embedded}>
        <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-6 py-4">
          <div>
            <p className="mb-1 text-xs font-medium tracking-[0.16em] text-muted-foreground">PREFERENCES</p>
            <h1 className="m-0 text-xl font-semibold tracking-tight">desk-pet 设置</h1>
          </div>
          <div className="flex items-center gap-2">
            <RuntimeBadge runtime={runtime} />
            <Button variant="ghost" size="icon-sm" type="button" onClick={onClose} aria-label="关闭设置">
              <PixelIcon name="close" />
            </Button>
          </div>
        </header>

        <Tabs
          value={category}
          onValueChange={(value) => setCategory(value as SettingsCategory)}
          className="min-h-0 flex-1 gap-0 overflow-hidden"
          orientation="vertical"
        >
          <div className="grid h-full min-h-0 flex-1 grid-cols-[184px_minmax(0,1fr)] overflow-hidden">
            <TabsList
              variant="soft"
              className="h-full w-full self-stretch justify-start gap-1 rounded-none border-0 border-r border-border bg-sidebar p-3 shadow-none group-data-[orientation=vertical]/tabs:h-full"
              aria-label="设置分类"
            >
              <TabsTrigger className={settingsCategoryClassName} value="model">
                <Cpu />模型
              </TabsTrigger>
              <TabsTrigger className={settingsCategoryClassName} value="agent">
                <Bot />Agent
              </TabsTrigger>
              <TabsTrigger className={settingsCategoryClassName} value="tools">
                <Wrench />工具与 MCP
              </TabsTrigger>
              <TabsTrigger className={settingsCategoryClassName} value="knowledge">
                <BookOpen />知识库
              </TabsTrigger>
              <TabsTrigger className={settingsCategoryClassName} value="voice">
                <AudioLines />语音
              </TabsTrigger>
              <TabsTrigger className={settingsCategoryClassName} value="appearance">
                <Palette />外观
              </TabsTrigger>
            </TabsList>

            <ScrollArea className="min-h-0 min-w-0">
              <div className="p-5">
                <TabsContent value="model" className="grid gap-4">
                  <SettingsSection index="01" title="本地模型" description="选择当前 Agent 使用的端侧模型">
                    <RadioGroup
                      value={config.modelMode}
                      onValueChange={(value) => update("modelMode", value as RuntimeConfig["modelMode"])}
                      className="grid grid-cols-2 gap-3"
                      aria-label="模型来源"
                    >
                      <div className="flex items-start gap-3 rounded-lg border p-3 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-accent/50">
                        <RadioGroupItem id="settings-model-huggingface" value="huggingface" aria-label="自动下载" />
                        <Label htmlFor="settings-model-huggingface" className="grid flex-1 cursor-pointer gap-1"><b className="text-sm">自动下载</b><small className="font-normal text-muted-foreground">通过模型仓库获取 GGUF</small></Label>
                      </div>
                      <div className="flex items-start gap-3 rounded-lg border p-3 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-accent/50">
                        <RadioGroupItem id="settings-model-local" value="local" aria-label="本地 GGUF" />
                        <Label htmlFor="settings-model-local" className="grid flex-1 cursor-pointer gap-1"><b className="text-sm">本地 GGUF</b><small className="font-normal text-muted-foreground">选择已经下载的模型</small></Label>
                      </div>
                    </RadioGroup>

                    {config.modelMode === "huggingface" ? (
                      <div className="grid gap-2">
                        <Label htmlFor="settings-hf-repo">模型标识</Label>
                        <Input id="settings-hf-repo" value={config.hfRepo} onChange={(event) => update("hfRepo", event.target.value)} placeholder="owner/repo:quant" />
                        <p className="hint text-xs text-muted-foreground">仅在手工启动或保存并重启模型时下载；程序启动不会自动下载未缓存模型。</p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border bg-card p-3 [&>div:first-child]:grid [&>div:first-child]:min-w-0 [&>div:first-child]:gap-1 [&_span]:text-xs [&_span]:text-muted-foreground [&_strong]:truncate [&_strong]:text-sm">
                        <div><span>GGUF 文件</span><strong title={config.modelPath}>{config.modelPath || "尚未选择"}</strong></div>
                        <Button variant="outline" size="sm" type="button" onClick={pickModel}>选择</Button>
                      </div>
                    )}

                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border bg-card p-3 [&>div:first-child]:grid [&>div:first-child]:min-w-0 [&>div:first-child]:gap-1 [&_span]:text-xs [&_span]:text-muted-foreground [&_strong]:truncate [&_strong]:text-sm">
                      <div><span>视觉投影模型（可选）</span><strong title={config.mmprojPath}>{config.mmprojPath || "未启用视觉功能"}</strong></div>
                      <div className="flex flex-row items-center justify-end gap-2">
                        {config.mmprojPath && <Button variant="ghost" size="sm" type="button" onClick={() => update("mmprojPath", "")}>清除</Button>}
                        <Button variant="outline" size="sm" type="button" onClick={pickMmproj}>选择 mmproj</Button>
                      </div>
                    </div>
                    <p className="hint text-xs text-muted-foreground">选择与主模型匹配的 mmproj GGUF 后，重启模型即可在聊天中发送图片。</p>
                  </SettingsSection>

                  <SettingsSection index="02" title="模型参数" description="运行资源与采样设置">
                    <div className="grid grid-cols-3 gap-3">
                      <NumericField id="settings-context-size" label="上下文" tooltip="模型一次可参考的最大 token 数。禁用自定义后使用应用默认的 8192 token。" value={config.contextSize} min={512} max={131072} integer enabled={config.modelParameterOverrides.contextSize} onEnabledChange={(enabled) => updateModelParameterEnabled("contextSize", enabled)} onChange={(value) => update("contextSize", value)} />
                      <NumericField id="settings-gpu-layers" label="GPU 层数" tooltip="交给 GPU 计算的模型层数。禁用自定义后不向 llama-server 传入 GPU 层数。" value={config.gpuLayers} min={0} max={999} integer enabled={config.modelParameterOverrides.gpuLayers} onEnabledChange={(enabled) => updateModelParameterEnabled("gpuLayers", enabled)} onChange={(value) => update("gpuLayers", value)} />
                      <NumericField id="settings-threads" label="CPU 线程" tooltip="llama.cpp 推理使用的 CPU 线程数。禁用自定义后不传入线程数。" value={config.threads} min={1} max={256} integer enabled={config.modelParameterOverrides.threads} onEnabledChange={(enabled) => updateModelParameterEnabled("threads", enabled)} onChange={(value) => update("threads", value)} />
                      <NumericField id="settings-max-tokens" label="最大输出" tooltip="每次回答最多生成的 token 数。禁用自定义后使用应用默认的 512 token，以保留可靠的上下文预算。" value={config.maxTokens} min={32} max={8192} integer enabled={config.modelParameterOverrides.maxTokens} onEnabledChange={(enabled) => updateModelParameterEnabled("maxTokens", enabled)} onChange={(value) => update("maxTokens", value)} />
                      <NumericField id="settings-temperature" label="温度" tooltip="控制随机性。禁用自定义后不发送 temperature，使用 llama.cpp 默认值。" value={config.temperature} min={0} max={2} enabled={config.modelParameterOverrides.temperature} onEnabledChange={(enabled) => updateModelParameterEnabled("temperature", enabled)} onChange={(value) => update("temperature", value)} />
                      <NumericField id="settings-port" label="端口" tooltip="本地 llama.cpp 服务监听端口。禁用自定义后使用应用默认端口 18766。" value={config.port} min={1024} max={65535} integer enabled={config.modelParameterOverrides.port} onEnabledChange={(enabled) => updateModelParameterEnabled("port", enabled)} onChange={(value) => update("port", value)} />
                      <NumericField id="settings-top-k" label="Top K" tooltip="筛选概率最高的 K 个 token。禁用自定义后不发送 top_k。" value={config.topK} min={0} max={1000} integer enabled={config.modelParameterOverrides.topK} onEnabledChange={(enabled) => updateModelParameterEnabled("topK", enabled)} onChange={(value) => update("topK", value)} />
                      <NumericField id="settings-top-p" label="Top P" tooltip="按累计概率筛选候选 token。禁用自定义后不发送 top_p。" value={config.topP} min={0} max={1} enabled={config.modelParameterOverrides.topP} onEnabledChange={(enabled) => updateModelParameterEnabled("topP", enabled)} onChange={(value) => update("topP", value)} />
                      <NumericField id="settings-min-p" label="Min P" tooltip="过滤相对概率过低的 token。禁用自定义后不发送 min_p。" value={config.minP} min={0} max={1} enabled={config.modelParameterOverrides.minP} onEnabledChange={(enabled) => updateModelParameterEnabled("minP", enabled)} onChange={(value) => update("minP", value)} />
                      <NumericField id="settings-repeat-penalty" label="重复惩罚" tooltip="降低近期 token 再次出现的概率。禁用自定义后不发送 repeat_penalty。" value={config.repeatPenalty} min={0} max={2} enabled={config.modelParameterOverrides.repeatPenalty} onEnabledChange={(enabled) => updateModelParameterEnabled("repeatPenalty", enabled)} onChange={(value) => update("repeatPenalty", value)} />
                      <NumericField id="settings-presence-penalty" label="存在惩罚" tooltip="对已经出现过的 token 施加固定惩罚。禁用自定义后不发送 presence_penalty。" value={config.presencePenalty} min={-2} max={2} enabled={config.modelParameterOverrides.presencePenalty} onEnabledChange={(enabled) => updateModelParameterEnabled("presencePenalty", enabled)} onChange={(value) => update("presencePenalty", value)} />
                    </div>
                    <p className="hint text-xs text-muted-foreground">关闭某项“自定义”后，当前输入值会保留，重新启用即可继续使用；修改在保存并重启模型后生效。</p>
                  </SettingsSection>
                </TabsContent>

                <TabsContent value="agent" className="grid gap-4">
                  <SettingsSection index="01" title="Agent 行为" description="人格提示词与启动行为">
                    <div className="grid gap-2"><Label htmlFor="settings-system-prompt">系统提示词</Label><Textarea id="settings-system-prompt" rows={6} value={config.systemPrompt} onChange={(event) => update("systemPrompt", event.target.value)} /></div>
                    <div className="switch-row flex items-center justify-between gap-4 rounded-lg border p-3">
                      <Label htmlFor="settings-auto-start" className="grid gap-1"><b>自动启动模型</b><span className="text-xs font-normal text-muted-foreground">打开桌宠时准备本地模型</span></Label>
                      <Switch id="settings-auto-start" aria-label="自动启动模型" checked={config.autoStart} onCheckedChange={(checked) => update("autoStart", checked)} />
                    </div>
                  </SettingsSection>

                  <SettingsSection index="02" title="快捷模板" description="自定义聊天首页的一键填充内容">
                    <div className="chat-template-settings grid gap-3">
                      {Array.from({ length: CHAT_TEMPLATE_COUNT }, (_item, index) => (
                        <div className="grid gap-2" key={index}>
                          <Label htmlFor={`settings-template-${index}`}>模板 {index + 1}</Label>
                          <Input id={`settings-template-${index}`} type="text" maxLength={CHAT_TEMPLATE_MAX_LENGTH} value={config.chatTemplates[index] ?? ""} placeholder="留空即隐藏这条模板" onChange={(event) => updateChatTemplate(index, event.target.value)} />
                        </div>
                      ))}
                    </div>
                    <p className="hint text-xs text-muted-foreground">点击模板只会填入聊天输入框，不会自动发送。</p>
                  </SettingsSection>
                </TabsContent>

                <TabsContent value="tools" className="grid gap-4">
                  <SettingsSection index="01" title="工具与 MCP" description="查看 builtin tools，并通过 MCP 扩展">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="switch-row flex items-center justify-between gap-4 rounded-lg border p-3">
                        <Label htmlFor="settings-builtin-tools-enabled" className="grid gap-1">
                          <b>内置工具</b>
                          <span className="text-xs font-normal text-muted-foreground">允许模型使用 llama-server 工具</span>
                        </Label>
                        <Switch
                          id="settings-builtin-tools-enabled"
                          aria-label="启用内置工具"
                          checked={config.toolSettings.builtinEnabled}
                          onCheckedChange={(checked) => update("toolSettings", {
                            ...config.toolSettings,
                            builtinEnabled: checked,
                          })}
                        />
                      </div>
                      <div className="switch-row flex items-center justify-between gap-4 rounded-lg border p-3">
                        <Label htmlFor="settings-task-tools-enabled" className="grid gap-1">
                          <b>长期任务工具</b>
                          <span className="text-xs font-normal text-muted-foreground">允许 Agent 创建和读取任务草稿</span>
                        </Label>
                        <Switch
                          id="settings-task-tools-enabled"
                          aria-label="启用长期任务工具"
                          checked={config.toolSettings.tasksEnabled}
                          onCheckedChange={(checked) => update("toolSettings", {
                            ...config.toolSettings,
                            tasksEnabled: checked,
                          })}
                        />
                      </div>
                      <div className="switch-row flex items-center justify-between gap-4 rounded-lg border p-3">
                        <Label htmlFor="settings-mcp-tools-enabled" className="grid gap-1">
                          <b>MCP 工具</b>
                          <span className="text-xs font-normal text-muted-foreground">连接已配置的 MCP Servers</span>
                        </Label>
                        <Switch
                          id="settings-mcp-tools-enabled"
                          aria-label="启用 MCP 工具"
                          checked={config.toolSettings.mcpEnabled}
                          onCheckedChange={(checked) => update("toolSettings", {
                            ...config.toolSettings,
                            mcpEnabled: checked,
                          })}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border bg-card p-3 [&>div:first-child]:grid [&>div:first-child]:min-w-0 [&>div:first-child]:gap-1 [&_span]:text-xs [&_span]:text-muted-foreground [&_strong]:truncate [&_strong]:text-sm">
                      <div><span>MCP Servers 配置（可选）</span><strong title={config.mcpServersConfigPath}>{config.mcpServersConfigPath || "未添加自定义工具"}</strong></div>
                      <div className="flex flex-row items-center justify-end gap-2">
                        {config.mcpServersConfigPath && <Button variant="ghost" size="sm" type="button" onClick={() => update("mcpServersConfigPath", "")}>清除</Button>}
                        <Button variant="outline" size="sm" type="button" onClick={pickMcpServersConfig}>选择 JSON</Button>
                      </div>
                    </div>
                    <p className="hint text-xs leading-relaxed text-muted-foreground">工具启停在保存后生效，无需重启模型。仅选择可信的 Cursor 兼容 MCP 配置：启用 MCP 后，其中本地 command 会在下一次初始化工具时直接执行，后续工具调用才会逐次确认。支持 remote Streamable HTTP / SSE url（远程地址须为 HTTPS，本机 loopback 可用 HTTP；可附带 headers）。</p>
                    <div className="runtime-tool-viewport max-h-64 overflow-auto rounded-lg border bg-muted/25 p-2">
                      {displayedTools.length ? (
                        <ul className="runtime-tool-list grid gap-2" aria-label="当前工具列表">
                          {displayedTools.map((tool) => (
                            <li className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 rounded-md bg-card p-3" key={tool.id}>
                              <div className="min-w-0"><b className="block truncate text-sm">{tool.displayName}</b><code className="block truncate text-xs text-muted-foreground">{tool.id}</code></div>
                              <Badge variant="outline">{tool.source === "mcp" ? "MCP" : tool.source === "knowledge" ? "RAG" : tool.source === "task" ? "TASK" : "BUILTIN"}</Badge>
                              <span className="text-xs text-muted-foreground">{tool.requiresApproval ? "调用需确认" : "自动执行"}</span>
                              <Switch
                                aria-label={`启用工具 ${tool.displayName}`}
                                checked={!config.toolSettings.disabledToolIds.includes(tool.id)}
                                disabled={tool.source === "mcp"
                                  ? !config.toolSettings.mcpEnabled
                                  : tool.source === "knowledge"
                                    ? !config.toolSettings.knowledgeEnabled
                                    : tool.source === "task"
                                      ? !config.toolSettings.tasksEnabled
                                    : !config.toolSettings.builtinEnabled}
                                onCheckedChange={(checked) => updateToolEnabled(tool.id, checked)}
                              />
                            </li>
                          ))}
                        </ul>
                      ) : <p className="compact-result text-sm text-muted-foreground">{toolsStatus}</p>}
                    </div>
                  </SettingsSection>
                </TabsContent>

                <TabsContent value="knowledge" className="grid gap-4">
                  <SettingsSection index="01" title="专用向量模型" description="第二个 llama-server 只负责本地语义检索">
                    <div className="switch-row flex items-center justify-between gap-4 rounded-lg border p-3">
                      <Label htmlFor="settings-embedding-enabled" className="grid gap-1">
                        <b>启用混合向量检索</b>
                        <span className="text-xs font-normal text-muted-foreground">停用后保留已有向量，只使用 MiniSearch 关键词索引</span>
                      </Label>
                      <Switch
                        id="settings-embedding-enabled"
                        aria-label="启用专用向量模型"
                        checked={config.embedding.enabled}
                        onCheckedChange={(checked) => update("embedding", {
                          ...config.embedding,
                          enabled: checked,
                        })}
                      />
                    </div>

                    <RadioGroup
                      aria-label="Embedding 模型来源"
                      className="grid grid-cols-2 gap-3"
                      disabled={!config.embedding.enabled}
                      value={config.embedding.modelMode}
                      onValueChange={(value) => update("embedding", {
                        ...config.embedding,
                        modelMode: value === "local" ? "local" : "huggingface",
                      })}
                    >
                      <div className="flex items-center gap-3 rounded-lg border p-3">
                        <RadioGroupItem id="settings-embedding-managed" value="huggingface" />
                        <Label htmlFor="settings-embedding-managed" className="grid flex-1 cursor-pointer gap-1">
                          <b className="text-sm">官方 Qwen Q8</b>
                          <small className="font-normal text-muted-foreground">自动下载约 639 MB</small>
                        </Label>
                      </div>
                      <div className="flex items-center gap-3 rounded-lg border p-3">
                        <RadioGroupItem id="settings-embedding-local" value="local" />
                        <Label htmlFor="settings-embedding-local" className="grid flex-1 cursor-pointer gap-1">
                          <b className="text-sm">本地 GGUF</b>
                          <small className="font-normal text-muted-foreground">选择兼容 embedding 的模型</small>
                        </Label>
                      </div>
                    </RadioGroup>

                    {config.embedding.modelMode === "huggingface" ? (
                      <div className="grid gap-2">
                        <Label htmlFor="settings-embedding-repo">模型标识</Label>
                        <Input
                          id="settings-embedding-repo"
                          disabled={!config.embedding.enabled}
                          readOnly
                          value={config.embedding.hfRepo}
                        />
                      </div>
                    ) : (
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                        <Input
                          aria-label="Embedding GGUF 路径"
                          disabled={!config.embedding.enabled}
                          readOnly
                          value={config.embedding.modelPath}
                          placeholder="尚未选择专用 GGUF"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          disabled={!config.embedding.enabled}
                          onClick={() => void pickEmbeddingModel()}
                        >选择</Button>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-2">
                        <ParameterLabel inputId="settings-embedding-port" label="服务端口" tooltip="专用 embedding llama-server 的本机端口，不能与聊天模型相同。" />
                        <NumericTextInput id="settings-embedding-port" value={config.embedding.port} min={1024} max={65535} integer disabled={!config.embedding.enabled} onChange={(value) => update("embedding", { ...config.embedding, port: value })} />
                      </div>
                      <div className="grid gap-2">
                        <ParameterLabel inputId="settings-embedding-context" label="上下文" tooltip="单批知识片段可使用的 token 上限；默认 4096。" />
                        <NumericTextInput id="settings-embedding-context" value={config.embedding.contextSize} min={512} max={32768} integer disabled={!config.embedding.enabled} onChange={(value) => update("embedding", { ...config.embedding, contextSize: value })} />
                      </div>
                      <div className="grid gap-2">
                        <ParameterLabel inputId="settings-embedding-gpu" label="GPU 层数" tooltip="默认 0，避免第二个服务与聊天模型争抢显存。" />
                        <NumericTextInput id="settings-embedding-gpu" value={config.embedding.gpuLayers} min={0} max={999} integer disabled={!config.embedding.enabled} onChange={(value) => update("embedding", { ...config.embedding, gpuLayers: value })} />
                      </div>
                      <div className="grid gap-2">
                        <ParameterLabel inputId="settings-embedding-threads" label="CPU 线程" tooltip="专用向量服务使用的 CPU 线程数。" />
                        <NumericTextInput id="settings-embedding-threads" value={config.embedding.threads} min={1} max={256} integer disabled={!config.embedding.enabled} onChange={(value) => update("embedding", { ...config.embedding, threads: value })} />
                      </div>
                    </div>

                    <div className="grid gap-3 rounded-lg border bg-muted/25 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <b className="block text-sm">{embedding.message}</b>
                          <span className="block truncate text-xs text-muted-foreground" title={embedding.modelPath}>
                            {embedding.indexedChunkCount} 个向量已索引
                            {embedding.pendingChunkCount ? ` · ${embedding.pendingChunkCount} 个待处理` : ""}
                          </span>
                        </div>
                        <Badge variant={embedding.phase === "ready" ? "default" : "outline"}>
                          {embedding.phase}
                        </Badge>
                      </div>
                      {embedding.download ? <StatusProgress label="向量模型下载进度" percent={embedding.download.percent} /> : null}
                      <div className="flex flex-wrap gap-2">
                        {embedding.phase === "ready" ? (
                          <Button type="button" variant="outline" onClick={() => void onStopEmbedding()}>停止向量服务</Button>
                        ) : (
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={!config.embedding.enabled || embeddingConfigDirty || embedding.phase === "starting" || embedding.phase === "downloading" || embedding.phase === "stopping"}
                            onClick={() => void onPrepareEmbedding(false)}
                          >{embeddingConfigDirty ? "请先保存配置" : embedding.phase === "downloading" ? "下载中…" : "准备向量模型"}</Button>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          disabled={!config.embedding.enabled || embeddingConfigDirty || embedding.phase !== "ready" || knowledgeAction !== null}
                          onClick={() => void reindexKnowledge()}
                        >{knowledgeAction === "reindex" ? "重建中…" : "重建向量索引"}</Button>
                      </div>
                    </div>
                    <p className="hint text-xs leading-relaxed text-muted-foreground">官方 Qwen3-Embedding-0.6B-Q8 使用 last pooling 与 L2 归一化；服务按需启动，默认只用 CPU。模型文件仍保存在项目或应用旁的 models，不进入 userData。</p>
                  </SettingsSection>

                  <SettingsSection index="02" title="本地知识库" description="用检索代替把整份文档塞入上下文">
                    <div className="switch-row flex items-center justify-between gap-4 rounded-lg border p-3">
                      <Label htmlFor="settings-knowledge-enabled" className="grid gap-1">
                        <b>允许 Agent 检索知识库</b>
                        <span className="text-xs font-normal text-muted-foreground">只把相关片段加入当前工具结果，可单独停用</span>
                      </Label>
                      <Switch
                        id="settings-knowledge-enabled"
                        aria-label="启用本地知识库"
                        checked={config.toolSettings.knowledgeEnabled}
                        onCheckedChange={(checked) => update("toolSettings", {
                          ...config.toolSettings,
                          knowledgeEnabled: checked,
                        })}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <div className="grid gap-1">
                        <b className="text-sm">已索引文档</b>
                        <span className="text-xs text-muted-foreground">支持可提取文字的 PDF 与常见文本/代码文件</span>
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={knowledgeAction !== null}
                        onClick={() => void importKnowledgeDocuments()}
                      >
                        <Upload />{knowledgeAction === "import" ? "导入中…" : "导入文档"}
                      </Button>
                    </div>

                    <div className="max-h-80 overflow-auto rounded-lg border bg-muted/25 p-2">
                      {knowledgeDocuments.length ? (
                        <ul className="grid gap-2" aria-label="本地知识库文档">
                          {knowledgeDocuments.map((document) => (
                            <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md bg-card p-3" key={document.id}>
                              <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
                              <div className="min-w-0">
                                <b className="block truncate text-sm" title={document.path}>{document.name}</b>
                                <span className="block truncate text-xs text-muted-foreground">
                                  {document.mimeType === "application/pdf" ? "PDF" : "文本"}
                                  {" · "}{document.characterCount.toLocaleString()} 字符
                                  {" · "}{document.chunkCount} 个片段
                                </span>
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`移除知识库文档 ${document.name}`}
                                title="从索引移除（不会删除原文件）"
                                disabled={knowledgeAction !== null}
                                onClick={() => void deleteKnowledgeDocument(document.id)}
                              >
                                <Trash2 />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      ) : <p className="compact-result text-sm text-muted-foreground">{knowledgeStatus}</p>}
                    </div>
                    <p className="hint text-xs leading-relaxed text-muted-foreground">文档正文和索引保存在本机 SQLite 中；MiniSearch 只在内存中建立轻量中英文词法索引。每次检索最多返回少量有来源的片段，并继续受 8K–16K 精确上下文预算约束。扫描版 PDF 暂不支持 OCR；单文档上限为 400,000 字符。</p>
                  </SettingsSection>
                </TabsContent>

                <TabsContent value="voice" className="grid gap-4">
                  <SettingsSection index="01" title="本地语音" description="录音和识别均在本机完成">
                    <div className="switch-row flex items-center justify-between gap-4 rounded-lg border p-3">
                      <Label htmlFor="settings-speech-enabled" className="grid gap-1"><b>启用本地语音输入</b><span className="text-xs font-normal text-muted-foreground">同时启用聊天框麦克风与全局 F8 按住说话</span></Label>
                      <Switch id="settings-speech-enabled" aria-label="启用本地语音输入" checked={config.speech.enabled} onCheckedChange={(checked) => update("speech", { ...config.speech, enabled: checked })} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid min-w-0 gap-1 rounded-lg border p-3 [&>span]:text-xs [&>span]:text-muted-foreground [&>strong]:truncate [&>strong]:text-sm"><span>识别语言</span><strong>自动识别中、英、日、韩、粤语</strong></div>
                      <div className="grid min-w-0 gap-1 rounded-lg border p-3 [&>span]:text-xs [&>span]:text-muted-foreground [&>strong]:truncate [&>strong]:text-sm"><span>麦克风</span><strong title={speech.inputDevice}>{speech.inputDevice ?? "系统默认麦克风"}</strong></div>
                    </div>
                    <div className="grid min-w-0 gap-1 rounded-lg border p-3 [&>span]:text-xs [&>span]:text-muted-foreground [&>strong]:truncate [&>strong]:text-sm"><span>语音模型位置</span><strong title={speech.modelDirectory}>{speech.modelDirectory}</strong></div>
                    <Alert variant={speech.phase === "error" ? "destructive" : "default"}><AlertDescription>{speech.error ?? speech.message}{speech.progress?.percent !== undefined ? ` ${speech.progress.percent.toFixed(1)}%` : ""}</AlertDescription></Alert>
                    {speech.progress && <StatusProgress label="语音模型下载进度" percent={speech.progress.percent} />}
                    <div className="button-row flex flex-wrap gap-2">
                      <Button type="button" onClick={() => void onOpenCaption()}>打开实时字幕</Button>
                      <Button variant="secondary" type="button" onClick={() => void onImportSpeech()} disabled={speech.phase === "recording" || speech.phase === "transcribing" || speech.phase === "downloading" || speech.phase === "loading"}>使用本地模型</Button>
                      {speech.phase === "not-installed" || speech.phase === "error" ? <Button variant="outline" type="button" onClick={() => void onPrepareSpeech(false)}>自动下载</Button> : <Button variant="outline" type="button" onClick={() => void onPrepareSpeech(true)} disabled={speech.phase !== "ready"}>重新下载模型</Button>}
                    </div>
                  </SettingsSection>

                  <SettingsSection index="02" title="语音输出" description="回复由本地模型朗读，不出网">
                    <div className="switch-row flex items-center justify-between gap-4 rounded-lg border p-3">
                      <Label htmlFor="settings-tts-enabled" className="grid gap-1"><b>启用语音朗读</b><span className="text-xs font-normal text-muted-foreground">团子会用本地语音朗读聊天回复</span></Label>
                      <Switch id="settings-tts-enabled" aria-label="启用语音朗读" checked={config.tts.enabled} onCheckedChange={(checked) => update("tts", { ...config.tts, enabled: checked })} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-2"><ParameterLabel inputId="settings-tts-speed" label="语速" tooltip="TTS 合成语音的播放节奏。1 为模型默认速度，小于 1 更慢，大于 1 更快。" /><Input id="settings-tts-speed" type="number" min={0.5} max={2} step={0.1} value={config.tts.speed} onChange={(event) => update("tts", { ...config.tts, speed: Number(event.target.value) })} /></div>
                      <div className="grid gap-2"><ParameterLabel inputId="settings-tts-speaker" label="音色编号" tooltip="选择多音色 TTS 模型中的说话人编号。官方默认模型只有 0 号音色。" /><Input id="settings-tts-speaker" type="number" min={0} max={99} value={config.tts.speaker} onChange={(event) => update("tts", { ...config.tts, speaker: Math.round(Number(event.target.value)) })} /></div>
                    </div>
                    <p className="hint text-xs text-muted-foreground">官方语音朗读模型为单一音色，音色编号保持 0；导入多音色模型时可在此选择（超出范围会自动使用最后一个音色）。</p>
                    <div className="grid min-w-0 gap-1 rounded-lg border p-3 [&>span]:text-xs [&>span]:text-muted-foreground [&>strong]:truncate [&>strong]:text-sm"><span>语音朗读模型位置</span><strong title={tts.modelDirectory}>{tts.modelDirectory}</strong></div>
                    <Alert variant={tts.phase === "error" ? "destructive" : "default"}><AlertDescription>{tts.error ?? tts.message}{tts.progress?.percent !== undefined ? ` ${tts.progress.percent.toFixed(1)}%` : ""}</AlertDescription></Alert>
                    {tts.progress && <StatusProgress label="语音朗读模型下载进度" percent={tts.progress.percent} />}
                    <div className="button-row flex flex-wrap gap-2">
                      <Button variant="secondary" type="button" onClick={() => void onImportTts()} disabled={tts.phase === "downloading" || tts.phase === "loading"}>使用本地模型</Button>
                      {tts.phase === "not-installed" || tts.phase === "error" ? <Button variant="outline" type="button" onClick={() => void onPrepareTts(false)}>自动下载</Button> : <Button variant="outline" type="button" onClick={() => void onPrepareTts(true)} disabled={tts.phase !== "ready"}>重新下载模型</Button>}
                      <Button variant="secondary" type="button" disabled={!tts.enabled || (tts.phase !== "ready" && tts.phase !== "speaking")} onClick={() => void onSpeakText("你好，我是团子，很高兴见到你。")}>试听</Button>
                      <Button variant="ghost" type="button" disabled={tts.phase !== "speaking"} onClick={() => void onStopSpeaking()}>停止朗读</Button>
                    </div>
                  </SettingsSection>
                </TabsContent>

                <TabsContent value="appearance" className="grid gap-4">
                  <SettingsSection index="01" title="工作台外观" description="调整窗口内的布局密度">
                    <div className="switch-row flex items-center justify-between gap-4 rounded-lg border p-3">
                      <Label htmlFor="settings-compact-sidebar" className="grid gap-1">
                        <b>紧凑侧栏</b>
                        <span className="text-xs font-normal text-muted-foreground">
                          仅保留快捷图标；更改会立即应用并跨启动保存
                        </span>
                      </Label>
                      <Switch
                        id="settings-compact-sidebar"
                        aria-label="紧凑侧栏"
                        checked={compactSidebar}
                        onCheckedChange={(checked) => {
                          setCompactSidebar(checked);
                          void window.desktopPet.setSidebarCollapsed(checked).catch((stateError) => {
                            setCompactSidebar(!checked);
                            setError(stateError instanceof Error ? stateError.message : String(stateError));
                          });
                        }}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid min-w-0 gap-1 rounded-lg border p-3 [&>span]:text-xs [&>span]:text-muted-foreground [&>strong]:truncate [&>strong]:text-sm">
                        <span>窗口边框</span>
                        <strong>跟随 Windows 系统</strong>
                      </div>
                      <div className="grid min-w-0 gap-1 rounded-lg border p-3 [&>span]:text-xs [&>span]:text-muted-foreground [&>strong]:truncate [&>strong]:text-sm">
                        <span>界面主题</span>
                        <strong>暖色奶油</strong>
                      </div>
                    </div>
                    <p className="hint text-xs text-muted-foreground">
                      工作台支持系统缩放、拖动、最小化和最大化；pet 与实时字幕保留各自的专用外观。
                    </p>
                  </SettingsSection>
                </TabsContent>
              </div>
            </ScrollArea>
          </div>
        </Tabs>

        {error ? (
          <div className="grid shrink-0 gap-2 px-6 py-2">
            <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
          </div>
        ) : null}

        <footer className="settings__footer flex shrink-0 items-center justify-between border-t border-border bg-card px-6 py-3">
          <Button variant="outline" type="button" onClick={onClose}>取消</Button>
          <div className="button-row flex gap-2">
            <Button
              aria-busy={saveAction === "save"}
              aria-disabled={saveAction !== null}
              className={saveAction === "restart" ? "w-24 pointer-events-none" : "w-24"}
              disabled={saveAction === "save"}
              onClick={() => void save(false)}
              type="button"
              variant="secondary"
            >
              {saveAction === "save" ? "保存中…" : "仅保存"}
            </Button>
            <Button
              aria-busy={saveAction === "restart"}
              aria-disabled={saveAction !== null}
              className={saveAction === "save" ? "w-40 pointer-events-none" : "w-40"}
              disabled={saveAction === "restart"}
              onClick={() => void save(true)}
              type="button"
            >
              {saveAction === "restart" ? "保存并重启中…" : "保存并重启模型"}
            </Button>
          </div>
        </footer>
      </main>
    </TooltipProvider>
  );
}
