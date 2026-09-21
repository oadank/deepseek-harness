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
> | 10 | `host/apiproxy/src/api/balance.ts`、`balance.schema.ts`（**新增**）<br>`rpc-map.ts`、`api/index.ts`、`api-proxy.ts`<br>`fetch/client.ts`、`fetch/handler.ts`、`index.ts`、测试 mock 共 9 处 | 加"查余额"接口（RPC，直连 DeepSeek `/user/balance`，5 秒缓存） | 官方没有查余额接口；**插件的余额显示只是界面，数据要调这个接口拿**，接口在源码里必须有 | ✅ |
> | 11 | `client/ui-conversation/src/client/skeleton/InputBar.tsx` | 插件图标（图片/语音）从权限按钮后面挪到命令 `+` 前面 | 用户要求按钮顺序是 [🖼][🎙][+] | ✅ |
> | 12 | `host/apiproxy/package.json` | 加 `ws`、`@types/ws` 依赖 | Edge TTS 合成语音要连微软 WebSocket 服务 | ✅ |
> | 13 | `core/session/src/types.ts`、`known-event-types.ts` | 加 `voice` / `reply` 会话事件类型 | 语音消息/语音回复要独立持久化；插件 append 事件必须用它 | ✅ |
> | 14 | `host/apiproxy`（api-proxy + api/sessions.ts、sessions.schema.ts、rpc-map.ts、fetch/client.ts、fetch/handler.ts）<br>`client/runtime`（session.ts、contract/session.ts）<br>`client/connection`（api.ts、index.ts）+ `api/remotes` | 加"读语音对象"接口（`session.voice` RPC 全链路：host 读语音文件 → 客户端拿字节播放） | 前端要播放历史语音消息，得能从会话里把语音文件读回来 | ✅ 实测读回 257KB |
> | 15 | `llm/llm-pi-ai/src/context.ts`、`adapter.ts`、`catalog.ts` | pi-ai 模型路由（通义 qwen-token-plan-cn 等）**同样**把图片块转成"本地附件路径文本"、语音块转识别文本 | **只改 deepseek 路由不够**——默认模型走 pi-ai 路由（qwen-token-plan-cn），不改的话发图在这条路由照样报错/丢图，两条路由必须一致，"任何入口的图都不丢"才成立 | ✅ |
> | 16 | `attachment/attachment-local/src/store.ts`<br>`attachment/attachment/src/error.ts` | 附件落盘补**带扩展名的硬链接别名**：jpeg→.jpg、png→.png（硬链接零拷贝）、webp→.png（sharp 转码） | ①历史：当时用的 zai-vision MCP 按扩展名校验，无扩展名直接拒绝（zai-vision 现已停用）；②现状（look_image）：它**不校验扩展名**。**2026-09-10 更正**：0.1.5 升级后 store 别名丢失，改为 **serialize 直接拼无扩展名对象路径**（见 #54），本行别名不再是 look_image 的必要条件 | ✅ 见 #54 |
> | 17 | `client/ui-conversation/src/client/chat/MessageItem.tsx`（+278 行） | 用户语音消息渲染成**语音气泡**：点击播放、显示时长、可复制转写文本、微信式互斥（同时只播一条）；录音开始时自动停掉播放中的语音（防回声） | **官方前端不渲染 voice 块**——语音消息要么显示成原始 JSON、要么不显示，必须自己加渲染层 | ✅ |
> | 18 | `client/ui-conversation/src/client/chat/TtsVoiceCard.tsx`（**新增** 67 行） | AI 语音回复卡片（base64 转 Blob 播放） | AI 用语音回复时**没有展示层**，回一句语音用户看不见也听不了 | ✅ |
> | 19 | `client/ui-conversation/src/client/chat/VoiceReplyNodeView.tsx`（**新增**）+ `conversation-nodes/voice-reply.ts` + 节点注册（register-node-renderers/register） | 注册 voice/reply 节点渲染器 | voice/reply 是独立持久化事件，官方消息流不认识它——不注册渲染器，语音回复就以"unknown surface"原始 JSON 显示 | ✅ |
> | 20 | `client/ui-conversation/src/client/contract/slots.ts`（+92 行） | 新增 `conversation.chat.voice-actions` 槽声明 | 语音条要挂扩展 UI（插件的复制按钮等），**官方没有挂载点**，不声明槽插件挂不上去 | ✅ |
> | 21 | `client/ui-conversation/src/client/apply.ts`、`service.ts`、`locales.ts`、`index.ts`、`ChatView.tsx` 等 | 配套：节点注册、语音文案翻译、服务扩展（resolveVoice 把语音对象读成播放 URL）、布局 | 上面 #17-20 渲染出来了还得能**真的播放**——读语音 URL 的接口、文案、注册都在这一层，缺一个语音条就是死的 | ✅ |
> | 22 | `subprocess/subprocess-local/src/spawn.ts`、`shell/pwsh-local/src/index.ts` | 杀进程从裸 `taskkill` 改成 **System32 全路径 + PATH 兜底**双保险 | **nssm 服务的 PATH 快照缺 System32** → 裸 taskkill ENOENT 静默失败 → 挂起进程永远杀不掉，超时/停止全部失效（真实踩过的坑） | ✅ |
> | 23 | `acp/acp/src/index.ts`（+95 行）<br>`api/remotes/src/client/index.ts` | ACP 扩展：流式思考（assistant/chunk reasoning-delta）→ `agent_thought_chunk`、工具事件 → `tool_call` 推送映射 | 外部 ACP 客户端（IDE 等）要**实时看到模型的思考过程和工具调用**，官方 ACP 不推这些事件 | ✅ |
> | 24 | `host/directory-picker-auto/src/resolve.ts`<br>`scripts/setup-service.ps1` | **Windows 目录选择修复（A+C）**：① resolve.ts：win32 **默认回落 browse**（网页目录树），不再走原生 IFileOpenDialog；新增 `DSH_FORCE_NATIVE_PICKER=1` **反向开关**可强制原生；`DSH_FORCE_BROWSE_PICKER=1` 仍可强制 browse；② setup-service.ps1：nssm 注册时自动把 `DSH_FORCE_BROWSE_PICKER=1` 写进 AppEnvironmentExtra（双保险） | **Windows nssm 服务跑在 session 0，原生 IFileOpenDialog COM 弹窗没有交互桌面弹不出来**（"添加工作区"点了没反应，你亲测过的坑）。browse 是纯 HTTP 目录列表，session 0 完全可用。默认改 browse 之后，**任何 Windows 部署（含命令行直接跑）都不再踩原生弹窗坑**，无需任何环境变量；registry 里 XDN/setup-service 的老配置 `DSH_FORCE_BROWSE_PICKER=1` 与新默认行为一致，无害兼容 | ✅ |
> | 25 | `compaction/command-compact`<br>`goal/command-goal`<br>`feedback/command-feedback`<br>`session-query/session-log-export`<br>`plan/plan-mode`<br>`interaction/permission-presets`<br>`client/modules` + `client/ui-theme` | **命令提示文案中文化**：/compact、/goal、/feedback、会话日志导出等命令的用法、错误提示从英文改成中文（+ 少量 import/声明调整） | 中文用户看英文命令反馈不友好——把所有用户看得见的命令反馈汉化 | ✅ |
> | 26 | 前端 **client lib 重建流程**（`build:lib:client` + `build:web`） | 不是源码改动，是**改前端代码后必须执行的打包步骤**：网页界面分两层——**壳**（apps/web，浏览器先加载的空架子）和**家具**（ui-conversation/connection 等独立打包的组件，运行时搬进壳里）。改家具代码 → 先重新打家具（`build:lib:client`）→ 再重刷外墙（`build:web`）→ 浏览器强制刷新（Ctrl+F5 清缓存） | 之前只跑 `build:web`（只重刷外墙），家具还是旧的 → 图标位置/余额/语音前端改动**全不生效**（"界面毛变化没有"的根因，实测踩过的坑） | ✅ |
> | 27 | `core/session/src/types.ts`<br>`known-event-types.ts` | 加 `image/reply` 会话事件类型（含 `width`/`height`，与 `ImageAttachmentRef` 对齐）；`KNOWN_SESSION_EVENT_TYPES` 登记 | 图片回复要像语音回复一样**独立持久化**且可翻查；前端节点靠它匹配；插件 `session.append('image/reply', …)` 必须用它 | ✅ |
> | 28 | `host/apiproxy/src/image.ts`（**新增**） | 图片对象存储：内容寻址落盘（`DSH_HOME/attachments/v1/objects/<sha256前2位>/<sha256>`，与用户附件/语音同池）+ png/jpeg/gif/webp 内禀尺寸解析（含 VP8X/VP8L/VP8）+ `saveImageFile`/`readImageFile` | 官方源码**没有图片落盘基础设施**——发图要把字节存进附件池，并返回标准 `ImageAttachmentRef`（含 branded `attachmentId` + 尺寸） | ✅ |
> | 29 | `host/apiproxy/src/api-proxy.ts` | 加 `sendImageMessage`（读本地图→落盘→`append('image/reply', …)`，仿 `sendVoiceMessage`）+ `image`（读回图片对象 base64，仿 `session.voice`）；`imageInEvent` 加 `image/reply` 分支；`sniffImageMediaType` 仅认 png/jpg/jpeg/gif/webp | agent 主动发图要 host 落盘并记入会话；前端放大要看图字节；模型可见性扫描（图进历史重建）也要认识这个事件 | ✅ |
> | 30 | `host/apiproxy/src/api/sessions.ts` + `sessions.schema.ts`<br>`rpc-map.ts` + `fetch/client.ts` + `fetch/handler.ts` | 两个新 RPC 的接口类型 / zod 校验 / RpcMethodMap / fetch 客户端方法 / 路由 全链路接线 | 新增 RPC 必须五处齐改，否则 schema 校验不过或路由 404（和 voice 链路同款模板） | ✅ |
> | 31 | `client/connection/src/client/fixture.ts`<br>`client/connection/tests/fake-api.client.ts`<br>`client/runtime/tests/fake-api.client.ts` | 新 RPC 在 fixture / 两个 fake-api 里接线（`sendImageMessage` 返回 accepted；`image` 返回 1×1 png），`FixtureApiClient` switch 加两个 case | 客户端单测/mock 世界不认新 RPC 会编译报错（`IApiClient` 接口缺方法） | ✅ |
> | 32 | `client/ui-conversation/src/client/conversation-nodes/image-reply.ts`（**新增**）<br>`chat/ImageReplyNodeView.tsx`（**新增**）<br>节点注册（register-node-renderers.ts / conversation-nodes/register.ts / index.ts） | 注册 `image-reply` 节点：匹配 `image/reply` 事件（用 `seq` 作唯一 id），渲染为独立图片横条（复用 `renderMessageImages`，可点开放大）；`ChatNodeDataMap` 通过 `declare module '@deepseek-ai/dsh-client-ui-conversation/client'` 扩展 `image-reply` | `image/reply` 是官方消息流不认识的独立事件——不注册渲染器就以 "unknown surface" 原始 JSON 显示；横条复用用户图片消息的同一渲染通道，体验一致 | ✅ |
> | 33 | 插件 `dsh-input-tools`（**独立仓库** `plugins/dsh-input-tools`，npm 已发 `0.3.24`） | 新增 `send_image` 工具（仿 `send_voice`）：读本地图 → `saveImageFile(voiceStorageRoot(), …)` → `session.append('image/reply', …)`；容错 rc.7 无 `append`；含 `sniffImageType`/`readImageSize` 本地镜像 | agent 调 `send_image` 才真正把图发进会话；插件自包含（不 import monorepo），与本 fork 解耦 | ✅ |
> | 34 | 显示链路（**无新增源码即天然打通**） | `loadImage`→`resolveImage`(service.ts)→`session.attachment` RPC→`referencedImage` 已含 `image/reply` 分支 → `renderMessageImages` 正常出图；本计划的 `image` RPC 作为**放大/独立读回**通道额外实现 | 实测发现图横条**不需要**独立 `image` RPC 也能显示（走既有的 attachment 通道），但为完整性与放大能力仍保留 `image` RPC | ✅ |
> | 35 | `host/apiproxy/src/api-proxy.ts`（+~55 行） | 新增 `readGwBalance()`：读 `GW_API_KEY` 凭证，调 `gateway.henry-gao.com/v1/balance`（5s 缓存），映射成 `BalanceView`（CNY 按量余额）；`balance.get` RPC 按当前 provider 分流：`gw`→gw 余额、`deepseek-official`→官方余额、其余→null | henry-gao gw 直连模型切换后显示网关余额，与官方直连余额显示一致；gw provider 通过 settings.yaml 纯配置接入（零源码） | ✅ 已重启生效，实测切换 gw 显示 ¥128.28 |
> | 36 | 插件 `dsh-input-tools`（独立仓库 `plugins/dsh-input-tools`，`lib/client.js`） | `BalanceMeter` 余额触发改**懒查询**：去掉 30s setInterval 轮询；改为 mount 查一次 + `useSession(s=>s.running)` false→true 边沿（发消息时）查一次 + mux 流订阅 `request/header(reason=change)`/`request/context`（切换模型后首次使用时）查一次；余额显示格式化 2 位小数 | 满足"用的时候才查、平时不查"，避免频繁打网关 /v1/balance；数值太长(9位)占用位置，改 2 位小数。注：切换模型瞬间 wire 无事件，最近信号是换模型后首次请求 | ✅ 已生效（前端刷新后显示 ¥128.28） |
> | 37 | `host/apiproxy/src/api-proxy.ts`（+~35 行）`api/balance.ts` `api/balance.schema.ts` 插件 `dsh-input-tools` `lib/client.js` | **gw 网关健康状态点**：新增 `readGwHealth()` 探测 `gateway.henry-gao.com/health`（状态页自身使用的健康接口，返回 `{ready}`，5s 缓存）；`balance.get` RPC 在 gw provider 时返回 `gatewayHealthy: await readGwHealth()`（真实探测，true=正常/绿、false=异常/红，其余 provider 返回 null）；前端 `BalanceMeter` 在余额按钮内部渲染 绿点(正常)/红点(异常)，null 不显示（合并进同一按钮，非独立元素） | 浏览器直连 gw /health 会被 CORS 拦截（实测无 ACAO 头），故必须由 host 服务端代查后随余额一并返回；`ready:true`=绿、非 200/失败/超时=红。**生效前提：重建 dsh-client-connection client bundle（`npm run build:lib:client`）**——浏览器端 `balanceGetValueSchema` 被 inline 进预编译 bundle，只改源码 schema 不重建，浏览器用旧 schema parse 会抛 ZodError 被前端 catch 静默吞掉 → 零报错但不渲染 | ✅ 已重启生效，实测余额前显示绿点（网关正常） |
> | 38 | `core/agent-loop/src/agent.ts` | **移除** 2026-08-26 加入的「dsh-loop-guard 联动本地补丁」：当流失败且已输出可见文本（text/reasoning）时，原本会保存一条 `interrupted` 消息并按正常完成结束本步（不再整步重试），现恢复官方行为——`action.kind !== 'retry'` 时直接 `throw LlmError`，交给官方 llm-retry 整步重发 | 该补丁与 `dsh-loop-guard` 插件的 `noRetryAfterVisibleOutput` 叠加后，**模型只要说出第一句推理/文本，一旦传输抖动就被判"完成"直接结束本步，不继续调用工具** → 用户遇到"切换模型后说两句就罢工、不用工具"。卸载补丁恢复官方重试（代价：传输不稳时会整步重发、重复烧 token），让模型能完整跑完 → 正常调用工具 | ✅ 已移除，`git diff agent.ts` 为空（与官方 HEAD 一致）；`node --check` 通过；待重启 dsh-web 生效 |
> | 39 | `host/apiproxy/src/api-proxy.ts`（+~100 行）`api/balance.ts` `api/balance.schema.ts` `api/index.ts` 插件 `dsh-input-tools` `lib/client.js` | **火山方舟 ARK Agent Plan 套餐配额显示**：① 新增 `readArkUsage()`：读凭证 `VOLC_ACCESS_KEY_ID`/`VOLC_SECRET_ACCESS_KEY`，火山 V4 签名（**seed=SK 原值，别 base64 解**）调 `GetAFPUsage`，返回 `planType` + `periods[{label:'5h'|'weekly'|'monthly', quota, used, resetAt}]`，60s 缓存；② `balance.get` 按 provider 分流：`volc-ark`→`{balance:null, usage}`、`gw`→gw 余额、其余→null；③ `balance.schema.ts` 的 `balanceGetValueSchema` 加 `gatewayHealthy`+`usage` 字段；④ 前端 `BalanceMeter` 对 volc-ark 渲染 `5h{?}% · 周{?}% · 月{?}%`；⑤ 重建 dsh-client-connection client bundle（`UNARY_VALUE_SCHEMAS` 里 `balanceGetValueSchema` 被 inline 进浏览器 bundle，旧 bundle 无 usage → 前端只收到 `{balance:null}`） | ARK 是按量套餐无"余额"概念，切 ArkV4F 要显示套餐配额用量而非余额；浏览器端 callUnary 用 zod parse（strip 未知字段），host 加字段后必须**重建浏览器 bundle + host 各分支同步补字段**，否则 parse 失败 | ✅ 已重启生效，实测切 ArkV4F 显示 `5h9% · 周53% · 月42%` |
> | 40 | `host/apiproxy/src/api-proxy.ts`（balance.get 各分支） | **坑修复：balance.get 所有返回分支补 `gatewayHealthy` 字段**（`volc-ark`/其它→`null`，`gw`→`await readGwHealth()`） | **zod v4 的 `.nullable()` 只接受 null/boolean，不接受 undefined（字段缺失）**——host 各分支最初只返回 `{balance, usage}` 没带 `gatewayHealthy`，浏览器端 `balanceGetValueSchema.parse` 抛 ZodError → 前端 `catch{/*静默*/}` 吞掉 → **控制台零报错但永不渲染**（"无报错不显示"极难排查，本次靠 curl host 接口 + 本地 zod 模拟 parse 定位）。教训：给浏览器端 schema 加字段后，host 所有返回分支必须同步补全该字段 | ✅ 已重启生效，前端显示正常 |
> | 41 | 插件 `dsh-input-tools` `lib/client.js`（BalanceMeter） | **gw 状态点呼吸灯动画**：挂载时 `useEffect` 注入一次全局 `<style>` 定义 `@keyframes dshGwBreath`（透明度 .55→1 + boxShadow 光晕 0 0 2px→0 0 8px 2px 循环，2.4s ease-in-out infinite）；圆点 style 用 CSS 变量 `--gwglow` 随红/绿变色（绿 `rgba(46,204,113,.85)`、红 `rgba(231,76,60,.85)`）并 `animation: dshGwBreath 2.4s ease-in-out infinite`；`document.getElementById("dsh-gw-breath")` 防重复注入 | React 内联 style 不能直接写 @keyframes，改为动态注入 style 标签；CSS 自定义属性（`--gwglow`）在 React 内联 style 对象里用字符串 key 直接赋值即可，实现同一点随状态变呼吸光色 | ✅ 已生效，实测呼吸灯效果正常 |
> | 42 | 配置 `profiles/web/cordis.patch.yml`（attachment-local 覆盖，非源码）+ 插件 `dsh-input-tools` `lib/client.js` | **图片单边限制 2000px→8192px**：服务端 attachment-local 覆盖 `maxImageDimension:8192`、`maxImagePixels:1亿(容纳8192²)`、`maxImageBytes:20MB`（用 profile patch 层配置覆盖，**零源码改动**）；客户端 `scaleImageToFit` 缩放目标 `2000→8192`，并更新注释 | 手机照片(长边~4000px)/高截图/8K 图在旧 2000px 下上传即被拒（IMAGE_DIMENSION_TOO_LARGE），或走按钮选图被客户端提前压到 2000px 丢细节；粘贴/拖拽路径无客户端缩放、仅服务端限制，同样受益 | ✅ 服务端已生效（实测 curl session.list 报告 imageLimits=8192/1亿/20MB，1284×2778 高测试图入库）；客户端改后需浏览器刷新（Ctrl+F5） |
> | 43 | `client/ui-conversation/src/client/chat/VoiceReplyNodeView.tsx`（+`data-voice-id`）<br>插件 `dsh-input-tools` `lib/client.js` | **助手语音自动播放「已读/未读」**：① 源码给语音卡暴露稳定的 `data-voice-id={voice.voiceId}`；② 插件自动播放按 voiceId 持久化到 localStorage（`dsh.autoPlayedVoiceIds`，上限 300 条）→ 重开页面历史语音（已播过）**不重播**，新语音一到**立即自动播**（无需点击、不依赖 mux/RPC）；开关在语音设置页（`autoPlayAssistantVoice` 默认开，localStorage+voice-config 双写） | 之前自动播放靠 WeakSet（仅当前页面内存）→ 每次重开浏览器历史语音全重播（烦）；或改 mux 事件流 → 手机 Safari 下失效。加稳定标识 + 持久化已播集合才是根治 | ✅ 已重建 ui-conversation client bundle 并同步 profiles/node_modules，实测服务端两个 bundle 均含新代码；客户端刷新即生效（无需重启服务） |
> | 44 | 插件 `dsh-input-tools` `lib/client.js`（BalanceMeter） | **切换模型就强刷一次余额/用量**：BalanceMeter 新增订阅本会话模型目录 store（`modelDirectories.directoryFor(sessionId).store`，`useSyncExternalStore`）监听 `current` 变化（=切了模型）⇒ 立刻调 `balance.get` 重查刷新；`apply` 里加 `getModels` 取 `modelDirectories` 服务，槽注入传 `getModelStore`（try/catch 兜底）。纯插件改，服务端 `readFile` 实时读 `lib/client.js` + `cache-control: no-cache`，刷新页面即生效 | 之前切模型瞬间 mux 无事件，余额/用量要等"换模型后第一次真正请求"（即发下一条消息）才更新；用户要求**一切换就查一次** | ✅ 已按 `node --check` 校验 + curl 3080 `/plugins/@oadank/dsh-input-tools/client.js` 确认新 bundle（标记命中）；浏览器刷新生效 |
> | 45 | `packages/host/edge-tts/`（**新增 Host 包**）<br>`packages/bundle/web-app/cordis.patch.yml` + `package.json` | **Edge TTS 迁到 0.1.5 Connection Fetch 路由**：`POST /api/edge-tts` + `GET /api/voice?voiceId=`。收流超时 **12s** + 自动重试 **最多 3 次**。**回合末自动语音回复**：监听 `session/event` `assistant/message`+`turn/end(completed|max-tokens)` → 多引擎合成（auto=小米→edge）→ 落盘 objects 池 → `session.append('voice/reply')`。`DSH_VOICE_REPLY=0` 可关。官方无等价内置 | 旧 apiproxy voice.tts/sendVoiceMessage 删除；TTS 路由 + 回合末回复都挂 edge-tts 包 | ✅ **0.1.5 已迁移**（待重启/浏览器验） |
> | 46 | `client/ui-chat/`：`VoiceCard.tsx`、`VoiceReplyNodeView.tsx`、`conversation-nodes/voice-reply.ts`、`ImageReplyNodeView.tsx`、`conversation-nodes/image-reply.ts`、`ChatNodeSeat`/`ChatView`/`apply` 的 `loadVoice`、locale 语音文案 | **语音/图片消息 UI 迁到 0.1.5 ui-chat 架构**：voice-reply / image-reply 会话节点 + 键控渲染器；VoiceCard 微信式互斥播放；`loadVoice` 走 `GET /api/voice`。官方无等价语音气泡/图片回复横条 | 旧 ui-conversation/chat 被官方拆到 ui-chat，ChatNodeDataMap 与 slots 重写后需按新契约重挂 | ✅ **0.1.5 已迁移**（待重启/浏览器验） |
> | 47 | `packages/host/balance/`（**新增 Host 包**）+ 插件 `dsh-input-tools/lib/client.js` | **balance.get RPC → `GET /api/balance?sessionId=`**：DeepSeek / henry-gao GW（含 `/health`）/ volc-ark 套餐配额，按会话 modelSelection 分流；BalanceMeter 改 fetch 该路径；**全 null 显示「不适用」**（不画 0）。官方无等价余额指示 | 旧 apiproxy 删除后 balance RPC 消失；Connection Fetch 与 session.export 同模式 | ✅ **0.1.5 已迁移** |
> | 48 | `llm-pi-ai/src/index.ts` `directoryEntries` 顺序<br>`ui-settings-models/src/client/store.ts` configured 判定 | **恢复 gw 等自定义直连在模型配置中的可见性**：① 目录先列已配置 profile（Henry/Litellm/Ark），再列未用 catalog；② configured 同时看 effective `value` 与 user 层路径，避免手写 settings.yaml 被判未配置 | 0.1.5 扩大 catalog 后 Henry 被淹没；user 层路径可能不在 value 里导致行不进 configured 列表 | ✅ **0.1.5 已迁移**（待重启/浏览器验） |
> | 49 | `session-format-v0-to-v1/src/dispositions.ts` + `payload-validation.ts` | **解封旧会话 v0→v1 迁移**：把 fork 自定义 `image/reply`、`voice/reply` 加入 RELEASED_V0_EVENT_DISPOSITIONS 与 payload 语义校验；raw log 不动。样例会话 5280b2bf 自测 MIGRATION_OK（image/reply=1） | 0.1.5 迁移拒绝未知历史事件类型，含图片回复的历史会话全部打不开 | ✅ **0.1.5 已迁移**（待重启验） |
> | 50 | 插件 `plugins/dsh-input-tools/lib/host-files.js`（源=插件仓库外路径）<br>`profiles/web/cordis.patch.yml` 摘除 `@anoslide/dsh-host-files` | **dsh-host-files 四项能力收编**：① `global-persona.md` → systemPrompt order1 实时读 ② `mcp-servers.json` 启动挂载 + 运行时增删（挂载异步不堵 HTTP）③ Skill 开关/删除 ④ 文件 API 仅 **list/read/write/search**（git/highlight/mkdir 等砍掉）。vscode-layout 布局正式放弃 | 魔改布局 0.1.5 不兼容；host-files 依赖链/维护成本高 | ✅ **0.1.5 已迁移**（待重启验） |
> | 51 | `client/connection/src/browser-auth.ts`<br>`connection/tsdown.config.ts` `hostPhase: true` | **固定 Web 登录 token**：设环境变量 `DSH_WEB_TOKEN`（≥16 字符）后，登录 URL 跨重启不变；未设则仍随机。**不破坏 trust 栅栏**。配置见下「固定 token 用法」 | 每次重启 token 变导致 tailscale 收藏链接失效 | ✅ **0.1.5 已迁移** |
> | 52 | 插件 `dsh-input-tools/lib/{client,index}.js` | **三修 UX 回归**：① 选图预览——兼容官方 `onAddFiles` 改名，draft 图进预览墙；② 工具条——CSS order 把图片/录音提到最左；③ ASR——ffmpeg 多路径探测 + 空文本诊断日志 + `sendAsVoice` 无 0.1.5 API 时干净降级 ASR | 0.1.5 槽 props 改名/工具条布局/ASR 空转 | ✅ **0.1.5 已迁移** |
> | 53 | 插件 `dsh-input-tools/lib/{client,index}.js` + `api/session-controller/src/commands.ts` + `ui-settings-models/src/client/welcome-store.ts` | **UX3 二轮**：① ASR——`readJsonBody` 拒收 multipart，只收 JSON `{audioBase64}`（杜绝把边界串丢给 18790）；② 发图——session/prompt 准入移除 `MODEL_DOES_NOT_SUPPORT_IMAGES`，图走 path 桥接；③ 工具条——挂载后 DOM 前移到 tools 首位（不依赖 CSS Modules 哈希）；④ 内测声明——ack 写 `localStorage['dsh.welcomeNoticeAck']`，memory/远程 origin 刷新不弹 | 0.1.5 准入/远程 settings memory/哈希类名 CSS order 失效 | ✅ **0.1.5 已迁移**（待重启验） |
> | 54 | `packages/llm/llm-deepseek/src/serialize.ts`（+ 重建 `lib/`） | **图片路径修复**：`imageAsText` 不再拼 `hex.jpg/png`，改为与 store 一致的**无扩展名** `objects/<2>/<64hex>`；`DSH_HOME` 缺失时回落 `USERPROFILE/.dsh`。已 `tsc -b` + tsdown 重建 llm-deepseek | 0.1.5 后 attachment-local **无扩展名硬链接别名**，serialize 带后缀路径 → look_image `readFile` ENOENT「找不到图片」；实测 objects 下文件均为无后缀内容寻址名 | ✅ commit `881f5e9a90` |
> | 55 | 插件 `dsh-input-tools/lib/client.js`（无独立 git，记本表） | **工具条顺序（DOM 插入位，非 CSS）**：0.1.5 官方 `.tools` 为 `+ \| 📎 \| file \| .modes(完全权限) \| left(插件)`。CSS order 打不动插槽渲染 → **MutationObserver 把 `[data-composer-left]` 插到 `.modes` 之前**（rAF 节流）。目标：**图片/录音在完全权限左侧**；📎 保留。浏览器 **Ctrl+F5** | CSS 在 0.1.5 无效（实测强刷顺序不变） | ✅ 插件已改，待浏览器验证 |
> | 56 | `llm/llm-pi-ai/src/config.ts` `src/adapter.ts` | **模型选择器只剩当前模型**：`resolveProfiles` 落盘 `serviceableModels`；`listModels` 优先读它，不再依赖 `piProvider.getModels()`（构造失败时曾返回空数组被 catalog filter 掉）→ litellm/volc-ark/qwen/gw 全部 advisory 列表可见 | 0.1.5 后 selector 只剩 GwV4F 的主因之一；bare 模型 id 靠 defaultContextWindow 已可解析（探针实测 4 provider 全过） | ✅ catalog+adapter 单测 120 过；**dsh-web 需重启**后 UI 生效；litellm 一轮对话待你重启后点验 |
> | 57 | `client/ui-settings/src/client/index.ts`<br>`client/ui-settings-general/src/client/index.ts` | **放开远程（非 loopback）settings 读写**：官方 persistence 门 `isLoopback ? 'host' : 'memory'` 强制远程 memory → 设置页模型分区报「加载提供方目录失败: settings are unavailable in this browser」。本地 fork 改为恒 `'host'`；general 包文档控制器同样不再按 loopback 省略。host 端无二次拦截（describe 打码 secret 字段，providers 配置不受影响） | 内网自用 + token 鉴权，手机也要管理模型/提供方 | ✅ tsc -b + tsdown ×2 + build:web 全绿；dsh-web 重启后本机 playwright 验证设置页 5 提供方正常；**手机端待老大刷新点验** |
> | 58 | `packages/host/balance/src/index.ts` `providerOfSession` | **gw 余额分流修复**：0.1.5 modelSelection 投影里 `pending` 只在「选了还没发请求」时非空，`request/header` 发出即清 null——旧实现只读 `pending.provider`，发过一条消息就 undefined 落回官方余额。照 `agent.selectionFor` 官方语义补回落：`pending.provider` → 会话日志最后一次 `requestHeader().config.provider` | 监督员指「state.pending.provider 形状假设不成立」；对照 model-selection-projection.ts 确认是生命周期语义而非形状 | ✅ host tsc -b + 全量 tsdown 绿；重启后 playwright 打开 GwV4F 会话实测 UI 显示 gw 余额 ¥73.52（原 ¥0.93 官方值） |
> | 59 | 插件 `dsh-input-tools/lib/client.js`（新增 PersonaSection/McpSection/SkillsSection） | **设置页三个管理分区**：全局人设（textarea 直编 `~/.dsh/global-persona.md`，POST 保存）、MCP 服务器（列表 + ON/OFF 挂载开关 + 删除 + stdio/http 添加表单）、Skill 管理（列表 + 启停 `.disabled` + 删除）。全部走 host-files 已有端点（`/vscode-files/persona|/mcp|/skills`），settings.section 槽 order 6/7/8 | 0.1.5 放弃 vscode-layout 后三个管理 UI 无处安放；host 端点收编后 client 缺失 | ✅ `node --check` + playwright 实测：侧栏三分区出现，persona 加载 6180 字符真实人设、MCP 4 server、Skill 8 目录全渲染 |
> | 60 | `api/session-controller/types.ts` + `attachment/{attachment,attachment-local}` + `llm/llm-pi-ai/context.ts` + 插件 `client.js`/`index.js` | **用户语音端到端恢复（0.1.5 全断链重接）**：① `PromptContentPart`/admission 加 voice 引用块（sha256 对象池地址+transcript，同 pre-merge apiproxy/voice.ts 形态）② 插件 save 端点同步落共享对象池 ③ 客户端 save→ASR→带转写直发（不再降级文本）④ **llm-pi-ai 两处 voice 转文本**（`userContent` 有图路径 + `textOnlyContext` 无图路径，后者才是 gw/ark/litellm 的实际路径——flattenText 曾静默丢 voice 块）⑤ 官方 VoiceCard 渲染用户横幅（MessageItem 抄 pre-merge：voices 独立数组+voiceLoader 必传）⑥ durationMs 毫秒+全局 play 互斥 | 0.1.5 迁移丢失 voice 准入/adapter 降级，语音只剩 ASR 文本一条路 | ✅ e2e：录音→横幅（转写+复制+秒数）→AI 原文引用「识别内容」→自动语音回复，全绿；单测 `toPiContext` voice 输出断言通过 |
> | 61 | `examples/agent-spine-demo/package.json` + `pnpm-lock.yaml` + `llm/{llm-deepseek/src/serialize.ts, llm-pi-ai/src/context.ts}` + `client/ui-chat/ReasoningRow.tsx` + 4 个 spec | **0.1.5 验收批次修复（2026-09-11）**：① agent-spine-demo 删悬空依赖 `@deepseek-ai/node-addon-landlock-run`（上游已删，恢复的旧 package.json 引用致 `pnpm install` 全局失败），lockfile 补齐三个恢复包 importer 段；② voice 块无转写时的 home 解析改回落链 DSH_HOME→USERPROFILE→HOME（llm-deepseek `voiceAsText` 换用 `resolveDshHome`，llm-pi-ai `voiceBlockText` 新增同名 helper），修 DSH_HOME 缺失时输出 `(unknown)` 致 ASR 无目标；③ ui-chat `ReasoningRow` 抄回 pre-merge 的流式滚动跟随 effect + bodyRef（0.1.5 迁移丢失，think 展开体不钉底）；④ session-format-v0-to-v1 校验清单补 `image/reply`+`voice/reply` fixture（53 项对齐，9-10 解封遗漏）；⑤ 4 处过时断言更新：session-models 图片放行后接受+followup×2、ui-chat「已复制」「思考」文案、welcome-notice afterEach 清 localStorage（f03d8fad76 兜底跨用例泄漏） | 0.1.5 全量测试基线（20879 项）首扫 34 文件 68 败：本地修复类全清，余为环境/目录账本类另册跟踪 | ✅ 受影响包 13 个测试文件全绿；llm 两包重建部署，dsh-web 重启 401 正常 |
> | 62 | `acp/acp/lib/index.js`（**仅产物，src 未改**）`AcpSession.create` | **session/new 的 Agent compose 加 deadline**：`ctx.agents.create(...)` 改为先取 promise 再 `Promise.race` 一个超时（默认 90s，env `DSH_ACP_SESSION_SETUP_TIMEOUT_MS` 覆盖，0/非数字=不设限），超时抛错并由 SDK 投影成 JSON-RPC `-32603`；迟到的 compose 用 `late.dispose()` 回收，避免注册表里留孤儿 Agent | 起因是 2026-09-15 dsh 飞书 bot「发消息石沉大海」事故排查。⚠️ 但**该次事故的直接原因不是这里**：探针实测 provider 未注册时 harness 本就秒回 `-32603 no adapter registered`，并非永久悬空。本补丁是针对「某个 awaited service 请求没有 responder → promise 永不 settle → 客户端永等且 stderr 零字节」这一类**未被证伪也无法穷尽证明不存在**的形态做的纵深防御 | ✅ `node --check` 过；坏 provider 探针得 `-32603`；dsh bot 端到端无回归（`session/new OK`→`prompt sent`→`commit chunk`，15s 回话）。⚠️ **勿重建 acp 包**：#23 的本地功能（流式思考→`agent_thought_chunk`、工具事件→`tool_call`）**只存在于本 lib 产物**，`src/index.ts` 里搜不到任何指纹，`pnpm run build` 会连它一起抹掉；要改行为只能继续直改 lib 并在此登记 |
> | 63 | `client/connection/src/client/index.ts`<br>产物 `packages/client/connection/lib/client.js`（**gitignored，必须同步改**）`watchBrowserNetwork` | **页面回到前台即换一代连接**：新增 `visibilitychange` 监听，`visibilityState === 'visible'` 时 `controller.reconnect()`，dispose 里对称摘除 | 手机端切后台/锁屏常常直接掐掉 WebSocket 却**不派发 online/offline**，且 `navigator.onLine` 仍报 true ⇒ generation 看着健康而 socket 已半开，running turn 的收尾帧永久丢失，界面一直停在「深度求索中」，直到用户手动刷新（= 重建连接并重拉 baseline）。回前台换代只花一个 RTT，等价于替用户点那次刷新 | ✅ tsc（client face）零类型错误 + `node --check` 过。**线上实测**：`GET /plugins/??@deepseek-ai/dsh-client-connection/client.js&rev=25620401cf3c` → 200 / len 222771 / 含 `visibilitychange` 与 `controller.reconnect()`。`apps/web/dist` 37 个 js 全扫**无**此代码 ⇒ 唯一承载处是 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-connection/lib/client.js`，且它与 workspace 那份是**同一物理文件**（链接），故**无需 build:web、无需重启 dsh-web**；`frontend-static` 走 `readFile` 现读 + `no-store`，刷新页面即取新码。⚠️ **未经真机验证**：若 iOS/Android 把整页 JS 冻结（回调压根不执行），本补丁不生效，需另加服务端 running 位 TTL 兜底 |
> > **固定 token 用法（任务 B）**：在 nssm 服务环境加 `DSH_WEB_TOKEN=<你的固定串≥16字符>`（与现有 PATH 等整值合并写入 AppEnvironmentExtra），重启后打印的 URL 固定。未配置则保持随机 process token。勿把 token 提交公开仓库。
> > ⚠️ 注：**这套体验只能在本项目代码上成立**——官方主线面向官方云模型，不会也不该接受这些改动（图片序列化、语音全链路、余额、事件类型、前端渲染层，跨 10+ 包、30+ 个文件）。插件 `dsh-input-tools` 源码即 `lib/client.js` + `lib/host-files.js`（无独立 src 仓库），备份时整包拷贝 `C:\D\opt\deepseek-harness\plugins\dsh-input-tools`。
> | 64 | 全仓（合并 `upstream/master`，809 commits / 0.1.6-alpha.1 之后）<br>`packages/llm/llm-deepseek/src/adapter.ts`<br>`packages/acp/acp/src/session.ts`<br>6 个命令/设置相关 spec + 2 处语音 CSS | **升级到上游 809 commits 后保住本地自定义**：① deepseek adapter 取上游门面重构（protocols/chat-completions 与 messages 分流），本地 `textImageHandling` 钩子改为按协议生效（chat-completions 跳过 sha 投影走本地 `imagesAsText`；messages 保留官方投影，否则文本模型抛 UNSUPPORTED_CONTENT）；② 上游已原生实现 ACP 流式思考与 `tool_call` 推送，本地 #23 产物补丁退役；#62（session/new compose 截止时间）无副本可恢复，**改在 src/session.ts 重新实现**，此后随源码走；③ `LlmFailure` 取并集（本地 `details` + 上游 `offloadImages`）；④ 语音按钮 `.voicePlay/.voiceDot` 补 `corner-shape: round`，满足上游新增的全圆角配对门禁；⑤ 本地中文化的 6 个 spec 断言同步回中文（command-goal/permission-presets/plan-mode/session-log-export/shipped-composition），其中大部分在升级前就已因断言未同步而红灯；⑥ 重建产物（host+client+web）后 dsh-web 重启 | 上游把「文本模型不能用图」的官方语义从「摘要占位」升级为可带路径的 handle 文本；我们 `content.ts` 的 `textOnlyImageText` 补丁（含 look_image 路径）经 auto-merge 存活，图片/语音/余额/中文化/Windows 修复全部保留（审计：升级前本地改动 137 文件，升级后仍与上游不同 136 文件，丢失的 3 个是旧路径迁移、e2e 的上游补全、以及被删的 pwsh 调试日志） | ✅ 合并+构建+推送全绿；实测：ASR/TTS 闭环（TTS 合成→ASR 识别回中文原文）、图片对象池路径与 serialize 拼法一致、`/api/balance` 返回含 `gatewayHealthy`/`usage` 字段、gw 网关 `/health` ready + `/v1/balance` 200、edge-tts 产出真实 MP3、`/voice-config` 与 `/vscode-files/*` 三端点 200、acp 产物含截止时间补丁、固定 token URL 跨重启不变。⚠️ 真机 UI 视觉与 web e2e 部分用例在本机跑不完（详见下方「已知限制」） |
> > **已知限制（本次升级后如实登记）**：① `apps/web` 的真浏览器 e2e 在本机 headless chromium 下，dsh-web 首页会让渲染器崩溃（空白页/静态文件正常，拦掉任一插件 bundle 仍崩；日志有 `GPU state invalid` 与 `Renderer` crash），因此 lifecycle-chrome / queue-image / feedback-command 等文件跑不完；`shipped-composition.e2e.ts` 能跑，其 4 处红灯中 2 处已修（`codes` 快照 + `/permission` 中文回执），余下 2 处是 Windows 平台固有：`packages/bundle/base` 按 `process.platform === 'win32'` 不挂 `bash` 只挂 `pwsh`，而上游该用例断言 bash 存在（上游 CI 跑 Linux）。② `packages/llm/llm-retry` 的「拒绝连接应判 TRANSPORT」用例在本机稳定失败（TIMEOUT），已用纯上游源码 A/B 确认**不是本地改动引起**。③ pwsh 子进程类用例在本机超时（pwsh 冷启动实测 4.6s，而用例默认 5s）。④ 飞书 dsh bot 进程仍持有升级前代码，重启后才吃到本次产物（dsh-web 已重启）。
> | 65 | 全仓（合并 `upstream/master` **882 commits** / dsh-v0.1.6-alpha.2 一带，2026-09-21）<br>`packages/host/webserver/src/index.ts`（schema）<br>`packages/bundle/web-app/src/startup.ts`（CLI host 校验）<br>`packages/client/ui-chat/src/client/chat/{ReasoningRow,ChatView}.tsx`<br>`packages/client/ui-sidebar-documentpreview/**`（contract/registry/store/TextPreview）<br>profile `~/.dsh/profiles/web/cordis.patch.yml` + nssm AppParameters<br>插件仓 `@oadank/dsh-input-tools` 另表（openmem 87ee8d96） | **升级到上游 882 commits 且只保留一个 master 主分支**：① 冲突 9 处按本表核对——ReasoningRow=本地流式钉底 bodyRef + 上游 MarkdownText；ChatView=保留 `loadVoice` + 上游 MarkdownDelegateProvider/openExternalLink；documentpreview=**上游 renderer/office 与本地 stream 模式类型并集**（DocumentContent 含 renderer+stream，DocumentLoadMode += stream）；login.spec 维持本地删除；pnpm-lock 取上游+install。② **webserver.host schema 上游收紧为只准 `127.0.0.1\\|0.0.0.0`，禁止绑 tailscale IP → 本地放宽为任意 host 字符串**；`startup.ts` 删除对 `--host 0.0.0.0` 的 program.error；nssm 绑 `0.0.0.0` + trustedHosts（lecoo.tailb5f10f.ts.net / 100.108.133.82 / 127.0.0.1）——**老大明确要用 http://100.108.133.82:3080 直连，不迁就上游回退 127.0.0.1**。③ profile 插件挂载：`@oadank/*` 包名解析在新 resolution 下 failed to import → `cordis.patch.yml` insert 改**相对路径** `../node_modules/@oadank/<pkg>/lib/index.js`。④ 构建三件套缺一不可：`build:lib:host` + `build:lib:client` + **`build:web`**（只重建 lib 不刷外墙 → 浏览器报 `ui-conversation: failed`，后续 ui-chat/goal/plan/input-tools 全 pending 等 uiConversation）。⑤ typecheck/pre-push：ChatView 解构超 140 列要拆行；seat spec 对 content 联合类型需窄化（stream 无 data 字段） | 上游 882 大部 auto-merge；插件仓独立、官方 pull 碰不到 | ✅ master=`14ee794d65` 已推 origin，**本地/远程仅剩 master**（merge-upstream-* 已删）；tailscale `100.108.133.82:3080` 与 `127.0.0.1:3080` 双通；插件路由 `/optimize-*` `/voice-config` `/vscode-files/*` 200；⚡ 实测 DV4F ~4.5–6s、durationMs/queries 同源、冒号标签保留；`/api/balance` `/api/edge-tts` 返回 401（路由在、需浏览器会话鉴权，非丢失）；静态壳 `/assets/index-*.js` 616KB 正常 |

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
