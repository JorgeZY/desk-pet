<p align="center">
  <img src="assets/app-icon.png" width="128" alt="desk-pet 橘猫图标">
</p>

<h1 align="center">desk-pet 🐈</h1>

<p align="center">
  <strong>一只不偷数据，只偷算力的橘猫。</strong>
</p>

<p align="center">
  本地优先 · 模型可换 · 会聊天 · 会卖萌 · 偶尔吃满显存
</p>

<p align="center">
  <a href="https://github.com/JorgeZY/desk-pet/actions/workflows/ci.yml">
    <img src="https://github.com/JorgeZY/desk-pet/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>
</p>

desk-pet 是一只住在桌面上的 AI 橘猫，名字叫「团子」。平时它安静趴着陪你，需要时可以
快速聊一句，也可以展开完整对话。它通过 `llama.cpp` 在本机运行 GGUF 模型——你的聊天
不用飘到云端，只有电脑风扇知道你们聊了什么。🌬️

项目目前主要面向 Windows，但代码结构给 macOS / Linux 留了猫门。模型也不与 MiniCPM
或其他单一模型绑定：推荐模型能吃，任意受当前 `llama.cpp` 支持的本地 `.gguf` 也能吃。
毕竟橘猫不挑食，模型也不该挑。

> [!NOTE]
> 当前是早期预览版。团子已经会聊天，但偶尔仍可能踩到键盘，请重要内容自行核实。

## 🐾 团子会干什么？

- 🐈 **常驻桌面**：透明、置顶、可拖动，不用时缩成一只安静的橘猫
- 💬 **两种聊天姿势**：桌宠状态快速聊一句，或者展开完整会话
- 🧶 **记得刚才聊过什么**：快捷对话和完整会话共享本地历史与上下文
- ✨ **边想边说**：支持流式回答、停止生成和可折叠的思考内容
- 🎙️ **按住就能说**：聊天按钮写入聊天草稿；全局 `F8` 可向当前前台输入框输入，流式文字显示在橘猫气泡中
- 🛠️ **自己照顾 llama.cpp**：检测可执行文件并管理本地推理子进程
- 📦 **模型不绑死**：支持推荐的 Hugging Face GGUF 和已有本地模型
- 🍚 **自己找猫粮**：自动下载、缓存、断点续传，并在 ModelScope /
  Hugging Face 之间回退
- 🎛️ **允许铲屎官微调**：CPU 线程、GPU 卸载、上下文、温度、端口与人格均可配置
- 🫥 **一键躲猫猫**：按 `Ctrl/Cmd + Shift + M` 显示或隐藏桌宠

## 🚀 把团子领回桌面

### 1. 下载源码

前往 [Releases](https://github.com/JorgeZY/desk-pet/releases/latest)，下载 GitHub 自动生成的
`Source code (zip)` 或 `Source code (tar.gz)`。也可以直接克隆仓库：

```powershell
git clone https://github.com/JorgeZY/desk-pet.git
cd desk-pet
```

项目目前只发布源码归档，不提供预编译安装包。这样没有证书警告，也不会让一只来历不明的
橘猫突然住进系统目录。🐾

### 2. 准备运行环境

- Node.js 20+
- Windows 10/11 x64（当前主要验证环境）
- 较新版本的 `llama` 或 `llama-server`
- 足够放下 GGUF 模型的磁盘空间
- 默认麦克风，以及约 450 MB 的本地语音模型空间（按需下载）
- 自动下载模型时可访问模型仓库的网络

Windows 可以通过 winget 安装 llama.cpp：

```powershell
winget install llama.cpp
llama --version
```

也可以从 [llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases)
下载预编译包，然后在首次引导中选择 `llama-server.exe`。

### 3. 启动项目

```powershell
npm install
npm run dev
```

## 🍊 第一次投喂指南

首次启动时，团子会请你完成几件事：

1. 检测系统里的 `llama`，或者选择下载好的 `llama-server.exe`。
2. 使用推荐的远程 GGUF，或者选择电脑里已有的 `.gguf` 模型。
3. 根据设备调整上下文长度、CPU 线程与 GPU 卸载层数；不确定就先保持默认。
4. 点击完成并唤醒模型。自动下载时，状态区域会显示“猫粮到哪了”。

日常相处方式也很简单：

- 在桌宠下方输入一句话，进行快捷对话。
- 按住聊天框里的麦克风按钮可写入聊天草稿；当 Quick Chat 或完整聊天输入框已有光标时，按住 `F8` 等同于按住该麦克风按钮。在其他应用的输入框中按住 `F8`，松开后识别结果会自动粘贴，识别过程显示在橘猫气泡中。
- 点击桌宠或右上角箭头，展开完整会话。
- 右键托盘图标，开始聊天、打开设置、重启模型或退出应用。
- 在设置中随时换模型——团子可能认床，但不认模型。

## 🧠 模型就是猫粮

推荐模型通过 Electron 的 Chromium 网络栈下载，可以继承系统代理和 PAC 配置，并支持
ModelScope / Hugging Face 回退与 `.part` 断点续传。其他 Hugging Face 标识会交给
`llama.cpp -hf` 处理；网络受限时，建议先下载 GGUF，再切换到本地模式。

已经备好模型的话，可以在引导或设置中选择任意兼容文件，例如：

```text
my-local-model-Q4_K_M.gguf
```

应用启动本地模型的等价命令如下：

```powershell
llama-server `
  -m D:\models\my-local-model-Q4_K_M.gguf `
  --host 127.0.0.1 --port 18766 `
  -c 8192 -ngl 999 -np 1 --alias desk-pet-model --jinja `
  --cors-origins localhost
```

内置推荐模型不会把下载委托给 `llama serve -hf`，这样可以避开它无法读取系统代理时的
`HTTPLIB failed: Could not establish connection`。模型缓存位于项目根目录的
`models/`；打包运行时则位于可执行文件旁的 `models/`。从旧版本升级时，应用
会在新目录不存在的情况下复制原有 `userData/models/` 缓存，避免重复下载。

语音模型也使用同一个根目录，分别保存在 `models/speech/streaming-paraformer-bilingual-zh-en/`
和 `models/speech/sense-voice-zh-en-ja-ko-yue-int8/`。首次使用会先征求确认，再通过
内置 PowerShell 脚本从 Sherpa-ONNX 官方发布地址下载并调用系统 `tar` 解压。下载、解压、
录音和识别均不使用 `userData` 或云端服务。开发者也可以提前运行：

流式 Paraformer 明确加载并只保留 `encoder.int8.onnx` 与 `decoder.int8.onnx`；官方归档中
附带但未使用的 FP32 副本会在安装或下次启动时自动清理。

设置页也支持“导入本地模型”。选择一个包含语音模型的任意目录后，应用会递归搜索同目录的
Paraformer encoder/decoder/tokens，以及 SenseVoice ONNX/tokens。源目录和上级文件夹无需
固定命名；候选文件会优先选择带 `int8` 或 `sensevoice` 特征的 ONNX。验证通过后复制到统一的
`models/speech/`，扫描或复制失败不会覆盖已有可用模型。

```powershell
npm run models:speech
```

这套脚本流程参考了
[opencode-stt/download-models.ps1](https://github.com/JorgeZY/opencode-stt/blob/main/scripts/download-models.ps1)
与
[download-streaming-model.ps1](https://github.com/JorgeZY/opencode-stt/blob/main/scripts/download-streaming-model.ps1)，
但最终模型改为 Sherpa Node 可直接读取的 SenseVoice INT8 版本，因此不需要 Python 或
`funasr-onnx`。

## 🧑‍💻 铲屎官开发区

提交修改前建议让这几只命令依次巡逻：

```powershell
npm run typecheck
npm test
npm run build
```

公开 Release 只包含 GitHub 根据版本标签自动生成的源码 ZIP / TAR.GZ，不上传预编译
安装包。需要本地验证 Electron 打包流程时，开发者仍可运行 `npm run pack`。

## 🏠 猫窝结构

```text
React renderer
  │ 受限 IPC（preload + contextBridge）
  ▼
Electron main
  ├─ 配置、托盘、窗口与全局快捷键
  ├─ llama.cpp 子进程生命周期 + SSE 翻译
  └─ F8 / 麦克风 + Sherpa-ONNX 双模型语音识别
          │ 127.0.0.1:18766
          ▼
      llama / llama-server
          │
          ▼
      任意 llama.cpp GGUF
```

想看看猫窝墙体里埋了哪些管线，可以继续阅读
[docs/architecture.md](docs/architecture.md)。

## 🔐 偷算力，不偷数据

- 聊天请求只发往 `http://127.0.0.1:<port>`。
- 对话历史保存在 Electron renderer 的本地存储中。
- 配置保存在 Electron `userData/config.json`。
- GGUF 自动下载只访问 ModelScope / Hugging Face，语音模型只访问 sherpa-onnx 的 GitHub
  Releases；推理、录音和聊天仍在本机进行。
- 语音 PCM 只在录音会话期间保存在内存，不会写入文件或发送到云端。全局 `F8` 完成识别后会短暂使用系统剪贴板模拟粘贴，并在粘贴后恢复原剪贴板内容；应用内麦克风按钮不使用系统剪贴板。
- 项目不需要 OpenAI 或其他云 API Key。
- Electron renderer 启用了 `contextIsolation` 与 sandbox，不开放 Node 权限。

一句话总结：团子可能吃掉一点内存和显存，但不会叼走你的聊天记录。🐾

## 🙇 向隔壁猫猫致谢

[OpenBMB/MiniCPM-Desk-Pet](https://github.com/OpenBMB/MiniCPM-Desk-Pet)
提供了产品与 sidecar 架构参考。本项目不是它的 fork，也没有复制其代码或美术资源。
参考项目采用 AGPL-3.0-only，相关说明见 [NOTICE.md](NOTICE.md)。

---

<p align="center">
  如果团子让你的桌面多了一点快乐，欢迎点个 ⭐。<br>
  模型可以切换，橘猫必须留下。
</p>
