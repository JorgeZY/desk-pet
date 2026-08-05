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
- 启停本地运行时
- 发起、停止聊天并订阅流事件
- 准备语音模型、控制按钮录音并订阅语音状态与转写事件
- 调整窗口模式

### Main

主进程负责：

- 透明置顶窗口、托盘和全局快捷键
- JSON 配置的规范化、校验与原子写入
- 通过 Chromium 网络栈下载 GGUF，并通过打包的 PowerShell 脚本下载语音模型
- `llama` / `llama-server` 子进程生命周期
- `/health` 就绪轮询
- OpenAI Chat Completions SSE 解析
- 默认麦克风采集、F8 按下/释放与 Sherpa-ONNX 语音识别
- 退出时终止由应用启动的运行时

### llama.cpp

内置默认远程模型先下载到应用缓存，再与本地模式一样使用 `-m <path.gguf>`。其他远程
标识使用 llama.cpp 的 `-hf owner/repo:quant`；本地模式接受任意 llama.cpp 支持的
`.gguf`。运行时只监听 `127.0.0.1`，默认端口 18766，并将 CORS 限制为 localhost。

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

渲染进程发送最近 20 条历史。主进程添加桌宠系统提示词，并发送：

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
`delta.reasoning_content` 和 `delta.content` 分成不同 IPC 事件，界面分别展示。

## 下一阶段

1. CI 固定并打包 llama.cpp release，加入 SHA-256 校验。
2. 模型 SHA-256 校验、磁盘空间预检与用户可选镜像顺序。
3. Windows 安装包签名、自动更新和崩溃日志。
4. 模型配置预设与 LoRA 人格适配器切换。
5. 编码 Agent 状态集成与任务完成旁白。
6. 多显示器吸附、自由漫游和可替换动画主题。
