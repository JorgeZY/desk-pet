import { useMemo, useState } from "react";
import type { ProbeResult, RuntimeConfig } from "../../shared/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PixelIcon } from "./PixelIcon";

interface OnboardingProps {
  initialConfig: RuntimeConfig;
  platform: string;
  onComplete: (config: RuntimeConfig) => Promise<void>;
}

const STEP_TITLES = ["欢迎使用团子", "连接 llama.cpp", "选择端侧模型", "调整本地运行参数"];

export function Onboarding({ initialConfig, platform, onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState(initialConfig);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const canContinue = useMemo(() => {
    if (step === 1) return probe?.ok === true;
    if (step === 2 && config.modelMode === "local") return config.modelPath.endsWith(".gguf");
    return true;
  }, [config.modelMode, config.modelPath, probe?.ok, step]);

  const update = <K extends keyof RuntimeConfig>(key: K, value: RuntimeConfig[K]) =>
    setConfig((current) => ({ ...current, [key]: value }));

  const selectExecutable = async () => {
    const result = await window.desktopPet.pickExecutable();
    if (!result) return;
    update("executable", result.path);
    setProbe(null);
  };

  const testRuntime = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await window.desktopPet.probeRuntime(config.executable);
      setProbe(result);
      if (!result.ok) setError("没有找到可用的 llama.cpp。请先安装，或选择 llama/llama-server 可执行文件。");
    } catch (probeError) {
      setProbe(null);
      setError(probeError instanceof Error ? probeError.message : String(probeError));
    } finally {
      setBusy(false);
    }
  };

  const selectModel = async () => {
    const result = await window.desktopPet.pickModel();
    if (result) update("modelPath", result.path);
  };

  const next = async () => {
    setError("");
    if (step < 3) {
      setStep((value) => value + 1);
      return;
    }
    setBusy(true);
    try {
      await onComplete({ ...config, setupComplete: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setBusy(false);
    }
  };

  return (
    <main className="onboarding flex h-full w-full items-center justify-center bg-background p-6 text-foreground">
      <Card className="h-full max-h-[700px] w-full max-w-4xl gap-0 overflow-hidden py-0 shadow-lg">
        <CardHeader className="border-b px-7 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardDescription className="mb-1 text-xs font-medium tracking-[0.14em]">本地优先 · 四步完成配置</CardDescription>
              <CardTitle><h1 className="m-0 text-2xl tracking-tight">{STEP_TITLES[step]}</h1></CardTitle>
            </div>
            <Badge variant="secondary" className="font-mono">{step + 1} / 4</Badge>
          </div>
          <Progress value={(step + 1) * 25} aria-label={`第 ${step + 1} 步，共 4 步`} />
        </CardHeader>

        <CardContent className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
          {step === 0 && (
            <section className="mx-auto grid max-w-2xl gap-6" aria-labelledby="onboarding-welcome-title">
              <div className="grid gap-2 text-center">
                <h2 id="onboarding-welcome-title" className="text-xl font-semibold">一个真正运行在本机的 AI 助手</h2>
                <p className="text-sm leading-relaxed text-muted-foreground">日常对话只会发送到本机的 llama.cpp 服务，不需要 API Key。接下来会检查运行时、选择模型并设置基础参数。</p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Card className="gap-2 border-border/70 p-4 py-4 shadow-none"><CardTitle className="text-sm">任意 GGUF</CardTitle><CardDescription>按需切换 llama.cpp 支持的本地模型</CardDescription></Card>
                <Card className="gap-2 border-border/70 p-4 py-4 shadow-none"><CardTitle className="text-sm">端侧推理</CardTitle><CardDescription>支持 CPU、Vulkan 与 CUDA 运行</CardDescription></Card>
                <Card className="gap-2 border-border/70 p-4 py-4 shadow-none"><CardTitle className="text-sm">隐私优先</CardTitle><CardDescription>模型服务仅绑定到 127.0.0.1</CardDescription></Card>
              </div>
            </section>
          )}

          {step === 1 && (
            <section className="mx-auto grid max-w-2xl gap-5" aria-label="连接 llama.cpp">
              <Alert>
                <AlertTitle>准备运行时</AlertTitle>
                <AlertDescription>{platform === "win32" ? "Windows 推荐先在终端运行 winget install llama.cpp，然后点击检测。" : "请通过 llama.app 安装 llama.cpp，或选择已有的 llama-server。"}</AlertDescription>
              </Alert>
              <div className="grid gap-2">
                <Label htmlFor="onboarding-executable">可执行文件或命令</Label>
                <div className="flex gap-2">
                  <Input
                    id="onboarding-executable"
                    value={config.executable}
                    onChange={(event) => {
                      update("executable", event.target.value);
                      setProbe(null);
                    }}
                    placeholder="llama"
                  />
                  <Button variant="outline" type="button" onClick={selectExecutable}>选择</Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" type="button" onClick={() => void testRuntime()} disabled={busy}>{busy ? "检测中…" : "检测 llama.cpp"}</Button>
                <Button variant="ghost" type="button" onClick={() => window.desktopPet.openExternal("https://github.com/ggml-org/llama.cpp/releases")}>打开官方下载页 <PixelIcon name="open" /></Button>
              </div>
              {probe && (
                <Alert variant={probe.ok ? "default" : "destructive"}>
                  <AlertTitle>{probe.ok ? "运行时可用" : "检测失败"}</AlertTitle>
                  <AlertDescription>{probe.ok ? probe.version : probe.error}</AlertDescription>
                </Alert>
              )}
            </section>
          )}

          {step === 2 && (
            <section className="mx-auto grid max-w-2xl gap-5" aria-label="选择端侧模型">
              <RadioGroup
                value={config.modelMode}
                onValueChange={(value) => update("modelMode", value as RuntimeConfig["modelMode"])}
                className="grid grid-cols-2 gap-3"
                aria-label="模型来源"
              >
                <div className="flex items-start gap-3 rounded-lg border p-4 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-accent/50">
                  <RadioGroupItem id="onboarding-model-huggingface" value="huggingface" aria-label="自动下载" />
                  <Label htmlFor="onboarding-model-huggingface" className="grid flex-1 cursor-pointer gap-1"><b>自动下载</b><small className="font-normal text-muted-foreground">联网获取模型，可随时切换</small></Label>
                </div>
                <div className="flex items-start gap-3 rounded-lg border p-4 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-accent/50">
                  <RadioGroupItem id="onboarding-model-local" value="local" aria-label="本地 GGUF" />
                  <Label htmlFor="onboarding-model-local" className="grid flex-1 cursor-pointer gap-1"><b>本地 GGUF</b><small className="font-normal text-muted-foreground">完全离线，使用已有文件</small></Label>
                </div>
              </RadioGroup>

              {config.modelMode === "huggingface" ? (
                <div className="grid gap-2">
                  <Label htmlFor="onboarding-hf-repo">Hugging Face 模型标识</Label>
                  <Input id="onboarding-hf-repo" value={config.hfRepo} onChange={(event) => update("hfRepo", event.target.value)} placeholder="owner/repo:quant" />
                  <p className="text-xs leading-relaxed text-muted-foreground">格式为 owner/repo:quant。内置默认模型支持镜像与断点续传；其他模型由 llama.cpp 下载。</p>
                </div>
              ) : (
                <div className="grid gap-2">
                  <Label htmlFor="onboarding-model-path">llama.cpp 支持的 GGUF 文件</Label>
                  <div className="flex gap-2">
                    <Input id="onboarding-model-path" value={config.modelPath} readOnly placeholder="请选择 .gguf 文件" />
                    <Button variant="outline" type="button" onClick={selectModel}>选择</Button>
                  </div>
                </div>
              )}
              <Button variant="ghost" className="w-fit" type="button" onClick={() => window.desktopPet.openExternal("https://huggingface.co/models?library=gguf")}>浏览 GGUF 模型并检查许可 <PixelIcon name="open" /></Button>
            </section>
          )}

          {step === 3 && (
            <section className="mx-auto grid max-w-2xl gap-5" aria-label="调整本地运行参数">
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="onboarding-context">上下文长度</Label>
                  <Select value={String(config.contextSize)} onValueChange={(value) => update("contextSize", Number(value))}>
                    <SelectTrigger id="onboarding-context" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="4096">4K · 更省内存</SelectItem>
                      <SelectItem value="8192">8K · 推荐</SelectItem>
                      <SelectItem value="16384">16K · 长对话</SelectItem>
                      <SelectItem value="32768">32K · 高内存</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="onboarding-gpu-layers">GPU 卸载层数</Label>
                  <Input id="onboarding-gpu-layers" type="number" min={0} max={999} value={config.gpuLayers} onChange={(event) => update("gpuLayers", Number(event.target.value))} />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="onboarding-system-prompt">团子的性格设定</Label>
                <Textarea id="onboarding-system-prompt" value={config.systemPrompt} rows={6} onChange={(event) => update("systemPrompt", event.target.value)} />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                <Label htmlFor="onboarding-auto-start" className="grid gap-1"><b>开机后自动准备模型</b><span className="text-xs font-normal text-muted-foreground">启动桌宠时自动拉起 llama.cpp</span></Label>
                <Switch id="onboarding-auto-start" aria-label="开机后自动准备模型" checked={config.autoStart} onCheckedChange={(checked) => update("autoStart", checked)} />
              </div>
            </section>
          )}
        </CardContent>

        <div className="px-7">{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}</div>

        <CardFooter className="justify-between border-t px-7 py-4">
          <Button variant="ghost" type="button" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0 || busy}>上一步</Button>
          <Button type="button" onClick={() => void next()} disabled={!canContinue || busy}>{step === 3 ? (busy ? "正在保存…" : "完成并启动") : "继续"}</Button>
        </CardFooter>
      </Card>
    </main>
  );
}
