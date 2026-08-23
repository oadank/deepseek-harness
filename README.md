# DeepSeek Harness 语音增强版

> 一句话定位：**给 DSH 配上眼睛、耳朵和嘴巴——而且全部免费。**

给 **DeepSeek Harness**（本地 AI 助手）装上完整的感官能力：

- 👀 **眼睛**：模型看不了图时，自动交给本地视觉模型识别（文本模型也能发图识图）
- 🎙️ **耳朵**：你说话 → 自动识别成文字（本地离线 ASR，不依赖云）
- 🔊 **嘴巴**：AI 用语音回复你（微软免费 / 小米 / 本地离线 / 音色克隆 / 阿里）
- 🗣️ **克隆音色**：用你自己的声音说话
- 💰 **零成本**：以上全部能力免费——本地部署优先，无需任何云端 API 付费 Key

本项目基于官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT 协议）二次开发，语音能力来自独立插件 [@oadank/dsh-input-tools](https://github.com/oadank/dsh-input-tools)。

> **为什么本项目要改官方源码？** 官方 dsh 对图片/语音只有一个态度：模型支持就直接发，不支持就报错——纯文本模型（如 deepseek-v4-flash）**根本用不了图片和语音**。外置插件（如 modlens，其 README 自述："the pasted image lands as a private temp file and its path enters the composer"，且代码中无官方发图链路 intakeImages/onAddImages 的接入）**以"粘贴"为图片入口**：粘贴时图片落临时文件、路径文本进输入框、由它自己的 `modlens_read_image` 工具读取；普通按钮选图（官方 intakeImages 链路）、语音带图等入口它覆盖不到；①模式聊天里是路径文本而非标准图片消息（②选 modlens vision 模型时保留缩略图）。本项目在框架层把图片块统一转成"本地附件路径文本"（`serialize.ts` 等）并移除官方"模型不支持图片即拒绝"的闸门，让**任何入口**的图片/语音都能被文本模型用插件工具识别，同时保留完整图片消息体验。详见[插件 README 架构说明](https://github.com/oadank/dsh-input-tools)。
>
> 📋 **源码修改记录表**（每次测试/改动，都更新这张表；大白话版）：
>
> | # | 文件 | 改了啥（大白话） | 为啥改 | 状态 |
> |---|---|---|---|---|
> | 1 | `llm/llm-deepseek/src/serialize.ts` | 发图片不再报错拒绝，改成把图片转成一行"图片在本地哪个文件"的文字 | 纯文本模型收不到图，要给它图片路径文字，它才能调插件识图工具去看图 | ✅ |
> | 2 | `host/apiproxy/src/api-proxy.ts` | 发图时不再检查"这个模型支不支持图片"，一律放行 | 图是转成文字给模型的，模型不需要真的支持图 | ✅ |
> | 3 | `llm/llm-deepseek/src/adapter.ts` + `llm/llm-pi-ai/src/adapter.ts` | 组装模型请求前，不再因为"模型不支持图"直接拒绝 | 这是最靠前的拦截点，不放行图根本走不到第 1 步的转换 | ✅ |
> | 4 | `host/apiproxy/src/api/sessions.ts` | 聊天接口的输入类型里加"语音"这种消息 | 官方不认语音消息，加上才能发原生语音 | ✅ |
> | 5 | `host/apiproxy/src/api/sessions.schema.ts` | 接口的校验规则加语音 | 跟第 4 条配套 | ✅ |
> | 6 | `host/apiproxy/src/api-proxy.ts` | 收到语音消息 → 自动存盘 + 本地识别成文字；另加 `voiceAsr`/`voiceTts` 编辑器 RPC（转写/合成） | 官方不认识语音，要转成文字给模型看；编辑器里"语音转文字/文字转语音"也要接口 | ✅ |
> | 7 | `llm/llm/src/types.ts` | 消息类型表里加"语音块" | 跟第 4 条配套 | ✅ |
> | 8 | `host/apiproxy/src/voice.ts`、`edge-tts.ts`（**新增**，506+119 行） | 语音存盘 / 识别 / 合成的基础代码（含 Edge TTS 微软免费引擎） | 官方源码根本没有语音基础设施，整条链路是我们加的 | ✅ |
> | 9 | `llm/llm-deepseek/src/serialize.ts` | 语音消息转成"识别出的文字" | 模型看不懂语音，给它文字它才知道你说的啥 | ✅ |
> | 10 | `host/apiproxy/src/api/balance.ts`、`balance.schema.ts`（**新增**）+ `rpc-map.ts`、`api/index.ts`、`api-proxy.ts`、`fetch/client.ts`、`fetch/handler.ts`、`index.ts`、测试 mock 共 9 处 | 加"查余额"接口（RPC，直连 DeepSeek `/user/balance`，5 秒缓存） | 官方没有查余额接口；**插件的余额显示只是界面，数据要调这个接口拿**，接口在源码里必须有 | ✅ |
> | 11 | `client/ui-conversation/src/client/skeleton/InputBar.tsx` | 插件图标（图片/语音）从权限按钮后面挪到命令 `+` 前面 | 用户要求按钮顺序是 [🖼][🎙][+] | ✅ |
> | 12 | `host/apiproxy/package.json` | 加 `ws`、`@types/ws` 依赖 | Edge TTS 合成语音要连微软 WebSocket 服务 | ✅ |
> | 13 | `core/session/src/types.ts`、`known-event-types.ts` | 加 `voice` / `reply` 会话事件类型 | 语音消息/语音回复要独立持久化；插件 append 事件必须用它 | ✅ |
> | 14 | `host/apiproxy`（api-proxy + api/sessions.ts、sessions.schema.ts、rpc-map.ts、fetch/client.ts、fetch/handler.ts）+ `client/runtime`（session.ts、contract/session.ts）+ `client/connection`（api.ts、index.ts）+ `api/remotes` | 加"读语音对象"接口（`session.voice` RPC 全链路：host 读语音文件 → 客户端拿字节播放） | 前端要播放历史语音消息，得能从会话里把语音文件读回来 | ✅ 实测读回 257KB |
> | 15 | `llm/llm-pi-ai/src/context.ts`、`adapter.ts`、`catalog.ts` | pi-ai 模型路由（通义 qwen-token-plan-cn 等）**同样**把图片块转成"本地附件路径文本"、语音块转识别文本 | **只改 deepseek 路由不够**——默认模型走 pi-ai 路由（qwen-token-plan-cn），不改的话发图在这条路由照样报错/丢图，两条路由必须一致，"任何入口的图都不丢"才成立 | ✅ |
> | 16 | `attachment/attachment-local/src/store.ts`、`attachment/attachment/src/error.ts` | 附件落盘补**带扩展名的硬链接别名**：jpeg→.jpg、png→.png（硬链接零拷贝）、webp→.png（sharp 转码） | ①历史：当时用的 zai-vision MCP 按扩展名校验，无扩展名直接拒绝（zai-vision 现已停用）；②现状（look_image）：它**不校验扩展名**（`readFile` 直接读，实测无后缀图片可识别），但 **serialize 拼出的路径带扩展名、物理文件无扩展名**——没有别名，look_image 按带扩展名路径读取直接"文件不存在"。别名保证路径真实存在 | ✅ |
> | 17 | `client/ui-conversation/src/client/chat/MessageItem.tsx`（+278 行） | 用户语音消息渲染成**语音气泡**：点击播放、显示时长、可复制转写文本、微信式互斥（同时只播一条）；录音开始时自动停掉播放中的语音（防回声） | **官方前端不渲染 voice 块**——语音消息要么显示成原始 JSON、要么不显示，必须自己加渲染层 | ✅ |
> | 18 | `client/ui-conversation/src/client/chat/TtsVoiceCard.tsx`（**新增** 67 行） | AI 语音回复卡片（base64 转 Blob 播放） | AI 用语音回复时**没有展示层**，回一句语音用户看不见也听不了 | ✅ |
> | 19 | `client/ui-conversation/src/client/chat/VoiceReplyNodeView.tsx`（**新增**）+ `conversation-nodes/voice-reply.ts` + 节点注册（register-node-renderers/register） | 注册 voice/reply 节点渲染器 | voice/reply 是独立持久化事件，官方消息流不认识它——不注册渲染器，语音回复就以"unknown surface"原始 JSON 显示 | ✅ |
> | 20 | `client/ui-conversation/src/client/contract/slots.ts`（+92 行） | 新增 `conversation.chat.voice-actions` 槽声明 | 语音条要挂扩展 UI（插件的复制按钮等），**官方没有挂载点**，不声明槽插件挂不上去 | ✅ |
> | 21 | `client/ui-conversation/src/client/apply.ts`、`service.ts`、`locales.ts`、`index.ts`、`ChatView.tsx` 等 | 配套：节点注册、语音文案翻译、服务扩展（resolveVoice 把语音对象读成播放 URL）、布局 | 上面 #17-20 渲染出来了还得能**真的播放**——读语音 URL 的接口、文案、注册都在这一层，缺一个语音条就是死的 | ✅ |
> | 22 | `subprocess/subprocess-local/src/spawn.ts`、`shell/pwsh-local/src/index.ts` | 杀进程从裸 `taskkill` 改成 **System32 全路径 + PATH 兜底**双保险 | **nssm 服务的 PATH 快照缺 System32** → 裸 taskkill ENOENT 静默失败 → 挂起进程永远杀不掉，超时/停止全部失效（真实踩过的坑） | ✅ |
> | 23 | `acp/acp/src/index.ts`（+95 行）、`api/remotes/src/client/index.ts` | ACP 扩展：流式思考（assistant/chunk reasoning-delta）→ `agent_thought_chunk`、工具事件 → `tool_call` 推送映射 | 外部 ACP 客户端（IDE 等）要**实时看到模型的思考过程和工具调用**，官方 ACP 不推这些事件 | ✅ |
> | 24 | `host/directory-picker-auto/src/resolve.ts`、`scripts/setup-service.ps1` | **Windows 目录选择修复（A+C）**：① resolve.ts：win32 **默认回落 browse**（网页目录树），不再走原生 IFileOpenDialog；新增 `DSH_FORCE_NATIVE_PICKER=1` **反向开关**可强制原生；`DSH_FORCE_BROWSE_PICKER=1` 仍可强制 browse；② setup-service.ps1：nssm 注册时自动把 `DSH_FORCE_BROWSE_PICKER=1` 写进 AppEnvironmentExtra（双保险） | **Windows nssm 服务跑在 session 0，原生 IFileOpenDialog COM 弹窗没有交互桌面弹不出来**（"添加工作区"点了没反应，你亲测过的坑）。browse 是纯 HTTP 目录列表，session 0 完全可用。默认改 browse 之后，**任何 Windows 部署（含命令行直接跑）都不再踩原生弹窗坑**，无需任何环境变量；registry 里 XDN/setup-service 的老配置 `DSH_FORCE_BROWSE_PICKER=1` 与新默认行为一致，无害兼容 | ✅ |
> | 25 | `compaction/command-compact`、`goal/command-goal`、`feedback/command-feedback`、`session-query/session-log-export`、`plan/plan-mode`、`interaction/permission-presets`、`client/modules`、`client/ui-theme` | **命令提示文案中文化**：/compact、/goal、/feedback、会话日志导出等命令的用法、错误提示从英文改成中文（+ 少量 import/声明调整） | 中文用户看英文命令反馈不友好——把所有用户看得见的命令反馈汉化 | ✅ |
> | 26 | 前端 **client lib 重建流程**（`build:lib:client` + `build:web`） | 不是源码改动，是**改前端代码后必须执行的打包步骤**：网页界面分两层——**壳**（apps/web，浏览器先加载的空架子）和**家具**（ui-conversation/connection 等独立打包的组件，运行时搬进壳里）。改家具代码 → 先重新打家具（`build:lib:client`）→ 再重刷外墙（`build:web`）→ 浏览器强制刷新（Ctrl+F5 清缓存） | 之前只跑 `build:web`（只重刷外墙），家具还是旧的 → 图标位置/余额/语音前端改动**全不生效**（"界面毛变化没有"的根因，实测踩过的坑） | ✅ |
> | 27 | `core/session/src/types.ts` + `known-event-types.ts` | 加 `image/reply` 会话事件类型（含 `width`/`height`，与 `ImageAttachmentRef` 对齐）；`KNOWN_SESSION_EVENT_TYPES` 登记 | 图片回复要像语音回复一样**独立持久化**且可翻查；前端节点靠它匹配；插件 `session.append('image/reply', …)` 必须用它 | ✅ |
> | 28 | `host/apiproxy/src/image.ts`（**新增**） | 图片对象存储：内容寻址落盘（`DSH_HOME/attachments/v1/objects/<sha256前2位>/<sha256>`，与用户附件/语音同池）+ png/jpeg/gif/webp 内禀尺寸解析（含 VP8X/VP8L/VP8）+ `saveImageFile`/`readImageFile` | 官方源码**没有图片落盘基础设施**——发图要把字节存进附件池，并返回标准 `ImageAttachmentRef`（含 branded `attachmentId` + 尺寸） | ✅ |
> | 29 | `host/apiproxy/src/api-proxy.ts` | 加 `sendImageMessage`（读本地图→落盘→`append('image/reply', …)`，仿 `sendVoiceMessage`）+ `image`（读回图片对象 base64，仿 `session.voice`）；`imageInEvent` 加 `image/reply` 分支；`sniffImageMediaType` 仅认 png/jpg/jpeg/gif/webp | agent 主动发图要 host 落盘并记入会话；前端放大要看图字节；模型可见性扫描（图进历史重建）也要认识这个事件 | ✅ |
> | 30 | `host/apiproxy/src/api/sessions.ts` + `sessions.schema.ts` + `rpc-map.ts` + `fetch/client.ts` + `fetch/handler.ts` | 两个新 RPC 的接口类型 / zod 校验 / RpcMethodMap / fetch 客户端方法 / 路由 全链路接线 | 新增 RPC 必须五处齐改，否则 schema 校验不过或路由 404（和 voice 链路同款模板） | ✅ |
> | 31 | `client/connection/src/client/fixture.ts` + `client/connection/tests/fake-api.client.ts` + `client/runtime/tests/fake-api.client.ts` | 新 RPC 在 fixture / 两个 fake-api 里接线（`sendImageMessage` 返回 accepted；`image` 返回 1×1 png），`FixtureApiClient` switch 加两个 case | 客户端单测/mock 世界不认新 RPC 会编译报错（`IApiClient` 接口缺方法） | ✅ |
> | 32 | `client/ui-conversation/src/client/conversation-nodes/image-reply.ts`（**新增**）+ `chat/ImageReplyNodeView.tsx`（**新增**）+ 节点注册（register-node-renderers.ts / conversation-nodes/register.ts / index.ts） | 注册 `image-reply` 节点：匹配 `image/reply` 事件（用 `seq` 作唯一 id），渲染为独立图片横条（复用 `renderMessageImages`，可点开放大）；`ChatNodeDataMap` 通过 `declare module '@deepseek-ai/dsh-client-ui-conversation/client'` 扩展 `image-reply` | `image/reply` 是官方消息流不认识的独立事件——不注册渲染器就以 "unknown surface" 原始 JSON 显示；横条复用用户图片消息的同一渲染通道，体验一致 | ✅ |
> | 33 | 插件 `dsh-input-tools`（**独立仓库** `plugins/dsh-input-tools`，npm 已发 `0.3.24`） | 新增 `send_image` 工具（仿 `send_voice`）：读本地图 → `saveImageFile(voiceStorageRoot(), …)` → `session.append('image/reply', …)`；容错 rc.7 无 `append`；含 `sniffImageType`/`readImageSize` 本地镜像 | agent 调 `send_image` 才真正把图发进会话；插件自包含（不 import monorepo），与本 fork 解耦 | ✅ |
> | 34 | 显示链路（**无新增源码即天然打通**） | `loadImage`→`resolveImage`(service.ts)→`session.attachment` RPC→`referencedImage` 已含 `image/reply` 分支 → `renderMessageImages` 正常出图；本计划的 `image` RPC 作为**放大/独立读回**通道额外实现 | 实测发现图横条**不需要**独立 `image` RPC 也能显示（走既有的 attachment 通道），但为完整性与放大能力仍保留 `image` RPC | ✅ |
>
> > ⚠️ 注：**这套体验只能在本项目代码上成立**——官方主线面向官方云模型，不会也不该接受这些改动（图片序列化、语音全链路、余额、事件类型、前端渲染层，跨 10+ 包、30+ 个文件）。

> 只想用官方原版？见[官方仓库](https://github.com/deepseek-ai/deepseek-harness)。
> 注意：官方版是快速迭代的开发者预览版，且**没有本项目的语音功能**（语音能力来自本项目的插件）。
> 本项目的安装见下文「一、安装」，按步骤装完就是正式安装，不会丢。

> ⚠️ **重要：别被 `npx` 误导——它不是安装；而且官方版 ≠ 本项目**
>
> - 官方文档写的 `npx @deepseek-ai/dsh web` 只是**临时运行**（下载到 npm 缓存拉起跑，没有全局 `dsh` 命令，每次都要重新解析）；想正式安装官方版：`npm install -g @deepseek-ai/dsh`，之后直接运行 `dsh web`。
> - 但**无论临时还是正式，官方版都是独立产品线**：它是预编译的发行包（只有编译产物、没有源码，无法加装本项目的改造），**没有本项目的语音/克隆功能**；本项目的语音插件是配合本 fork 开发测试的，在官方发行包上**不保证兼容**。
> - 不管哪种方式，你的数据（会话、配置）都存在 `~/.dsh`，**不会丢**。
> - **想用语音功能 → 装本项目**（下面「一、安装」），装完就是正式安装。

## 界面预览

**输入框工具条**（左起：图片/🎙 录音/+/权限/余额/模型）

![输入框工具条](docs/screenshots/input-toolbar.png)

**语音消息**（录音后自动识别成文字发送，AI 也能用语音回）

![语音消息](docs/screenshots/voice-message-bubbles.png)

**语音能力与 ASR 配置**（引擎选择、音色设计、克隆、ASR）

![语音能力与 ASR](docs/screenshots/voice-capabilities-asr.png)

**TTS 引擎设置**（小米 / 本地 MeloTTS / 阿里 三选）

| 小米 TTS | 本地 TTS / 阿里 |
|---|---|
| ![小米TTS](docs/screenshots/voice-settings-xiaomi.png) | ![本地TTS与阿里](docs/screenshots/voice-settings-local-ali.png) |

---

## 一、安装

### 方式 A：Windows

**前置准备**（没有才装，已装跳过。在 PowerShell 里逐条复制运行）：

```powershell
# 1. Git（版本管理工具）
winget install --id Git.Git -e --source winget

# 2. Node.js（自带 npm；要求 22.19 或更高，24 也可以）
winget install --id OpenJS.NodeJS.LTS -e --source winget

# 3. 装完 Node.js 后【重开 PowerShell】让命令生效，然后装 pnpm
npm install -g pnpm
```

装完检查一下（应该都能打印出版本号，没有就重开终端再试）：

```powershell
git --version; node -v; npm -v; pnpm -v
```

然后**整段复制运行**下面的安装步骤：

```powershell
# 1. 下载代码
git clone https://github.com/oadank/deepseek-harness.git
cd deepseek-harness

# 2. 安装依赖 + 编译（首次约 5~10 分钟，耐心等）
pnpm install
pnpm run build:lib
pnpm run build:web

# 3. 安装语音插件（自动从 npm 下载并注册）
powershell -ExecutionPolicy Bypass -File scripts\setup-profile.ps1

# 4. 启动（浏览器自动打开 http://127.0.0.1:3080）
node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 3080
```

### 方式 B：Linux / macOS

**前置准备**（没有才装，已装跳过）：

```bash
# Debian / Ubuntu：
sudo apt update && sudo apt install -y git
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs
# macOS（需先装 Homebrew，见 https://brew.sh）：
#   brew install git node
# 装完 Node.js 后（npm 随 Node 自带）：
npm install -g pnpm
```

然后**整段复制运行**：

```bash
git clone https://github.com/oadank/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build:lib
pnpm run build:web
bash scripts/setup-profile.sh
node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 3080
```

> 💡 想 24 小时后台运行（像服务器一样常驻）？Windows 用 nssm、Linux 用 systemd，
> 完整步骤见 [INSTALL.md](INSTALL.md)。

---

## 二、懒得自己装？让 AI 帮你装

把下面这段话**原样发给**任意 AI 助手（ChatGPT、DeepSeek、豆包……），它会照着一步步帮你装完：

> 请帮我在电脑上安装 DeepSeek Harness 语音增强版。
> 项目地址：https://github.com/oadank/deepseek-harness
> 安装教程：https://raw.githubusercontent.com/oadank/deepseek-harness/master/INSTALL.md
> 我的系统是 Windows / Linux / macOS（请删掉不适用的）。
> 请先检查 Git、Node.js（>=22.19）、pnpm 是否装好，没装就先装；
> 然后严格按教程一步步执行，每完成一大步就告诉我结果；
> 遇到任何报错先停下来分析原因，不要跳过；装完帮我启动并验证能用。

---

## 三、装完怎么用

1. 浏览器打开 http://127.0.0.1:3080
2. 输入框左侧有 **[🎙] 录音按钮**：按住说话，松开自动识别成文字发出去
3. 打开 **设置 → 语音服务**：选语音引擎（微软免费开箱即用 / 小米 / 本地离线）、调音色、克隆声音
4. 想让 AI 用语音回答：直接对它说"用语音回答我"即可

---

## 四、常见问题

| 问题 | 解决 |
|---|---|
| 启动报错提示要先编译 | 全新 clone 必须先 `pnpm run build:lib`，不能跳过 |
| 语音条点了没声音 | 检查 ffmpeg：Windows 运行 `winget install ffmpeg` |
| 端口 3080 被占用 | 启动命令加 `--port 3081` |
| 想开机自启 / 远程访问 / 换语音引擎 | 看 [INSTALL.md](INSTALL.md)，含完整排障 |

---

## 与官方版的关系

- 本项目 = 官方 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) + 语音插件 [@oadank/dsh-input-tools](https://github.com/oadank/dsh-input-tools)
- 插件独立维护、从 npm 安装：升级项目不影响插件，反之亦然
- 本项目不与上游合并（含个人本地化偏好），按需跟随官方更新

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek AI，[MIT](LICENSE)）
- [Cordis](https://github.com/cordiverse/cordis) 插件框架
