<p align="center">
  <img src="assets/app-icon.png" width="128" alt="desk-pet icon">
</p>

<h1 align="center">desk-pet</h1>

<p align="center">A local-first AI desktop pet powered by llama.cpp.</p>

<p align="center">
  <a href="https://github.com/JorgeZY/desk-pet/actions/workflows/ci.yml"><img src="https://github.com/JorgeZY/desk-pet/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  · <a href="#中文">中文</a>
</p>

desk-pet is a Windows desktop companion that runs GGUF models locally through
`llama.cpp`. It provides quick chat and full conversations without a cloud API.

## Features

- Local GGUF inference with managed `llama-server` lifecycle and streaming output
- Quick chat, full chat, and SQLite conversation history with batch deletion
- Image and document input for compatible models
- Local speech recognition, global dictation, and text-to-speech
- Vercel AI SDK agent loop with builtin and direct MCP tools
- Configurable model parameters, system prompt, shortcuts, and runtime paths
- Sandboxed Electron renderer with a narrow preload IPC API

## Requirements

- Windows 10/11 x64
- Node.js 22.12 or later for development
- A recent `llama-server.exe` with `/v1/chat/completions/input_tokens` support
- A compatible GGUF model and sufficient disk/RAM/VRAM capacity

Download the Windows installer from
[Releases](https://github.com/JorgeZY/desk-pet/releases/latest), or run from source:

```powershell
git clone https://github.com/JorgeZY/desk-pet.git
cd desk-pet
npm ci
npm run dev
```

On first launch, select `llama-server.exe` and either a local GGUF file or a
supported downloadable model. Development models are stored in `models/`;
packaged builds use the `models/` directory beside the executable.

## Architecture

```text
React renderer
  -> contextBridge / typed IPC
  -> Electron main
       |- Vercel AI SDK agent runner over llama.cpp
       |- SQLite history and local configuration
       |- speech, TTS, downloads, and MCP lifecycle
  -> llama-server on 127.0.0.1
```

See [docs/architecture.md](docs/architecture.md) for component boundaries.

## Development

```powershell
npm run typecheck
npm test
npm run build
npm run dist:win
```

Inference and conversation data stay local. Network access is used only for
explicit model downloads and user-configured remote MCP servers. Remote MCP
URLs require HTTPS; plain HTTP is accepted only for loopback servers.

## Acknowledgements

[OpenBMB/MiniCPM-Desk-Pet](https://github.com/OpenBMB/MiniCPM-Desk-Pet)
inspired the product and sidecar architecture. This repository is not a fork;
see [NOTICE.md](NOTICE.md) for details.

---

## 中文

desk-pet 是一款由 `llama.cpp` 驱动的本地优先 Windows AI 桌宠。它直接运行 GGUF
模型，提供快捷聊天和完整会话，无需云端 API。

### 功能

- 管理本地 `llama-server` 生命周期，并以流式方式输出结果
- 快捷聊天、完整聊天及 SQLite 会话历史，支持批量删除
- 为兼容模型提供图片和文档输入
- 本地语音识别、全局听写与语音合成
- 基于 Vercel AI SDK 的 agent loop，支持 builtin 与直连 MCP 工具
- 可配置模型参数、系统提示词、快捷键及运行路径
- Electron 渲染进程启用沙箱，仅通过受限 IPC 访问系统能力

### 运行要求

- Windows 10/11 x64
- 开发环境需要 Node.js 22.12 或更高版本
- 较新版本的 `llama-server.exe`
- 兼容的 GGUF 模型，以及足够的磁盘、内存或显存

可从 [Releases](https://github.com/JorgeZY/desk-pet/releases/latest)
下载安装包，或从源码运行：

```powershell
git clone https://github.com/JorgeZY/desk-pet.git
cd desk-pet
npm ci
npm run dev
```

首次启动时选择 `llama-server.exe`，再选择本地 GGUF 或受支持的可下载模型。
开发环境使用项目内的 `models/`；打包环境使用可执行文件同级的 `models/`。

### 架构

```text
React renderer
  -> contextBridge / 类型化 IPC
  -> Electron main
       |- 基于 llama.cpp 的 Vercel AI SDK agent runner
       |- SQLite 历史和本地配置
       |- 语音、TTS、下载及 MCP 生命周期
  -> 127.0.0.1 上的 llama-server
```

组件边界详见 [docs/architecture.md](docs/architecture.md)。

### 开发

```powershell
npm run typecheck
npm test
npm run build
npm run dist:win
```

推理和会话数据保留在本机。只有用户主动下载模型或配置远程 MCP 服务时才会访问网络。远程
MCP 地址必须使用 HTTPS；明文 HTTP 只允许本机 loopback 服务。

### 致谢

[OpenBMB/MiniCPM-Desk-Pet](https://github.com/OpenBMB/MiniCPM-Desk-Pet)
为产品和 sidecar 架构提供了参考。本项目不是其 fork，详情见 [NOTICE.md](NOTICE.md)。
