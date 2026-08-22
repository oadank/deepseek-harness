# 本地源码改造清单（LOCAL MODIFICATIONS）

> 本项目（oadank/deepseek-harness）基于官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）二次开发。
> 本文档的**唯一权威依据 = 本地 master 相对官方最新版（upstream/master = `dsh-0.1.1-rc.2`，`b150a551b8`）的独有提交改动**。
> 本地代码 = 官方最新版 + 本地 40 个独有提交（其中含"同步补丁"类提交，把官方最新代码同步进来后再做本地改造）。
> 本机验证命令：`git log master --not upstream/master --name-only`（排除 tests/i18n/构建产物后共 **62 个源码文件**）。
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

## 二、语音（"耳朵" + "嘴巴"）—— 录音输入 / TTS / 音色克隆 / AI 语音回复

### 2.1 Host 服务端（新增最多）
| 文件 | 改动 | 为什么 |
|---|---|---|
| `packages/host/apiproxy/src/voice.ts` | **新增 506 行**：语音对象落盘（与附件同池 sha256 寻址）、转 WAV 调本地 sherpa-onnx ASR 转写、TTS 合成、转写失败不阻塞消息 | 官方不认识"语音消息"，整条语音链路都是新增 |
| `packages/host/apiproxy/src/edge-tts.ts` | **新增 119 行**：Edge TTS 引擎（微软免费） | 免费 TTS 引擎之一 |
| `packages/host/apiproxy/src/api-proxy.ts` | **+413 行**：①语音三规则（用户发过语音→自动 TTS 回复；用户要求/指定服务商→自动合成；否则 agent 自主决定 send_voice）；②`send_voice` 工具；③余额 RPC 接入；④图片准入配套 | 让 AI 能主动发语音、行为符合人设规则 |
| `packages/host/apiproxy/src/api/balance.ts`、`balance.schema.ts` | 新增余额查询 RPC（DeepSeek 直连 `/user/balance`，5 秒缓存，失败返回 null 不报错） | 直连模型显示余额 |
| `packages/host/apiproxy/src/api/sessions.ts`、`sessions.schema.ts` | 会话 RPC 扩展（+72/+61 行） | 配套 |
| `packages/host/apiproxy/src/api/index.ts`、`rpc-map.ts` | 注册 balance/sessions RPC | 配套 |
| `packages/host/apiproxy/src/fetch/client.ts`、`handler.ts`、`index.ts` | 配套 | 配套 |
| `packages/host/apiproxy/package.json` | 依赖变更 | 配套 |
| `packages/core/session/src/types.ts`、`known-event-types.ts` | 新增 `voice` / `reply` 会话事件类型 | 语音消息/语音回复独立持久化 |
| `packages/llm/llm/src/types.ts` | +24 行（voice 相关内容块类型） | 配套 |

### 2.2 客户端 RPC
| 文件 | 改动 | 为什么 |
|---|---|---|
| `packages/client/runtime/src/client/contract/session.ts`、`sessions/session.ts` | `sendVoiceMessage` RPC、voice/reply 事件进 SessionEventMap | 前端能发语音、收语音事件 |
| `packages/client/connection/src/client/api.ts`、`index.ts`、`fixture.ts`、`api-request-trust.ts` | RPC 面扩展 / trusted-host | 配套 |

### 2.3 前端：**按钮层已插件化，消息渲染层在源码**
> ⚠️ **重要实况（2026-08-22 核对）**：输入框的 **图片/语音/余额按钮已全部迁移至插件** `@oadank/dsh-client-composer`（InputBar.tsx 顶部注释为证："源码 InputBar 不再持有图片/语音 UI"）。但**聊天消息渲染层仍在源码**（diff 为证）。

| 文件 | 改动 | 为什么 |
|---|---|---|
| `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx` | 仅保留：取消"切会话/挂载自动聚焦"、语音按钮按下 releaseFocus（移动端不弹输入法） | 按钮 UI 已插件化，源码只留焦点/交互细节 |
| `packages/client/ui-conversation/src/client/chat/MessageItem.tsx` | **+278 行**：语音消息气泡（可点击播放、尾部复制转写）、微信式语音互斥（同时只播一条）、录音互斥 | 语音消息可视化 |
| `packages/client/ui-conversation/src/client/chat/TtsVoiceCard.tsx` | **新增 67 行**：AI 语音回复卡片（base64 转 Blob 播放） | 语音回复展示 |
| `packages/client/ui-conversation/src/client/chat/VoiceReplyNodeView.tsx` | 新增 20 行 | 语音回复节点渲染 |
| `packages/client/ui-conversation/src/client/chat/register-node-renderers.ts`、`conversation-nodes/voice-reply.ts`、`register.ts` | 注册 voice/reply 节点渲染器 | 语音消息独立渲染 |
| `packages/client/ui-conversation/src/client/contract/slots.ts` | 新增 `conversation.chat.voice-actions` 槽声明（+92 行） | 语音条扩展 UI 挂载点 |
| `packages/client/ui-conversation/src/client/apply.ts`、`service.ts`、`locales.ts`、`index.ts`、`ChatView.tsx`、`ChatNodeSeat.tsx`、`ReasoningRow.tsx`、`ConversationSession.tsx` | 配套：节点注册、文案、布局 | 前端整体衔接语音 |
| `packages/client/ui-renderer/src/client/DocumentTitle.tsx`、`packages/client/ui-sidebar/src/client/SidebarRoot.tsx` | 界面配套 | 配套 |

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

## 附：真实改动文件清单（62 个源码文件）

```bash
git log master --not upstream/master --name-only --format="" \
  | grep packages/ | grep src/ | grep -v "tests/\|snapshots/\|\.d\.ts\|/lib/" | sort -u
```

> 注：`BalanceMeter.tsx` / `.module.css` 已在后续提交中删除（余额显示改由插件提供），故不计入当前清单。

核心：`llm-deepseek/serialize.ts`、`llm-pi-ai/context.ts`、`attachment-local/store.ts`、`host/apiproxy/{api-proxy,voice,edge-tts}.ts`、`host/apiproxy/api/*`、`core/session/{types,known-event-types}.ts`、`client/ui-conversation/src/client/{apply,service,locales,slots}.ts` + `chat/*`、`runtime/{contract/session,sessions/session}.ts`、`connection/*`、`acp/acp/src/index.ts`、`subprocess/spawn.ts`、`shell/pwsh-local` 等。
