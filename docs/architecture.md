# 架构说明

## 目标

首版的目标是建立一个可以继续产品化的最小闭环：

```text
点击桌宠 / 按住 F8 → 文本或本地语音输入 → 本地流式推理 → 桌宠反馈 → 保存本地配置
```

模型权重和 llama.cpp 二进制保持为外部依赖，避免开发包膨胀，也便于独立升级。

## 进程边界

### Renderer

React renderer 只负责界面状态。它没有 Node.js 权限，不能访问文件系统、启动进程或
直接打开外部链接。所有特权操作都通过 preload 暴露的窄 IPC API 完成。

### Preload

preload 使用 `contextBridge` 暴露以下能力：

- 读取与保存经过主进程校验的设置
- 选择 llama.cpp 或 GGUF 文件
- 导入、列出和移除本地知识库文档
- 启停本地运行时
- 发起、停止聊天并订阅流事件
- 准备语音模型、控制按钮录音并订阅语音状态与转写事件
- 调整窗口模式

### Main

主进程负责：

- 透明置顶窗口、托盘和全局快捷键
- JSON 配置的规范化、校验与原子写入
- 通过 Chromium 网络栈下载 GGUF，并通过打包的 PowerShell 脚本下载语音模型
- 聊天与 embedding 两个独立 `llama-server` 子进程的生命周期
- `/health` 就绪轮询
- 通过 OpenAI-compatible adapter 驱动 Vercel AI SDK `ToolLoopAgent`
- 管理 builtin tools、直连 MCP 客户端、串行执行与副作用确认
- 维护 SQLite 本地知识库、向量缓存和词法/语义混合只读检索
- 维护 SQLite 长期任务、步骤检查点、审批和显式恢复
- 默认麦克风采集、F8 按下/释放与 Sherpa-ONNX 语音识别
- 退出时终止由应用启动的运行时

### llama.cpp

内置默认远程模型先下载到应用缓存，再与本地模式一样使用 `-m <path.gguf>`。其他远程
标识使用 llama.cpp 的 `-hf owner/repo:quant`；本地模式接受任意 llama.cpp 支持的
`.gguf`。运行时只监听 `127.0.0.1`，默认端口 18766，并将 CORS 限制为 localhost。
模型参数逐项记录是否由应用覆盖；关闭覆盖后，GPU 层数、线程和采样参数不传给
llama-server / completion API，上下文、最大输出和端口则使用应用的安全默认值，以便仍能
执行精确预算和连接本机服务。

知识库 embedding 使用独立的 `llama-server` 进程，默认只监听 `127.0.0.1:18767`。应用管理的
默认模型是官方 `Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0`；只有用户明确执行“准备向量模型”时
才允许下载，普通知识检索不会隐式触发下载。用户也可选择本地 embedding GGUF。托管模型在
开发环境保存在项目 `models/`，打包后保存在可执行文件同级的 `models/`。

## 状态机

```text
stopped
  └─ start → downloading（仅首次自动模式）
               ├─ cache ready → starting
               │                  ├─ /health 200 → ready
               │                  └─ exit / timeout → error
               └─ mirrors failed → error
ready
  ├─ chat → ready
  ├─ restart → stopping → starting
  └─ stop → stopping → stopped
```

当配置端口上已经存在健康的 llama.cpp 服务时，应用连接该外部服务，但不会在退出时
终止它。

## 语音输入

语音模型与 GGUF 共用模型根目录：开发时为项目根目录的 `models/`，打包后为可执行文件
旁的 `models/`。其中流式 Paraformer 负责录音中的临时文本，离线 SenseVoice 在松键后
覆盖最终草稿。首次准备模型时，主进程依次启动 `download-streaming-model.ps1` 与
`download-models.ps1`；脚本使用 `Invoke-WebRequest` 和系统 `tar`，打包后从
`resources/scripts/` 执行。音频被重采样为 16 kHz 单声道，只在当前会话内保存在主进程内存。
Paraformer 明确加载 INT8 encoder/decoder，并删除官方归档中未使用的 FP32 副本。
识别器就绪后会打开并保持默认麦克风流，待机样本直接丢弃，只在按住按钮或 F8 后写入当前
会话；这样开始录音只需切换内存状态，不再等待声卡驱动重新打开设备。每次录音前仍会查询
系统默认麦克风：设备未变化时复用热流，变化时打开新流并关闭旧流，打开失败时刷新设备再
重试一次，因此运行期间切换耳机后下一次录音会自动跟随。模型目录的扫描结果也会缓存到
路径变化或重新导入为止，避免 F8 按下阶段重复扫描。

除自动下载外，主进程提供本地目录引用。扫描器递归遍历用户选择的目录（跳过符号链接），
按同目录的 encoder/decoder/tokens 结构识别 Paraformer，按 ONNX/tokens 结构识别 SenseVoice，
不依赖源文件夹名称。候选文件优先采用 INT8 和 SenseVoice 特征名；验证后持久化外部根目录并
直接使用扫描所得文件路径，不复制模型。重启时重新解析该目录；选择自动下载才切回统一的
`models/speech` 路径。

```text
not-installed → downloading → loading → ready
                                         └─ 按住按钮/F8 → recording
                                                            └─ 松开 → transcribing → ready
```

全局 F8 会以不激活窗口的方式显示桌宠，保持原应用输入焦点。Paraformer 临时稿实时显示在
橘猫气泡中；SenseVoice 最终稿完成后，主进程短暂写入系统剪贴板并通过 `uiohook-napi`
模拟 `Ctrl+V`，随后恢复原剪贴板内容。聊天框麦克风按钮仍只修改桌宠草稿。录音中使用
竖耳、声波和呼吸动画；最终转换时显示逐行写入的文字卡片。
当 Quick Chat 或完整聊天的编辑框持有焦点时，renderer 通过 IPC 标记 composer focus；此时
F8 会以 `button` 来源启动同一语音会话，直接更新聊天草稿，不进入全局剪贴板粘贴路径。

## 聊天协议

主进程使用 SQLite 保存最多 30 个本地会话，renderer 只通过 preload 暴露的受限 IPC
读取和更新历史。聊天首页的 3 条快捷模板属于普通配置，由 `config.json` 持久化；Chat Panel
直接读取配置并在点击后填入草稿，不会启动额外推理或自动发送。

渲染进程发送完整的已加载历史，主进程将持久化消息直接转换为 AI SDK `ModelMessage`。AI SDK
完成 OpenAI-compatible 序列化后，主进程使用 llama.cpp
`/v1/chat/completions/input_tokens` 对最终请求精确计数；每个 Agent step 都按
`contextSize - maxOutputTokens` 重新装箱，从最新向前保留完整 user turn，工具调用和结果不会被拆开。
若当前正文单独仍超限则拒绝请求，附件内容则可以先截断。随后发送：

```json
{
  "model": "desk-pet-model",
  "stream": true,
  "chat_template_kwargs": {
    "enable_thinking": false
  }
}
```

开启深度思考后 `enable_thinking` 为 `true`；该能力取决于当前模型。主进程把
`delta.reasoning_content` 和 `delta.content` 分成不同 IPC 事件，renderer 累积原始文本并用
禁用原始 HTML 与远程图片的 Markdown / GFM 组件安全渲染。外部链接只允许 HTTPS，并通过
主进程交给系统浏览器打开。

Agent loop 由应用自己的 `AgentRunner` 承载，模型请求使用 Vercel AI SDK Core，llama.cpp
仅提供本地 OpenAI-compatible 推理和 builtin tool 接口。MCP 配置由主进程直接连接本地
stdio、Streamable HTTP 或 legacy SSE server，不再交给 llama.cpp。工具按 FIFO 顺序执行；
builtin 权限元数据不完整及所有 MCP 调用均先请求用户确认。远程 MCP 地址必须使用 HTTPS，
只有本机 loopback 可使用 HTTP；URL 禁止携带凭据，header 支持环境变量占位符，敏感值建议
使用占位符注入。
用户保存受信任配置后，stdio command 会在下一次工具初始化时直接启动；逐次确认只覆盖随后
发起的 MCP tool call，不是对 server 进程启动的沙箱或审批。
普通聊天仍不持久化未完成的单次 run，也不做对话摘要或长期 memory；工具结果保留最近两轮
临时 scratchpad，并由精确请求计数作为 8K/16K 本地上下文的最终边界。持久化长期任务在下文
描述的步骤边界保存状态，但每次模型执行切片仍受相同上下文限制。首期回注模型的 MCP 结果以
文本为主，image、audio、resource 等富媒体结果暂不作为多模态 tool result 处理。
模型可见的工具 schema 同样受限：每轮最多 32 个，且估算占用不超过上下文的 50%；超过时
按 provider 顺序保留并向用户明确列出本轮未启用的工具，避免首个请求因工具定义直接溢出。

应用退出采用有界的两阶段清理：renderer 先终止活动 run 并等待聊天保存 IPC 提交，主进程收到
匹配的 ACK 后才关闭 SQLite；若 ACK 失败或超时，则保留数据库句柄直到进程退出，避免主动
截断仍在途的保存。

## 本地知识库

知识库使用独立于聊天历史的 `knowledge.sqlite`。主进程复用文本/PDF 提取器，将每个文档限制在
400,000 字符内，按约 1,200 字符、160 字符重叠做确定性分块；文档和分块正文持久化到 SQLite。
MiniSearch 在启动时从这些分块重建纯 JavaScript 中英文词法索引，因此即使独立 embedding 服务
未安装、已关闭或异常，基础检索也不依赖 Electron 原生扩展或 Python sidecar。

Agent 只看到一个只读的 `search_local_knowledge` 工具。默认返回 3 个短摘录，每个摘录围绕命中
位置并保留文件名；通用工具结果预算会再次按 8K/16K 上下文裁剪。工具提示和系统指令都把检索
内容标记为不可信参考数据，避免文档内容覆盖系统规则。知识库是独立工具源，可全局关闭，也可用
现有 `disabledToolIds` 单独禁用。导入、替换和移除索引立即生效，不要求重启 llama-server，且
移除索引不会删除原始文件。

语义检索由独立 embedding runtime 提供，不复用聊天生成模型。分块 embedding 以 Float32 BLOB
按 chunk 和模型 fingerprint 缓存在 SQLite；文档替换或删除会使相应向量失效，模型 fingerprint
变化则产生待重建状态。查询时精确计算 cosine 相似度，再通过 reciprocal rank fusion（RRF）与
MiniSearch 排名合并。embedding 服务不可用、响应无效或维度不匹配时，检索器可靠退回原始词法
结果，不阻断 `search_local_knowledge` 工具。

## 持久化长期任务

长期任务使用独立的 `long-tasks.sqlite` 保存任务、预先定义的步骤、步骤输出和有界事件记录。
任务状态为 `draft`、`queued`、`running`、`waiting-approval`、`paused`、`interrupted`、
`completed`、`failed` 或 `cancelled`。任务必须由用户明确启动；通过 Agent 创建时也只生成需要
确认的草稿，不会自动开始。

每个持久步骤是一次短 Agent 执行，当前最多 6 个模型/工具 round。运行中会增量保存部分输出，
步骤完成后保存简明检查点；下一步骤只回注有界的已完成检查点，而不是把任务的全部历史塞回
上下文。因此 8K/16K 是每个执行切片的限制，不是整个长期任务的总长度。需要审批的工具会把
任务置为 `waiting-approval`，批准或拒绝后再继续当前 run。

聊天和长期任务共享聊天 `llama-server` 的 `-np 1` 单槽。尚未开始的 task 可被 chat 越过，但
调度器在有 task 等待时最多连续运行 3 个 chat，避免长期任务无限饥饿；运行中的请求不会被抢占。
应用退出或重新打开数据库时，原 `queued`、`running` 和 `waiting-approval` 任务恢复为
`interrupted`，并保留步骤检查点，只有用户手动继续后才重新排队。本实现没有自动后台计划器，
也不承诺无人值守的完全自治。

## 下一阶段

1. CI 固定并打包 llama.cpp release，加入 SHA-256 校验。
2. 模型 SHA-256 校验、磁盘空间预检与用户可选镜像顺序。
3. Windows 安装包签名、自动更新和崩溃日志。
4. 模型配置预设与 LoRA 人格适配器切换。
5. 编码 Agent 状态集成与任务完成旁白。
6. 多显示器吸附、自由漫游和可替换动画主题。
