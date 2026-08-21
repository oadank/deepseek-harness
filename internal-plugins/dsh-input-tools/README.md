# dsh-input-tools —— 语音能力一体化插件（单包双入口）

一个插件、一个名字 `@oadank/dsh-input-tools`，把 DSH Web 的语音能力全部装进去：
- **host 入口**（`lib/index.js`）：语音工具 + TTS 六引擎 + ASR + 音色克隆 + 自动语音回复
- **client 入口**（`lib/client.js`）：输入框工具条（图片/录音）+ 语音设置页 + 语音复制按钮

插件本体**不修改任何 DSH 源码**，通过 `dsh plugin` 命令安装注册即可用基础语音功能；
完整语音体验（语音消息气泡 / AI 语音回复条）需配合源码补丁，见文末「语音源码补丁」。

## 功能

### Host（服务端）
- **`send_voice` 工具**：agent 主动向用户发送语音横条（可播放、可回看、手机可播）。
- **自动语音回复**：用户发语音（或明确要求语音）后，turn 结束自动合成口语化语音（不念代码/URL/Markdown，最多前 2 句约 200 字）。
- **TTS 引擎**：
  | 引擎 | 说明 |
  |---|---|
  | `auto` | 按「默认语音引擎」选择，未配置时微软 Edge 免费兜底 |
  | `xiaomi` | 小米 MiMo（支持 `(唱歌)` 标签触发行唱） |
  | `voicedesign` | 小米音色设计（一句自然语言凭空生成音色） |
  | `voiceclone` | 小米音色克隆（参考音频复刻音色，15-60 秒最佳） |
  | `edge` | 微软 Edge（免费无 key） |
  | `local` | 本地 TTS（HTTP 常驻服务优先，命令兜底） |
  | `ali` | 阿里 qwen3-tts |
- **ASR**：service（常驻 HTTP）/ cmd（本地命令行）/ api（在线）三模式，配置见设置页。
- **克隆管理工具 `manage_voice_clone`**：注册/设为默认/列出/删除克隆音色。

### Client（浏览器）
- **输入框工具条**：图片（官方 draft 链路）+ 语音录音（秒数/取消）。
- **语音设置页**（设置 → 语音服务）：引擎折叠卡片、小米三模型分区、克隆样本管理、ASR 模式、试听（合成/原声）。
- **语音消息复制按钮**：用户/AI 语音条尾部复制转写文本。

### 界面截图

**输入框工具条**（图片 + 录音按钮）：

![输入框工具条](assets/screenshots/input-toolbar.png)

**语音设置页 —— 小米 TTS**（三模型分区：TTS / 音色设计 / 音色克隆）：

![小米TTS设置页](assets/screenshots/voice-settings-xiaomi.png)

**语音设置页 —— 本地 TTS 与阿里**：

![本地TTS与阿里设置页](assets/screenshots/voice-settings-local-ali.png)

**语音能力状态与 ASR 配置**：

![语音能力与ASR配置](assets/screenshots/voice-capabilities-asr.png)

**聊天语音消息展示**（用户/AI 语音气泡，可点击播放）：

![语音消息展示](assets/screenshots/voice-message-bubbles.png)

## 安装

> 这是 **dsh 的命令**（不是 `npm i -g`）：`dsh plugin` 会把插件装进指定的 profile
> （`~/.dsh/profiles/<name>/node_modules/`），不是装到 npm 全局。
> `~/.dsh` 指 DSH 运行时目录（Windows 为 `C:\Users\<你>\.dsh`）。

### 方式一（推荐）：dsh plugin 一键安装

```bash
dsh plugin --profile web add @oadank/dsh-input-tools
```

自动完成：下载 npm 包 → 装入 profile → 注册 `cordis.patch.yml` → 重启 dsh-web 生效。
（补丁脚本 `patches/apply-voice-patch.ps1` 也已随包发布，路径在
`node_modules\@oadank\dsh-input-tools\patches\`。）

### 方式二：手动拷包（离线/开发）

1. **拷插件包**：把本仓库 `lib/`、`package.json` 拷到
   `~/.dsh/profiles/node_modules/@oadank/dsh-input-tools/`
   （`@oadank` 目录不存在就创建）

2. **注册插件**：编辑 `~/.dsh/profiles/web/cordis.patch.yml`，在 insert 列表加：
   ```yaml
   - insert:
       - id: dsh-input-tools
         name: '@oadank/dsh-input-tools'
   ```

3. **重启 dsh-web 生效**（按你的系统选择一种）：
   - Windows + nssm 服务：`nssm restart dsh-web`
   - Linux + systemd：`systemctl restart dsh-web`
   - 手动启动：停掉当前 dsh 进程后重新运行启动命令

### 可选：本地 ASR（离线识别）

- **Windows**：管理员 PowerShell 运行 `scripts/install-asr.ps1`，自动下载
  sherpa-onnx + SenseVoice 模型、注册 `asr` 常驻服务（端口 18790，开机自启）。
- **Linux**：手动部署 sherpa-onnx 离线识别服务（监听 127.0.0.1:18790，
  接口 `POST /transcribe {"audioPath":"..."}` / `GET /health`），或使用 ASR 的
  cmd/api 模式。

设置页 ASR 模式选「本地常驻服务」指向 18790 即可。

## 配置

所有语音设置保存在 `~/.dsh/voice-config.json`（设置页实时读写，AI 的 `send_voice`
描述里会注入当前配置摘要，无需翻源码）。默认语音引擎、各引擎音色/Key、克隆样本、
ASR 模式都在设置页「语音服务」分区配置。

## 依赖

- `@deepseek-ai/dsh-tools`（DSH profiles 自带，用于注册工具）
- `ws`（Edge TTS WebSocket；profiles 自带）
- **ffmpeg**（语音转码用，见下）

### ffmpeg（必需）

语音转码（录音 webm→wav、克隆样本格式转换、ASR 音频预处理）依赖 **ffmpeg**。
插件按以下顺序自动定位可执行文件：

1. 环境变量 `DSH_VOICE_FFMPEG_BIN`（显式指定完整路径）
2. PATH 探测（`where ffmpeg` / `which ffmpeg`）
3. 兜底已知安装位置

**安装**：Windows 执行 `winget install ffmpeg`（装完一般会自动加 PATH）；
Linux（Debian/Ubuntu）执行 `sudo apt install ffmpeg`。装好后无需任何配置，插件自动探测；
若装在特殊位置，设环境变量 `DSH_VOICE_FFMPEG_BIN=/路径/ffmpeg` 即可。

> 没有 ffmpeg 时：本地 ASR（service/cmd 模式）和克隆样本的非 mp3/wav 格式转换会失败，
> 但小米/edge 在线 TTS 不受影响。

## 语音源码补丁（完整体验原生语音消息，可选）

dsh 的 npm 安装版（0.1.0-rc.7）**契约不支持原生语音消息**（voice content、语音消息气泡、
AI 语音回复条均为本地源码增强，官方源码/官方发布版默认都没有）。要用完整语音体验，
**二选一**：

### 方案 A：官方源码 + 破解脚本（推荐，来源可信）

1. **克隆官方源码**（任意目录，位置不限）：
   ```bash
   git clone https://github.com/deepseek-ai/deepseek-harness.git
   cd deepseek-harness
   git checkout 141eb6fef8        # 官方 dsh-0.1.0-rc.8 release 合并点
   ```
2. **打语音补丁**（Windows 管理员 PowerShell；脚本自动探测源码位置，
   找不到时会提示你输入源码路径）：
   ```powershell
   # 插件 npm 安装后，补丁在本机位置：
   cd node_modules\@oadank\dsh-input-tools\patches
   powershell -ExecutionPolicy Bypass -File apply-voice-patch.ps1
   ```
   脚本自动：探测/输入源码仓库 → 校验补丁可应用 → 备份未提交改动 → 应用 → 幂等（已打跳过）。
3. **构建并启动**：
   ```bash
   pnpm install
   pnpm run build:web            # 前端语音气泡渲染在此步生效
   dsh --profile web             # 或注册为系统服务（Windows 可用 nssm）
   ```
4. **安装语音插件**：`dsh plugin --profile web add @oadank/dsh-input-tools`
5. **可选：本地 ASR**：见上文「可选：本地 ASR」。

### 方案 B：直接克隆改造版（自带语音，零脚本）

改造版 fork 已内置全部语音改造（与方案 A 打补丁后的结果一致），跳过第 2 步：

```bash
git clone https://github.com/oadank/deepseek-harness.git
cd deepseek-harness
# 已是语音改造版，无需 checkout / 无需打补丁
pnpm install
pnpm run build:web
dsh --profile web
```

之后同样执行「安装语音插件」和「可选：本地 ASR」。

### 说明与限制

- 补丁/脚本已随 npm 包发布（`patches/` 目录），git 仓库同步维护。
- **补丁基线**：官方 commit `141eb6fef8`（dsh-0.1.0-rc.8 release 合并点）。
  官方后续更新的 master 与本补丁可能不兼容，**请先 `git checkout 141eb6fef8` 再打补丁**；
  若已应用过，重跑脚本会检测到并跳过（幂等）。
  回滚：`git apply -R <patch>` 或 `git checkout -- <文件>`。
- **npm 版（rc.7）说明**：语音输入（录音→ASR→发送）可用；AI 语音可合成（音频生成）；
  但语音消息气泡/语音回复条受 rc.7 前端限制无法原生显示（插件 DOM 注入方案受 React
  重渲染影响不稳定，已禁用）。完整体验请使用源码版（方案 A 或 B）。
