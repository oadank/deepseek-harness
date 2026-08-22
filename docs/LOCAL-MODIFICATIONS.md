# 本地源码改造清单（LOCAL MODIFICATIONS）

> 本项目（oadank/deepseek-harness）是在官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）基础上的二次开发 fork。
> 本文档记录**所有改过官方源码的地方**：改了什么、为什么改、在哪个提交。
> 升级上游 / 排查问题 / 想了解"本项目到底改了什么"时，以本文档为准。

**一句话背景**：官方 dsh 对图片/语音只有一个态度——**模型支持就直接发，不支持就报错**。纯文本模型（如 deepseek-v4-flash）在官方版上根本用不了图片和语音。本项目在框架层改造，让**任何入口**的图片/语音都能被文本模型用插件工具识别，同时保留完整消息体验。

---

## 一、图片 / 视觉（"眼睛"）—— 纯文本模型也能发图识图

| 文件 | 改了什么 | 为什么改 |
|---|---|---|
| `packages/llm/llm-deepseek/src/serialize.ts` | `imageAsText()`：把 image 块转成「本地附件路径文本」（含提示词：请用 `mcp__visionqa__look` / `mcp__zai-vision__analyze_image` 识图，不要用 read_image） | 纯文本模型收不到 image 块，只能给路径文本，靠插件 look_image 工具识图 |
| `packages/llm/llm-pi-ai/src/context.ts` | 同样的 `imageAsText()` 策略（pi-ai adapter 输入不含 image 时生效） | 与 llm-deepseek 一致，任何入口的图都不丢 |
| `packages/llm/llm-deepseek/src/adapter.ts`、`packages/llm/llm-pi-ai/src/adapter.ts` | toPiContext 签名统一为本地 vision 版 | 配合 imageAsText 收尾 |
| `packages/attachment/attachment-local/src/store.ts` | 附件落盘时**补扩展名别名**（jpg/png 硬链接 + sharp 转 webp） | zai-vision 等工具按扩展名校验，无扩展名会拒绝 |
| `packages/host/apiproxy/src/api-proxy.ts` | **移除官方"模型不支持图片即拒绝切换/发送"的闸门** | 否则纯文本模型根本走不到识图那一步 |

**关键提交**：`818d89494f`（基线）、`055a00906b`（rc.8 重放）、`e8c3c226bd`（扩展名别名）、`415b30b533`（look_image 引导）、`69a1415191`（modlens 优先）

---

## 二、语音（"耳朵" + "嘴巴"）—— 录音输入 / TTS / 音色克隆 / AI 语音回复

### 2.1 Host 服务端
| 文件 | 改了什么 | 为什么改 |
|---|---|---|
| `packages/host/apiproxy/src/voice.ts` | 语音核心：录音落盘、ASR 转文本、TTS 六引擎（auto/小米/Edge/本地/阿里/克隆）、音色克隆、合成结果落盘 | 官方不认识"语音消息"，整条语音链路都是新增 |
| `packages/host/apiproxy/src/edge-tts.ts` | Edge TTS 引擎（微软免费） | 免费 TTS 引擎之一 |
| `packages/host/apiproxy/src/api-proxy.ts` | ①**语音三规则**：用户发过语音→自动 TTS 回复；用户要求发语音/指定服务商→自动合成；否则由 agent 自主决定（send_voice 工具）；②新增 `send_voice` 工具 | 让 AI 能主动发语音、且行为符合人设规则 |
| `packages/core/session/src/types.ts`、`known-event-types.ts` | 新增 `voice` / `reply` 会话事件类型 | 语音消息/语音回复要独立持久化 |

### 2.2 客户端 RPC
| 文件 | 改了什么 | 为什么改 |
|---|---|---|
| `packages/client/runtime/src/client/contract/session.ts`、`sessions/session.ts` | 新增 `sendVoiceMessage` RPC、voice/reply 事件进 SessionEventMap | 前端能发语音、能收语音事件 |

### 2.3 前端界面
| 文件 | 改了什么 | 为什么改 |
|---|---|---|
| `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx` | 输入框语音条（录音按钮/时长定宽/停止按钮 releaseFocus）、未识别提示、`voice-actions` slot | 录音入口 + 语音交互 |
| `packages/client/ui-conversation/src/client/chat/MessageItem.tsx`（+ .module.css） | 语音消息气泡：可点击播放、尾部复制转写文本 | 语音消息可视化 |
| `packages/client/ui-conversation/src/client/chat/TtsVoiceCard.tsx`（+ .module.css） | TTS 语音卡片 | AI 语音回复展示 |
| `packages/client/ui-conversation/src/client/chat/VoiceReplyNodeView.tsx`、`conversation-nodes/voice-reply.ts`、`register-node-renderers.ts`、`register.ts` | 新增 voice/reply 节点渲染器并注册 | 语音消息独立渲染 |
| `packages/client/ui-conversation/src/client/contract/slots.ts` | 新增 `voice-actions` 槽声明 | 给语音条扩展 UI 挂载点 |
| `packages/client/ui-conversation/src/client/apply.ts`、`locales.ts`、`service.ts`、`index.ts`、`ChatView.tsx`、`ChatNodeSeat.tsx`、`ReasoningRow.tsx`、`ConversationSession.tsx`（+ css） | 配套：节点注册、文案、布局 | 前端整体衔接语音功能 |

**关键提交**：`818d89494f`（基线）、`af54f5b67d`（语音三规则+send_voice）、`055a00906b`、`d931bb8ad7`（复制按钮/未识别提示/voice-actions slot）

---

## 三、余额显示（已改为插件提供）

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/host/apiproxy/src/api/balance.ts`、`balance.schema.ts` | **保留**（host 端 RPC） | 直连模型时查余额的接口 |
| `packages/client/ui-conversation/src/client/skeleton/BalanceMeter.tsx`（+ .module.css） | **已删除**（`e40bbaeb2c`） | 源码版余额组件改由插件 dsh-input-tools 提供显示 |

---

## 四、其他基础设施改动

| 文件 | 改了什么 | 为什么改 |
|---|---|---|
| `packages/subprocess/subprocess-local/src/spawn.ts`、`packages/shell/pwsh-local/src/index.ts` | 进程 kill 用 **taskkill 全路径兜底** | Windows 下杀子进程更稳 |
| `packages/acp/acp/src/index.ts` | ACP 扩展（~95 行） | 本地改造配套 |
| `packages/api/remotes/src/client/index.ts` | +1 行 | 配套 |
| `packages/client/connection/src/api-request-trust.ts`、`client/fixture.ts`、`client/index.ts` | trusted-host / fixture 扩展 | 远程部署信任域名 |
| `packages/host/directory-picker-auto/src/resolve.ts` | 目录选择自动解析 | 远程环境无原生弹窗 |
| `packages/host/apiproxy/src/api/sessions.schema.ts`、`sessions.ts` | 会话 RPC 扩展 | 配套 |
| `scripts/setup-service.ps1` | nssm 一键注册服务：自动查 node 路径 / 设 DSH_HOME / 配日志 / 组装 trusted-host / 探测 ffmpeg | 解决 LocalSystem 读不到用户 profile、语音 webm 转码失败等坑 |

**关键提交**：`d2b2ffca7c`（setup-service.ps1）、`c0449c4aaf`（ffmpeg 探测）、`818d89494f`、`af54f5b67d`

---

## 五、升级上游注意事项（升级 merge 时必看）

1. **图片路径文本提示词**：`serialize.ts` / `context.ts` 的 `imageAsText` 里写死了"用 visionqa__look / zai-vision__analyze_image 识图"——上游若改序列化逻辑，要同步。
2. **api-proxy 闸门**：上游若恢复"模型不支持图片即拒绝"，图片功能立刻失效。
3. **语音事件类型**：`types.ts` / `known-event-types.ts` 的 voice/reply 事件是新增的，上游合 session 类型时可能冲突。
4. **slots.ts 的 voice-actions**：上游合 slot 声明时可能冲突。
5. **测试同步**：大量 e2e 测试 / snapshots 因 props 结构变更同步改过（`UserMessageNodeViewProps` 等），升级时测试可能红。

## 附：改造提交速查

| 提交 | 内容 |
|---|---|
| `818d89494f` | 本地改造基线：语音全链路 + 图片识别 + 余额 + 界面优化（最大的一笔） |
| `af54f5b67d` | 语音三规则 + send_voice 工具 + taskkill 兜底 + 语音条 |
| `055a00906b` | rc.8 重放补丁：语音发送整理 / 余额 / vision 路径化细节 |
| `c149a83f7f` | pi-ai 收尾：toPiContext 签名统一 |
| `d931bb8ad7` | 语音条复制按钮 / 未识别提示 / voice-actions slot |
| `e8c3c226bd` | 附件扩展名别名（jpg/png/webp） |
| `415b30b533` / `69a1415191` | 图片识别引导改道 look_image / modlens |
| `e40bbaeb2c` / `1e420fcd39` | 删除源码 BalanceMeter、测试类型收窄 |
| `d2b2ffca7c` / `c0449c4aaf` | setup-service.ps1（nssm 一键注册 / ffmpeg 探测） |
