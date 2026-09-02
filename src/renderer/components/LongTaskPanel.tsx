import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CirclePause,
  CirclePlay,
  ListTodo,
  Plus,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import type {
  ChatToolCall,
  LongTask,
  LongTaskCreateInput,
  LongTaskEvent,
} from "../../shared/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface LongTaskPanelProps {
  onClose: () => void;
}

interface PendingApproval {
  requestId: string;
  stepId: string;
  call: ChatToolCall;
}

type LiveOutputByTaskAndStep = Record<string, Record<string, string>>;

const TERMINAL_STATUSES = new Set<LongTask["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

const RUNNING_STATUSES = new Set<LongTask["status"]>([
  "queued",
  "running",
  "waiting-approval",
]);

const STARTABLE_STATUSES = new Set<LongTask["status"]>([
  "draft",
  "paused",
  "interrupted",
]);

const STATUS_LABELS: Record<LongTask["status"], string> = {
  draft: "草稿",
  queued: "排队中",
  running: "执行中",
  "waiting-approval": "等待确认",
  paused: "已暂停",
  interrupted: "已中断",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function normalizedSteps(value: string): LongTaskCreateInput["steps"] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 24)
    .map((line, index) => {
      const [candidateTitle, ...rest] = line.split(/[:：]/u);
      const instruction = rest.join("：").trim() || line;
      const title = rest.length ? candidateTitle.trim() : `步骤 ${index + 1}`;
      return { title: title.slice(0, 120), instruction: instruction.slice(0, 4_000) };
    });
}

function upsertTask(tasks: LongTask[], task: LongTask): LongTask[] {
  return [task, ...tasks.filter((item) => item.id !== task.id)]
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function reconcileLiveOutput(
  current: LiveOutputByTaskAndStep,
  task: LongTask,
): LiveOutputByTaskAndStep {
  const taskOutput = current[task.id];
  if (!taskOutput) return current;
  if (TERMINAL_STATUSES.has(task.status)) {
    const next = { ...current };
    delete next[task.id];
    return next;
  }
  const runningStepId = task.steps.find((step) => step.status === "running")?.id;
  const runningOutput = runningStepId ? taskOutput[runningStepId] : undefined;
  if (!runningStepId || runningOutput === undefined) {
    const next = { ...current };
    delete next[task.id];
    return next;
  }
  if (Object.keys(taskOutput).length === 1) return current;
  return {
    ...current,
    [task.id]: { [runningStepId]: runningOutput },
  };
}

export function LongTaskPanel({ onClose }: LongTaskPanelProps) {
  const [tasks, setTasks] = useState<LongTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [stepDraft, setStepDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, PendingApproval>>({});
  const [liveOutput, setLiveOutput] = useState<LiveOutputByTaskAndStep>({});

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? tasks[0],
    [selectedId, tasks],
  );
  const approval = selectedTask ? pendingApprovals[selectedTask.id] : undefined;

  useEffect(() => {
    let active = true;
    void window.desktopPet.listLongTasks().then((items) => {
      if (!active) return;
      setTasks(items);
      setSelectedId((current) => current ?? items[0]?.id ?? null);
      setPendingApprovals(Object.fromEntries(
        items.flatMap((task) => task.pendingApproval
          ? [[task.id, task.pendingApproval] as const]
          : []),
      ));
    }).catch((listError) => {
      if (active) setError(listError instanceof Error ? listError.message : String(listError));
    });

    const unsubscribe = window.desktopPet.onLongTaskEvent((event: LongTaskEvent) => {
      if (!active) return;
      if (event.type === "task-updated") {
        setTasks((current) => upsertTask(current, event.task));
        setSelectedId((current) => current ?? event.task.id);
        setLiveOutput((current) => reconcileLiveOutput(current, event.task));
        setPendingApprovals((current) => {
          const next = { ...current };
          if (event.task.pendingApproval) {
            next[event.task.id] = event.task.pendingApproval;
          } else if (event.task.status !== "waiting-approval") {
            delete next[event.task.id];
          }
          return next;
        });
        return;
      }
      if (event.type === "task-deleted") {
        setTasks((current) => current.filter((task) => task.id !== event.taskId));
        setSelectedId((current) => current === event.taskId ? null : current);
        setLiveOutput((current) => {
          if (!current[event.taskId]) return current;
          const next = { ...current };
          delete next[event.taskId];
          return next;
        });
        return;
      }
      const chatEvent = event.event;
      if (chatEvent.type === "delta") {
        const text = chatEvent.text;
        setLiveOutput((current) => ({
          ...current,
          [event.taskId]: {
            ...current[event.taskId],
            [event.stepId]: `${current[event.taskId]?.[event.stepId] ?? ""}${text}`.slice(-12_000),
          },
        }));
      }
      if (chatEvent.type === "tool-call" && chatEvent.call.status === "pending-approval") {
        const call = chatEvent.call;
        setPendingApprovals((current) => ({
          ...current,
          [event.taskId]: {
            requestId: chatEvent.requestId,
            stepId: event.stepId,
            call,
          },
        }));
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const createTask = async () => {
    const steps = normalizedSteps(stepDraft);
    if (!title.trim() || !objective.trim() || !steps.length || creating) {
      setError("请填写任务名称、目标，并至少提供一个执行步骤。每行可写“步骤名：具体指令”。");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const task = await window.desktopPet.createLongTask({
        title: title.trim(),
        objective: objective.trim(),
        steps,
      });
      setTasks((current) => upsertTask(current, task));
      setSelectedId(task.id);
      setTitle("");
      setObjective("");
      setStepDraft("");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setCreating(false);
    }
  };

  const mutateTask = async (
    task: LongTask,
    operation: "start" | "pause" | "cancel" | "delete",
  ) => {
    if (busyTaskId) return;
    setBusyTaskId(task.id);
    setError("");
    try {
      if (operation === "delete") {
        await window.desktopPet.deleteLongTask(task.id);
        setTasks((current) => current.filter((item) => item.id !== task.id));
        setSelectedId(null);
        setLiveOutput((current) => {
          if (!current[task.id]) return current;
          const next = { ...current };
          delete next[task.id];
          return next;
        });
        return;
      }
      const updated = operation === "start"
        ? await window.desktopPet.startLongTask(task.id)
        : operation === "pause"
          ? await window.desktopPet.pauseLongTask(task.id)
          : await window.desktopPet.cancelLongTask(task.id);
      setTasks((current) => upsertTask(current, updated));
      setLiveOutput((current) => reconcileLiveOutput(current, updated));
    } catch (taskError) {
      setError(taskError instanceof Error ? taskError.message : String(taskError));
    } finally {
      setBusyTaskId(null);
    }
  };

  const resolveApproval = (approved: boolean) => {
    if (!selectedTask || !approval) return;
    window.desktopPet.resolveLongTaskApproval(
      selectedTask.id,
      approval.requestId,
      approval.call.id,
      approved,
    );
    setPendingApprovals((current) => {
      const next = { ...current };
      delete next[selectedTask.id];
      return next;
    });
  };

  const completedSteps = selectedTask?.steps.filter((step) => step.status === "completed").length ?? 0;
  const progress = selectedTask?.steps.length
    ? Math.round((completedSteps / selectedTask.steps.length) * 100)
    : 0;

  return (
    <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-16 shrink-0 items-center justify-between border-b bg-card px-6">
        <div>
          <p className="text-xs font-medium tracking-[0.16em] text-muted-foreground">DURABLE TASKS</p>
          <h1 className="text-lg font-semibold">长期任务</h1>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭长期任务">
          <XCircle />
        </Button>
      </header>

      {error ? (
        <Alert className="m-4 mb-0" variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,0.36fr)_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r bg-sidebar/45">
          <ScrollArea className="min-h-0 flex-1">
            <div className="grid gap-2 p-3">
              {tasks.length ? tasks.map((task) => (
                <button
                  className={cn(
                    "grid min-w-0 gap-1 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent",
                    selectedTask?.id === task.id && "border-primary/60 bg-accent",
                  )}
                  key={task.id}
                  onClick={() => setSelectedId(task.id)}
                  type="button"
                >
                  <span className="flex min-w-0 items-center justify-between gap-2">
                    <b className="truncate text-sm">{task.title}</b>
                    <Badge className="shrink-0" variant={task.status === "completed" ? "default" : "outline"}>
                      {STATUS_LABELS[task.status]}
                    </Badge>
                  </span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">{task.objective}</span>
                </button>
              )) : (
                <div className="grid place-items-center gap-2 p-8 text-center text-sm text-muted-foreground">
                  <ListTodo className="size-6" />
                  暂无长期任务
                </div>
              )}
            </div>
          </ScrollArea>
          <Separator />
          <form className="grid gap-3 p-4" onSubmit={(event) => { event.preventDefault(); void createTask(); }}>
            <div className="grid gap-1.5">
              <Label htmlFor="long-task-title">任务名称</Label>
              <Input id="long-task-title" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：整理项目发布说明" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="long-task-objective">最终目标</Label>
              <Textarea id="long-task-objective" className="min-h-20" maxLength={4_000} value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="说明完成标准、边界和需要保留的结果" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="long-task-steps">执行步骤（每行一个）</Label>
              <Textarea id="long-task-steps" className="min-h-24" maxLength={12_000} value={stepDraft} onChange={(event) => setStepDraft(event.target.value)} placeholder={"收集资料：检索本地项目文档\n生成草稿：按现有风格撰写\n验证结果：检查遗漏并给出总结"} />
            </div>
            <Button disabled={creating} type="submit"><Plus />{creating ? "创建中…" : "创建任务草稿"}</Button>
          </form>
        </aside>

        <section className="min-h-0 overflow-hidden">
          {selectedTask ? (
            <ScrollArea className="h-full">
              <div className="mx-auto grid max-w-4xl gap-5 p-6">
                <div className="grid gap-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h2 className="text-xl font-semibold">{selectedTask.title}</h2>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{selectedTask.objective}</p>
                    </div>
                    <Badge variant={selectedTask.status === "completed" ? "default" : "outline"}>
                      {STATUS_LABELS[selectedTask.status]}
                    </Badge>
                  </div>
                  <Progress aria-label="长期任务进度" value={progress} />
                  <div className="flex flex-wrap gap-2">
                    {STARTABLE_STATUSES.has(selectedTask.status) ? (
                      <Button disabled={busyTaskId === selectedTask.id} type="button" onClick={() => void mutateTask(selectedTask, "start")}>
                        <CirclePlay />{selectedTask.status === "draft" ? "开始任务" : "继续任务"}
                      </Button>
                    ) : null}
                    {RUNNING_STATUSES.has(selectedTask.status) ? (
                      <Button disabled={busyTaskId === selectedTask.id} type="button" variant="outline" onClick={() => void mutateTask(selectedTask, "pause")}>
                        <CirclePause />暂停
                      </Button>
                    ) : null}
                    {!TERMINAL_STATUSES.has(selectedTask.status) && selectedTask.status !== "draft" ? (
                      <Button disabled={busyTaskId === selectedTask.id} type="button" variant="outline" onClick={() => void mutateTask(selectedTask, "cancel")}>
                        <XCircle />取消任务
                      </Button>
                    ) : null}
                    {(TERMINAL_STATUSES.has(selectedTask.status) || selectedTask.status === "draft") ? (
                      <Button disabled={busyTaskId === selectedTask.id} type="button" variant="destructive" onClick={() => void mutateTask(selectedTask, "delete")}>
                        <Trash2 />删除
                      </Button>
                    ) : null}
                  </div>
                </div>

                {approval ? (
                  <Alert>
                    <ShieldCheck className="size-4" />
                    <AlertDescription className="grid gap-3">
                      <div>
                        <b className="block">工具需要你的确认：{approval.call.displayName}</b>
                        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{approval.call.arguments}</pre>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" type="button" onClick={() => resolveApproval(true)}>允许一次</Button>
                        <Button size="sm" type="button" variant="outline" onClick={() => resolveApproval(false)}>拒绝</Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                ) : null}

                <div className="grid gap-3">
                  {selectedTask.steps.map((step) => {
                    const streamedOutput = step.status === "running"
                      ? liveOutput[selectedTask.id]?.[step.id]
                      : undefined;
                    const visibleOutput = step.error ?? streamedOutput ?? step.output;
                    return (
                      <Card key={step.id} className={cn("gap-3 py-4", step.status === "running" && "border-primary/55")}>
                        <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-4">
                          {step.status === "completed" ? <CheckCircle2 className="mt-0.5 size-5 text-primary" /> : <ListTodo className="mt-0.5 size-5 text-muted-foreground" />}
                          <div className="min-w-0">
                            <CardTitle className="text-sm">{step.position + 1}. {step.title}</CardTitle>
                            <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{step.instruction}</p>
                          </div>
                          <Badge variant="outline">{step.status}</Badge>
                        </CardHeader>
                        {visibleOutput ? (
                          <CardContent className="px-4">
                            <pre className={cn("max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/60 p-3 text-xs leading-relaxed", step.error && "text-destructive")}>
                              {visibleOutput}
                            </pre>
                          </CardContent>
                        ) : null}
                      </Card>
                    );
                  })}
                </div>
              </div>
            </ScrollArea>
          ) : (
            <div className="grid h-full place-items-center text-center text-muted-foreground">
              <div className="grid gap-2"><ListTodo className="mx-auto size-8" /><p>创建或选择一个长期任务</p></div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
