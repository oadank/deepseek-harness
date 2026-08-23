# DSH Web 整合版安装教程（Windows）

本教程安装的是**整合版**：官方 dsh 源码 + 语音/图片增强 + 内置语音插件，`git clone` 即用，不需要打补丁、不需要单独装插件。

> 💡 **可以让 AI 助手帮你安装**：把本教程发给任意 AI 助手（DeepSeek / Kimi / 豆包等），
> 让它打开终端逐条执行并帮你排查报错——比手动复制命令更不容易出错。

---

## 一、准备环境

需要已安装（在 PowerShell 里逐条检查）：

```powershell
git --version        # Git
node -v              # Node.js（>= 20）
pnpm -v              # pnpm（没有就：npm i -g pnpm）
ffmpeg -version      # ffmpeg（语音功能需要；没有就：winget install ffmpeg）
```

## 二、下载源码

```powershell
# 选一个放源码的目录，例如 D:\dev
cd D:\dev
git clone https://github.com/oadank/deepseek-harness.git
cd deepseek-harness
```

## 三、一键配置插件

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-profile.ps1
```

脚本自动完成：把内置语音插件装进 profile → 注册 → 检查 ffmpeg → 提示可选 ASR。
看到「==== 完成 ====」即成功。

## 四、安装依赖 + 构建（顺序不能错）

```powershell
pnpm install          # 首次 5~15 分钟
pnpm run build:lib    # ⚠️ 必须！全新 clone 没有编译产物，跳过会报错
pnpm run build:web    # 前端（语音气泡渲染在此步生效）
```

## 五、启动（前台试运行）

```powershell
node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 3080
```

浏览器打开 http://127.0.0.1:3080 ，首次会看到「内测声明」，确认后进入。

## 六、注册为 Windows 服务（常驻后台，可选但推荐）

需要 [nssm](https://nssm.cc)（`winget install nssm`）。

### 推荐：一键脚本（自动处理所有坑，不会填错）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-service.ps1
```

脚本自动完成：查 node 真实路径 → 设 DSH_HOME 为你的数据目录 → 自动加 DSH_FORCE_BROWSE_PICKER=1（目录选择走网页树，session 0 下原生弹窗失效的坑自动规避）→ 配日志 → 注册并启动服务。
远程访问时加参数：`-TrustedHosts "你的域名.ts.net,你的IP"`。

### 手动方式（了解原理用）

```powershell
# 1) 查你的 node 真实路径（不要猜，用命令查）：
(Get-Command node).Source
#    记下输出，例如 C:\Program Files\nodejs\node.exe

# 2) 注册服务（把 <node路径> 替换成第 1 步的输出）：
nssm install dsh-web "<node路径>" "--import tsx/esm apps/cli/src/bin.ts web --no-open --port 3080 --host 127.0.0.1"

# 3) 工作目录 = 源码根目录：
nssm set dsh-web AppDirectory "<源码目录>\deepseek-harness"

# 4) ⚠️ 关键一步：让服务使用【你自己的】dsh 数据目录。
#    服务默认以 LocalSystem 运行，会去读系统账户的目录，找不到你的插件和配置——
#    不设这一行，语音设置页就是空的。把 <你的用户名> 替换成你的 Windows 用户名：
nssm set dsh-web AppEnvironmentExtra "DSH_HOME=C:\Users\<你的用户名>\.dsh" "DSH_FORCE_BROWSE_PICKER=1"

#    ⚠️ DSH_FORCE_BROWSE_PICKER=1 必设：nssm 服务跑在 session 0，原生目录选择框弹不出来，
#    "添加工作区"点了没反应（亲测的坑）。设了之后强制用网页目录树（browse），设置 → 工作区目录 才点得动。
#    手动命令直接跑（非服务）则不需要——源码已默认 Windows 走 browse。

# 5) 日志（方便排查）：
nssm set dsh-web AppStdout "<源码目录>\logs\dsh-web.out.log"
nssm set dsh-web AppStderr "<源码目录>\logs\dsh-web.err.log"

# 6) 启动：
nssm start dsh-web
```

验证：浏览器打开 http://127.0.0.1:3080 ，设置 → 语音服务 能看到「语音能力」面板和引擎配置 = 服务正常。

> 服务启动失败排查：看 `logs\dsh-web.err.log`。最常见两个原因：
> ① node 路径写错；② 第 4 步 DSH_HOME 没设或用户名写错。

## 七、可选：本地语音识别（离线 ASR，约 260MB）

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\profiles\node_modules\@oadank\dsh-input-tools\scripts\install-asr.ps1"
```

> 插件由 `scripts\setup-profile.ps1` 从 npm 安装（不再内置于仓库 internal-plugins）。

装完到 设置 → 语音服务 → ASR，点「检测已安装」自动填入。

## 八、可选：本地语音合成（离线 TTS）

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\profiles\node_modules\@oadank\dsh-input-tools\scripts\install-local-tts.ps1"
```

装完把脚本最后提示的那行命令，填进 设置 → 语音服务 → 本地 TTS →「本地命令」，点「试听本地 TTS」验证。

> 模型会装到独立目录（默认 `~\.dsh\sherpa-onnx`，自动复用 ASR 已装的 sherpa-onnx），
> 不随插件升级丢失。想装别处可加 `-InstallDir "你的目录"`。

## 九、远程访问（可选）

用 Tailscale 或内网穿透从其他设备访问时，启动参数加 `--trusted-host`（可重复）：

```powershell
nssm set dsh-web AppParameters "<node路径> --import tsx/esm apps/cli/src/bin.ts web --no-open --port 3080 --host 127.0.0.1 --trusted-host 你的域名.ts.net"
```

## 更新升级

```powershell
cd <源码目录>\deepseek-harness
git pull
powershell -ExecutionPolicy Bypass -File scripts\setup-profile.ps1
```

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `build:web` 报 Failed to resolve @deepseek-ai/dsh-client-web | 跳过了 `build:lib`，先跑 `pnpm run build:lib` |
| 服务启动即停止 | node 路径错 或 DSH_HOME 没设，看 err.log |
| 语音设置页空白 / 插件路由返回首页 HTML | 服务没加载插件：检查 DSH_HOME（第六节第 4 步） |
| 试听报错 Cannot find module | 插件已能正确处理带引号命令，重新填脚本提示的最新命令 |
| 改了页面没反应 | 浏览器硬刷新 Ctrl+Shift+R |
