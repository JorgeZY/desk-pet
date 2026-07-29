# desk-pet

desk-pet 是一个本地优先、模型可切换的 AI 桌面宠物。它平时以一只常驻桌面的橘猫陪伴
用户，需要时可以快速聊一句，也可以展开完整对话。应用通过 `llama.cpp` 在本机运行
GGUF 模型，不依赖云端聊天服务。

项目当前主要面向 Windows 桌面环境，同时保留向 macOS / Linux 迁移的结构。模型层不与
MiniCPM 或其他单一模型绑定：既可以使用内置推荐模型，也可以切换到任意受当前
`llama.cpp` 版本支持的本地 `.gguf` 文件。

## 项目能力

- 原创橘猫桌宠 UI：透明、置顶、可拖动、托盘常驻
- 桌宠状态下的快捷对话，以及可展开的完整会话界面
- 会话历史同步、流式回答、停止生成与可折叠思考内容
- 首次启动引导：检测 llama.cpp、选择模型并设置运行参数
- 自动管理 `llama` / `llama-server` 子进程与本地推理服务
- 支持 Hugging Face GGUF、自动下载缓存和已有本地模型
- CPU 线程、GPU 卸载、上下文、温度、端口与人格配置
- `Ctrl/Cmd + Shift + M` 显示或隐藏桌宠

## 快速开始

### 1. 准备环境

- Node.js 20+
- Windows 10/11 x64（MVP 的主要验证目标）
- 可用的较新版本 `llama` 或 `llama-server`
- 足够存放 GGUF 模型的磁盘空间
- 首次使用自动下载模式时可访问模型仓库的网络

Windows 可以通过 winget 安装 llama.cpp：

```powershell
winget install llama.cpp
llama --version
```

也可以从 [llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases)
下载预编译包，之后在应用引导中选择 `llama-server.exe`。

### 2. 启动项目

```powershell
npm install
npm run dev
```

### 3. 完成首次引导

1. 检测 `llama` 命令，或选择 `llama-server.exe`。
2. 使用推荐的远程 GGUF，或选择电脑中已有的 `.gguf` 模型。
3. 根据设备调整上下文长度、CPU 线程和 GPU 卸载层数；不确定时保留默认值。
4. 完成设置并唤醒模型。自动下载模式会在状态区域显示下载进度。

## 使用引导

- 在桌宠下方输入一句话，可以直接进行快捷对话。
- 点击桌宠或快捷对话右上角箭头，可以展开完整会话。
- 右键托盘图标可以开始聊天、打开设置、重启模型或退出应用。
- 在设置中可以随时切换 Hugging Face 模型或本地 GGUF，并调整推理参数。
- 使用 `Ctrl/Cmd + Shift + M` 可以快速显示或隐藏桌宠。

快捷对话与完整会话使用同一份本地历史。聊天请求只会发送到本机运行的 llama.cpp
服务；如果选择自动下载模型，模型文件会缓存在应用数据目录中。

## 开发与验证

提交修改前建议运行：

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

## 模型与下载

内置推荐模型使用 Electron 的 Chromium 网络栈下载，可以继承系统代理和 PAC 配置，并
支持 ModelScope / Hugging Face 回退与 `.part` 断点续传。其他 Hugging Face 标识会交给
`llama.cpp -hf` 处理；网络受限时建议先下载 GGUF，再切换到本地模式。

若已经下载模型，可以在引导或设置中选择任意 llama.cpp 支持的文件，例如：

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
