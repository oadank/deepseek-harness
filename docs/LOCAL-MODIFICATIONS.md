# 本地源码改造清单（LOCAL MODIFICATIONS）

> 本项目（oadank/deepseek-harness）基于官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）二次开发。
> 本文档的**唯一权威依据 = 本地 master 相对官方最新版（upstream/master = `dsh-0.1.1-rc.2`，`b150a551b8`）的**本地新增代码**差异**。
> 本地代码 = 官方最新版 + 本地 40 个独有提交（其中多数是 docs/README 和"同步插件/同步补丁"提交——后者只是把官方代码搬进本地，**不算本地改造**）。
> 真正"本地新增为主"的改造文件只有 **25 个**（本地新增 ≥20 行且新增 > 删除，排除 tests/i18n/构建产物）。
> 本机验证命令：
> ```bash
> git diff upstream/master master --numstat | grep packages/ | grep src/ \
>   | grep -v "tests/\|snapshots/\|\.d\.ts\|/lib/" \
>   | awk '$1+0>=20 && $1+0>$2+0' | sort -rn
> ```
> 升级上游 / 排查问题 / 想了解"本项目到底改了什么"时，以本文档 + 上述命令为准。

**一句话背景**：官方 dsh 对图片/语音只有"模型支持就直接发，不支持就报错"的态度。本项目在框架层改造，让**纯文本模型**（如 deepseek-v4-flash）也能用图片（转路径文本 + 插件 look_image 识图）和语音（ASR/TTS 全链路），同时保留完整消息体验。

---

## 一、图片 / 视觉（"眼睛"）—— 纯文本模型也能发图识图

**核心思路**：官方 `serialize.ts` 原来遇图片直接 `assertTextOnly` 抛 `UNSUPPORTED_CONTENT` 拒绝。本地改造替换为 `imageAsText()`——把 image 块转成「本地附件路径文本」，模型拿到路径后调插件自研 **look_image** 工具识图。

| 文件 | 改动 | 为什么 |
|---|---|---|
| `packages/llm/llm-deepseek/src/serialize.ts` | 删 `assertTextOnly`，加 `imageAsText`（image 块 → 路径文本，提示词引导 look_image：describe/reverse/text 三模式） | 纯文本模型收不到 image 块，只能给路径让插件识图 |
| `packages/llm/llm-pi-ai/src/context.ts` | 同样的 `imageAsText` 策略 | 与 llm-deepseek 一致，任何入口的图都不丢 |
| `packages/llm/llm-deepseek/src/adapter.ts`、`packages/llm/llm-pi-ai/src/adapter.ts` | 适配 imageAsText 收尾（toPiContext 签名统一） | 配套 |
| `packages/attachment/attachment-local/src/store.ts` | 内容寻址对象（sha256 无扩展名）补**扩展名别名**（jpeg→.jpg / png→.png 硬链接零拷贝；webp 用 sharp 转 png） | 官方存储是 sha256 内容寻址**无扩展名**（源头设计，无法直接带扩展名）；路径文本要带扩展名，所以存储侧必须补别名，look_image 按 `image_path` readFile 才能读到物理文件 |
| `packages/attachment/attachment/src/error.ts` | +1 行 | 配套 |
| `packages/host/apiproxy/src/api-proxy.ts` | 图片准入逻辑调整（官方 rc.8 已有 `admitEncodedImages`，本地在其基础上兼容路径文本场景） | 保证图片能进消息流 |

> 📌 **关于"源头为什么不直接带扩展名"**：官方附件存储是 **sha256 内容寻址**（`DSH_HOME/attachments/v1/objects/<hex>`，无扩展名），这是官方设计。本地改造无法改源头，只能：序列化时拼扩展名 + 存储时补硬链接别名，两者配套。look_image（runVision）是 `readFile` 直读，**本身不校验扩展名**，但路径必须指向真实存在的文件，所以别名仍是必需的。

---

## 二、语音（"耳朵" + "嘴巴"）

> ⚠️ **能力层已在插件**（api-proxy 第 1494 行注释为证："语音能力已迁移至插件 @anoslide/dsh-host-voice"）：
> `send_voice` 工具、turn/end 自动语音回复（三规则）、TTS 引擎、ASR、音色克隆——**全部在插件 dsh-input-tools**，源码 api-proxy 里三规则代码已删除（`userSpokeVoice`/`语音铁律` 零匹配）。
> 源码保留的只有**插件替代不了的管道层**：

### 2.1 源码 = 底层管道（插件调用的基础设施）
| 文件 | 改动 | 为什么必须留源码 |
|---|---|---|
| `packages/host/apiproxy/src/voice.ts` | 新增 506 行：语音对象落盘（sha256 内容寻址）、转 WAV 调本地 sherpa-onnx ASR、TTS 合成、`voiceAsr`/`voiceTts` 编辑器 RPC | 语音消息的**存储/转写管道**，浏览器录音落盘、消息持久化都在这一层，插件只能调 RPC 不能用 |
| `packages/host/apiproxy/src/api/balance.ts`、`balance.schema.ts` | 新增余额查询 RPC（DeepSeek 直连 `/user/balance`，5 秒缓存） | **插件余额显示调的就是它**（`connection.api.balance.get`），不是重复实现 |
| `packages/host/apiproxy/src/api-proxy.ts` | 余额 RPC 接入 + `voiceAsr`/`voiceTts` RPC + 图片准入配套 | 注：语音三规则已迁插件，本文件的语音部分只剩 RPC 管道 |
| `packages/host/apiproxy/src/api/sessions.ts`、`sessions.schema.ts`、`rpc-map.ts`、`index.ts` | 会话 RPC 扩展 | 配套 |
| `packages/core/session/src/types.ts`、`known-event-types.ts` | 新增 `voice`/`reply` 会话事件类型 | 会话事件类型是框架契约，插件 append 事件必须用它 |
| `packages/llm/llm/src/types.ts` | +24 行（voice 内容块类型） | 消息内容块类型，插件改不了 |

### 2.2 客户端 RPC
| 文件 | 改动 | 为什么必须留源码 |
|---|---|---|
| `packages/client/runtime/src/client/contract/session.ts`、`sessions/session.ts` | `sendVoiceMessage` RPC、voice/reply 事件进 SessionEventMap | 前端收语音事件的通道，插件 client 靠它 |
| `packages/client/connection/src/client/api.ts`、`index.ts`、`fixture.ts`、`api-request-trust.ts` | RPC 面扩展 / trusted-host | 配套 |

### 2.3 前端渲染层（历史遗留，可评估是否插件化）
> 输入框**按钮层已插件化**（InputBar 注释为证）。以下是**消息渲染层**——语音消息要在官方消息流里显示成气泡/卡片，需在渲染树注册节点，插件挂 UI 可以、改渲染树有风险，故留在源码：

| 文件 | 改动 |
|---|---|
| `packages/client/ui-conversation/src/client/chat/MessageItem.tsx` | +278 行：语音消息气泡（播放/复制转写/互斥） |
| `packages/client/ui-conversation/src/client/chat/TtsVoiceCard.tsx` | 新增 67 行：AI 语音回复卡片 |
| `packages/client/ui-conversation/src/client/chat/VoiceReplyNodeView.tsx` | 新增 20 行 |
| `packages/client/ui-conversation/src/client/conversation-nodes/voice-reply.ts`、`register-node-renderers.ts`、`register.ts` | 注册 voice/reply 节点渲染器 |
| `packages/client/ui-conversation/src/client/contract/slots.ts` | voice-actions 槽（+92 行） |
| `packages/client/ui-conversation/src/client/apply.ts`、`service.ts`、`locales.ts`、`index.ts` | 配套：节点注册、文案 |
| `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx` | 仅 releaseFocus + 取消自动聚焦（按钮 UI 已插件化） |

---

## 三、其他基础设施改动

| 文件 | 改动 | 为什么 |
|---|---|---|
| `packages/subprocess/subprocess-local/src/spawn.ts`、`packages/shell/pwsh-local/src/index.ts` | 进程 kill 用 taskkill 全路径兜底 | Windows 下杀子进程更稳 |
| `packages/acp/acp/src/index.ts` | ACP 扩展（+95 行） | 本地改造配套 |
| `packages/api/remotes/src/client/index.ts` | +1 行 | 配套 |
| `packages/host/directory-picker-auto/src/resolve.ts` | 目录选择自动解析 | 远程环境无原生弹窗 |
| `packages/compaction/command-compact/src/index.ts`、`feedback/command-feedback/src/index.ts`、`goal/command-goal/src/index.ts`、`plan/plan-mode/src/index.ts`、`session-query/session-log-export/src/index.ts`、`interaction/permission-presets/src/index.ts` | 各 10~60 行小改 | 与语音/图片事件配套 |

---

## 四、升级上游注意事项（升级 merge 时必看）

1. **serialize.ts / context.ts 的 imageAsText**：上游若恢复 `assertTextOnly`（遇图拒绝），图片功能立即失效。合并时重点看这两个文件。
2. **api-proxy.ts**：+413 行是最大改动点（语音三规则 + send_voice + 余额），上游合 host 逻辑时冲突概率最高。
3. **voice.ts / edge-tts.ts**：纯新增文件，上游若无同名文件，直接保留。
4. **session 事件类型**：`types.ts` / `known-event-types.ts` 的 voice/reply 事件是新增，上游合类型时可能冲突。
5. **slots.ts 的 voice-actions**：上游合 slot 声明时可能冲突。
6. **测试同步**：大量 e2e 测试 / snapshots 因 props 结构变更同步改过，升级时测试可能红。

## 附：真实改造文件清单（25 个源码文件，本地新增为主）

| 新增行 | 文件 | 归属 |
|---|---|---|
| +506 | `host/apiproxy/src/voice.ts` | 语音核心（新增文件） |
| +378 | `host/apiproxy/src/api-proxy.ts` | 语音三规则 + send_voice + 余额接入 |
| +270 | `ui-conversation/src/client/chat/MessageItem.tsx` | 语音消息气泡 |
| +119 | `host/apiproxy/src/edge-tts.ts` | Edge TTS 引擎（新增文件） |
| +108 | `llm/llm-deepseek/src/serialize.ts` | 图片→路径文本（imageAsText） |
| +94 | `acp/acp/src/index.ts` | ACP 扩展 |
| +92 | `ui-conversation/src/client/contract/slots.ts` | voice-actions 槽 |
| +79 | `ui-conversation/src/client/conversation-nodes/voice-reply.ts` | 语音回复节点（新增文件） |
| +72 | `host/apiproxy/src/api/sessions.schema.ts` | 会话 RPC schema |
| +71 | `ui-conversation/src/client/service.ts` | 前端服务扩展 |
| +67 | `ui-conversation/src/client/chat/TtsVoiceCard.tsx` | AI 语音卡片（新增文件） |
| +61 | `host/apiproxy/src/api/sessions.ts` | 会话 RPC |
| +53 | `ui-conversation/src/client/apply.ts` | 槽注册 |
| +43 | `client/connection/src/client/fixture.ts` | 测试 fixture |
| +40 | `ui-conversation/src/client/locales.ts` | 前端文案 |
| +37 | `client/modules/src/index.ts` | 模块注册 |
| +32 | `host/apiproxy/src/api/balance.ts` | 余额 RPC（新增文件） |
| +30 | `host/apiproxy/src/api/balance.schema.ts` | 余额 RPC schema（新增文件） |
| +28 | `ui-conversation/src/client/conversation-nodes/turn-error.ts` | 配套 |
| +25 | `host/apiproxy/src/fetch/client.ts` | 配套 |
| +24 | `llm/llm/src/types.ts` | voice 内容块类型 |
| +23 | `client/runtime/src/client/sessions/session.ts` | sendVoiceMessage RPC |
| +20 | `llm/llm-pi-ai/src/catalog.ts` | 模型目录 |
| +20 | `ui-conversation/src/client/chat/VoiceReplyNodeView.tsx` | 语音回复渲染（新增文件） |
| +20 | `client/ui-theme/src/boot-theme.ts` | 主题配套 |

> 另有关联小改（本地新增 <20 行）：`attachment-local/store.ts`（扩展名别名）、`llm-pi-ai/context.ts` + `adapter.ts`（imageAsText 配套）、`llm-deepseek/adapter.ts`、`core/session/{types,known-event-types}.ts`、`client/runtime/contract/session.ts`、`connection/api-request-trust.ts`、`subprocess/spawn.ts`、`shell/pwsh-local` 等。
> 注：`BalanceMeter.tsx` 已删除（余额显示改由插件提供），不计入。
