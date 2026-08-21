# DeepSeek Harness — 本地增强 fork

这是 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 的**本地增强 fork**，在官方 rc.8 (`141eb6fef8`) 之上叠加了大量本地改造与自研/集成插件。**本仓库不会向上游发起合并请求**（差异过大且含本地化偏好）。

> 如果你只是想跑官方原版，请使用上游：`npx @deepseek-ai/dsh web`。下面的内容只与本 fork 有关。

---

## 快速开始（含内置语音插件）

本 fork **内置了语音能力插件**（`internal-plugins/dsh-input-tools/`：语音输入/多引擎 TTS/ASR/
音色克隆/语音气泡/AI 语音回复），clone 后一键配置即可用：

```bash
git clone https://github.com/oadank/deepseek-harness.git
cd deepseek-harness
# Windows：一键配置（装插件到 profile + 注册 + 检查 ffmpeg）
powershell -ExecutionPolicy Bypass -File scripts\setup-profile.ps1
# Linux/macOS：
bash scripts/setup-profile.sh
pnpm install
pnpm run build:web
dsh --profile web
```

可选本地 ASR（离线识别）：Windows 运行
`internal-plugins\dsh-input-tools\scripts\install-asr.ps1`。
升级：`git pull` 后重跑 setup 脚本即可同步插件。详细说明见
[插件 README](internal-plugins/dsh-input-tools/README.md)。

---

## 与官方仓库的核心差异

| 维度 | 上游官方 | 本 fork |
|---|---|---|
| 基线版本 | trunk（持续演进） | 锁在 **rc.8**（`141eb6fef8`，即 `release/dsh-0.1.0-rc.8`） |
| 目标用户 | 通用 | **个人本地开发/部署** |
| 插件生态 | 公开发布 | 自研/集成若干插件，源码统一收纳在 `plugins/` |
| 部署形态 | `npx` 或源码 `pnpm dsh web` | **nssm 常驻服务** + tailscale HTTPS 反代 |
| 语音/TTS | 官方迭代中 | 已完整接通（详见下文） |
| 合并上游 | — | **不合并**，独立演进 |

---

## 本地改造清单（在 rc.8 之上新增 5 个 commit）

> 分支：`master`（已强推、已删除原 `upgrade/rc8`），HEAD = `c149a83f7f`。

| Commit | 内容 |
|---|---|
| `818d89494f` | 本地改造基线：语音全链路 + 图片识别 + 余额显示 + 界面优化 |
| `af54f5b67d` | 语音三规则 + `send_voice` 工具、`taskkill` 全路径兜底、停止按钮 `releaseFocus`、语音条按时长定宽 |
| `e0c3825109` | TTS 三引擎独立化（Edge 免费 / 小米 / 本地 MeloTTS）+ 语音条宽度按秒数 + 语音规则 |
| `055a00906b` | rc.8 重放补丁：语音发送整理 / 余额 / vision 路径化细节 |
| `c149a83f7f` | `pi-ai` 收尾：`toPiContext` 签名统一为本地 vision 版，移除上游 `onReplayDegrade/offload` 残留 |

要点（相对上游）：
- **语音全链路**：录音（`getUserMedia` + `MediaRecorder`）→ ASR → `sendVoice` → LLM；TTS（Edge 免费 / 小米 / 本地 MeloTTS 三引擎）→ 播放；语音条按秒数定宽、互斥录音防回声。
- **图片识别（非多模态模型桥接）**：模型不支持图时，图片自动转为"本地路径文本"，由视觉 MCP 识图；与 `llm-deepseek/serialize.ts` 一致。
- **余额显示**已迁移至独立插件 `@oadank/dsh-client-balance`（见下文）。
- **`llm-pi-ai` 重构**：`toPiContext` 重载按参数拆分（无 attachments→同步 `PiContext` / 有→`Promise<PiContext>`），统一本地 vision 路径。

---

## 自研 / 集成插件

源码统一收纳于 **`C:\D\opt\deepseek-harness\plugins\`**（外层目录，**不在嵌套仓库内**），与框架源码解耦。

| 插件 | 包名 | 类型 | 作用 |
|---|---|---|---|
| `dsh-balance-plugin/` | `@oadank/dsh-client-balance` | 自研 | 余额查询/展示 |
| `dsh-voice-plugin/` | `@oadank/dsh-host-voice` | 自研 | 语音/TTS 引擎宿主（Edge/小米/MeloTTS） |
| `dsh-vscode-layout-master/` | `@anoslide/dsh-client-vscode-layout` | 集成（第三方） | VS Code 式 IDE 布局：文件树、多标签查看器、全屏对话 / 分栏视图切换、设置面板管理、全局人设 |

> ⚠️ **第三方插件（`dsh-vscode-layout-master`）只有 `lib/` 产物、无源码**，改动直接编辑 `lib/client.js`（先备份 `*.bak-时间戳`，保持 LF 行尾，改完 `node --check` 验语法）。

### 改插件的铁律（务必遵守）

DSH 加载插件只认 `~/.dsh/profiles/node_modules/@oadank/*` 与 `@anoslide/*` 的实体包 + `cordis.patch.yml` 的 name 引用，源码仓库放哪都不影响运行；git 不记录绝对路径，移动后 `push`/`history` 完好。

**改插件必须改 2 处**：
1. 运行时实体包：`~/.dsh/profiles/node_modules/@oadank/<pkg>` 或 `@anoslide/<pkg>`
2. 推送的源码仓库：`plugins\<pkg>`

只改一处会"本地生效但推送不含"或反之。

---

## 部署架构（本机 24h 常驻小主机，LeCoo Windows）

| 组件 | 路径 / 端口 | 托管方式 |
|---|---|---|
| dsh-web | `http://127.0.0.1:3080`（仅本地） | nssm `dsh-web`，AppParameters = `--import tsx/esm apps/cli/src/bin.ts web` |
| 外部访问 | `https://lecoo.tailb5f10f.ts.net/` | tailscale HTTPS 443 → 3080 |
| 嵌套仓库 | `C:\D\opt\deepseek-harness\deepseek-harness\` | git 工作区（`master` 分支） |
| 插件源码 | `C:\D\opt\deepseek-harness\plugins\` | 独立 git 仓库 |
| 插件运行时 | `~/.dsh/profiles/node_modules/@oadank/` + `@anoslide/` | 由 `cordis.patch.yml` 按 name 引用 |

### 改前端代码后的"客户端三步"

每次改动 `packages/client/**`（含 `ui-renderer`、`ui-sidebar` 等）或 `apps/web/**` 源码，**必须按顺序执行三步**，否则 dsh-web 仍跑旧构建：

```bash
cd C:\D\opt\deepseek-harness\deepseek-harness
npm run build:lib:client   # tsc -b tsconfig.client.json + tsdown 重建 client 各包 lib
npm run build:web         # vite 构建前端（产物 apps/web/dist）
nssm restart dsh-web      # 重启服务加载新 dist
```

> vite 的 `apps/web` 消费的是各包的 `lib/` 产物（`vite.config.ts` 注释明确："Workspace packages are consumed as built lib products"），**只跑 `build:web` 不够**，必须先 `build:lib:client`。

### 推送流程（含 hooks）

```bash
# 1) 提交代码
git add -A && git commit -m "..."

# 2) 推送（钩子会跑 build:lib:host && typecheck:contracts-ready，必须全绿）
git push origin master
```

system 级 `credential.helper = manager`（已配置），GitHub 凭据走 Windows Credential Manager 的 `x-access-token` PAT，无交互。

---

## 已知坑（踩过的）

- **`git -C 绝对路径` 在本沙箱报错**："cannot change to /c/D/..."——请用 `cd` 进目录后再操作。
- **Python 写文件默认把 `\n` 改成 `\r\n`**：编辑插件产物后务必 `replace(b'\r\n', b'\n')` 还原 LF，否则 diff 噪音极大。
- **`curl 127.0.0.1:3080` 走 Clash 代理会返回 000**：Git Bash 的 curl 受 `代理` 影响，测服务时加 `--noproxy '*'`。
- **pre-push 钩子非常严**（`tsconfig.client.json` 全量类型检查）：`tsc -b` 会把 fixture / 测试文件也查，所以改了契约（`SessionsApi` 新方法、`ApiProxy` 新字段等）必须同步 fixture 测试双与测试 props。
- **hooks 只在 `host` 面 build**，客户端面靠手动 `npm run build:lib:client`。

---

## 开发约定

- 中文输出，结构化优先（能用表格不用段落）。
- 重要操作先出计划经确认；改配置前备份（`*.bak-时间戳`）；破坏性操作（删除、改配置、重启服务、强制推送）必须先问。
- 同一操作失败 ≥ 3 次停下问用户，不硬试。
- 改后必须验证生效（`node --check`、`tsc -b`、`npm run build`）再继续。
- 不擅自创建/删除/重启服务，先备份再问。
- 敏感信息（`XDN_PASS`、GitHub PAT 等）明文不落盘、不进文档。

---

## 目录速览

```
C:\D\opt\deepseek-harness\
├── deepseek-harness\        # 本仓库（嵌套）—— 上游 rc.8 + 本地改造 + pi-ai 收尾
├── plugins\                 # 自研/集成插件源码（独立 git 仓库）
│   ├── dsh-balance-plugin\
│   ├── dsh-voice-plugin\
│   └── dsh-vscode-layout-master\
├── logs\                     # dsh-web / build 等日志
└── ...
```

---

## 致谢

- 上游：[DeepSeek Harness](](https://github.com/deepseek-ai/deepseek-harness)) by DeepSeek AI（[MIT](LICENSE)）
- Cordis 框架：[cordiverse/cordis](https://github.com/cordiverse/cordis)
- VS Code 风格布局：[@anoslide/dsh-client-vscode-layout](plugins\dsh-vscode-layout-master)