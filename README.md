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
- Local SQLite knowledge base with MiniSearch + cosine RRF retrieval and lexical fallback
- Durable SQLite long tasks with step checkpoints, approvals, and explicit resume
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
       |- SQLite history, local knowledge, durable tasks, and configuration
       |- speech, TTS, downloads, and MCP lifecycle
  -> chat llama-server on 127.0.0.1:18766
  -> optional embedding llama-server on 127.0.0.1:18767
```

See [docs/architecture.md](docs/architecture.md) for component boundaries.

## Local retrieval and durable tasks

Semantic retrieval uses a separate `llama-server` on port `18767`. The managed
default is the official `Qwen3-Embedding-0.6B` Q8_0 GGUF; it is downloaded only
when the user explicitly prepares it. A local embedding GGUF can be selected
instead. Managed models live in `models/` during development and in `models/`
beside the packaged executable.

Chunk embeddings are cached as Float32 vectors in SQLite. Search combines the
MiniSearch lexical ranking with exact cosine results through reciprocal rank
fusion (RRF), and keeps lexical search available when the embedding service is
disabled, absent, or unhealthy.

Long tasks persist their plan, step output, events, and status in SQLite:
`draft`, `queued`, `running`, `waiting-approval`, `paused`, `interrupted`,
`completed`, `failed`, or `cancelled`. Active work reopens as `interrupted` and
continues only after an explicit user action. Each durable step is a bounded
Agent run, and tool approvals still pause execution. Chat and tasks share the
single `-np 1` model slot: queued chats have priority, while a waiting task runs
after at most three consecutive chats. An 8K/16K context limit applies to each
execution slice, not the total lifetime of a persisted task. There is no
automatic background scheduler or claim of fully autonomous operation.

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
- SQLite 本地知识库，通过 MiniSearch + cosine RRF 混合检索文本与 PDF，并支持词法回退
- SQLite 持久化长期任务，支持步骤检查点、审批与显式继续
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
       |- SQLite 历史、本地知识库、长期任务和配置
       |- 语音、TTS、下载及 MCP 生命周期
  -> 127.0.0.1:18766 上的聊天 llama-server
  -> 127.0.0.1:18767 上的可选 embedding llama-server
```

组件边界详见 [docs/architecture.md](docs/architecture.md)。

### 本地检索与持久化长期任务

语义检索使用默认端口 `18767` 上的独立 `llama-server`。应用管理的默认模型是官方
`Qwen3-Embedding-0.6B` Q8_0 GGUF，只有用户明确执行准备操作时才会下载；也可以改选本地
embedding GGUF。开发环境的托管模型位于 `models/`，打包后位于可执行文件同级的 `models/`。

分块向量以 Float32 缓存在 SQLite 中。检索通过 RRF 合并 MiniSearch 词法排名与精确 cosine
结果；向量服务关闭、缺失或异常时继续使用词法检索。

长期任务把计划、步骤输出、事件和状态持久化到 SQLite，状态包括 `draft`、`queued`、
`running`、`waiting-approval`、`paused`、`interrupted`、`completed`、`failed` 和
`cancelled`。活动任务重启后恢复为 `interrupted`，只有用户明确操作才会继续；每个持久步骤
使用有限 Agent 轮数，工具审批仍会暂停执行。聊天与任务共享 `-np 1` 单槽：排队聊天优先，
但连续最多 3 个聊天后会让等待中的任务运行。8K/16K 限制约束每次执行切片，而不是持久任务
的总长度。本项目目前不提供自动后台计划，也不声称完全自治。

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
