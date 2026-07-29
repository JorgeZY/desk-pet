# 架构说明

## 目标

首版的目标是建立一个可以继续产品化的最小闭环：

```text
点击桌宠 → 输入消息 → 本地流式推理 → 桌宠反馈 → 保存本地配置
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
- 调整窗口模式

### Main

主进程负责：

- 透明置顶窗口、托盘和全局快捷键
- JSON 配置的规范化、校验与原子写入
- 通过 Chromium 网络栈下载模型、镜像回退与断点续传
- `llama` / `llama-server` 子进程生命周期
- `/health` 就绪轮询
- OpenAI Chat Completions SSE 解析
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
