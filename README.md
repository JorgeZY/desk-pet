# desk-pet

一个模型无关、本地优先的桌面宠物：Electron 负责透明置顶窗口与交互，`llama.cpp`
负责端侧推理。可以使用 Hugging Face GGUF，也可以随时切换任意 llama.cpp 支持的本地
`.gguf` 模型。

它不是参考项目的 fork，而是按相同的“桌宠 UI + 本地推理 sidecar + 首次引导”
思路重新实现。当前首版聚焦 Windows，同时保留 macOS / Linux 可移植结构。

## 已实现

- 原创橘猫桌宠 UI：透明、置顶、可拖动、托盘常驻
- 首次启动引导：检测 llama.cpp、填写远程 GGUF 或选择本地模型、性能配置
- 自动管理 `llama` / `llama-server` 子进程
- 本地 OpenAI 兼容接口流式聊天
- 快速回答 / 深度思考双模式（由当前模型能力决定）
- 流式回答、思考折叠、停止生成与本地历史
- 缩小桌宠状态下的一句话快捷对话
- CPU 线程、GPU 卸载、上下文、温度、端口和人格配置
- `Ctrl/Cmd + Shift + M` 显示或隐藏桌宠
- Electron 安全边界：`contextIsolation`、sandbox、无 renderer Node 权限

## 运行要求

- Node.js 20+
- Windows 10/11 x64（MVP 的主要验证目标）
- 约 1.5 GB 可用磁盘空间
- 首次使用自动下载模式时需要网络
- 较新的 llama.cpp；具体模型所需能力以其模型卡为准

### 安装 llama.cpp

Windows 推荐：

```powershell
winget install llama.cpp
llama --version
```

也可以从 [llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases)
下载预编译包，然后在首次引导里选择 `llama-server.exe`。

## 开发

```powershell
npm install
npm run dev
```

第一次进入引导时：

1. 检测 `llama` 命令，或选择 `llama-server.exe`。
2. 填写 `owner/repo:quant` 格式的 Hugging Face GGUF；也可选择任意已有的 `.gguf`。
3. 保持默认 8K 上下文与 GPU 卸载设置。
4. 完成引导。首次唤醒会下载约 700 MB 模型，进度会显示在状态区域。

内置默认模型由 Electron 的 Chromium 网络栈下载，会继承系统代理和 PAC 配置，并支持
ModelScope / Hugging Face 回退与 `.part` 断点续传。其他 Hugging Face 标识交给
`llama.cpp -hf` 处理；网络受限时建议先下载 GGUF，再切换到本地模式。

## 验证与打包

```powershell
npm run typecheck
npm test
npm run build
npm run pack
```

生成 Windows 安装包：

```powershell
npm run dist:win
```

`release/` 是构建产物目录。当前安装包不内置 llama.cpp 与模型权重；最终发布前可在
CI 中下载固定版本的 llama.cpp release，并通过 electron-builder
`extraResources` 打入安装包。

## 本地模型模式

若已经下载了模型，可以在引导或设置中选择任意 llama.cpp 支持的文件，例如：

```text
my-local-model-Q4_K_M.gguf
```

应用会按下面的等价命令启动：

```powershell
llama-server `
  -m D:\models\my-local-model-Q4_K_M.gguf `
  --host 127.0.0.1 --port 18766 `
  -c 8192 -ngl 999 -np 1 --alias desk-pet-model --jinja `
  --cors-origins localhost
```

内置默认模型不把下载委托给 `llama serve -hf`，从而避免其 HTTP 客户端无法读取系统
代理时出现 `HTTPLIB failed: Could not establish connection`。默认模型缓存位于
Electron `userData/models/`；Windows 打包版默认是 `%APPDATA%\desk-pet\models`。

## 架构

```text
React renderer
  │ 受限 IPC（preload + contextBridge）
  ▼
Electron main
  ├─ 配置、托盘、窗口与全局快捷键
  └─ llama.cpp 子进程生命周期 + SSE 翻译
          │ 127.0.0.1:18766
          ▼
      llama / llama-server
          │
          ▼
      任意 llama.cpp GGUF
```

详细设计见 [docs/architecture.md](docs/architecture.md)。

## 数据与隐私

- 聊天请求只发往 `http://127.0.0.1:<port>`。
- 对话历史保存在 Electron renderer 的本地存储中。
- 配置保存在 Electron `userData/config.json`。
- 自动下载只访问官方 ModelScope / Hugging Face 模型仓库，推理和聊天仍完全在本机进行。
- 本项目不需要 OpenAI 或其他云 API Key。

应用从旧名称升级时会迁移 `%APPDATA%\minicpm-v-desk-pet` 中的配置和模型缓存。

## 与参考项目的关系

[OpenBMB/MiniCPM-Desk-Pet](https://github.com/OpenBMB/MiniCPM-Desk-Pet)
提供了产品与 sidecar 架构参考。参考项目为 AGPL-3.0-only；本仓库没有复制其代码或
美术资源。详见 [NOTICE.md](NOTICE.md)。
