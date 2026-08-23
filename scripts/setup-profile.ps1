# ============================================================
# dsh-input-tools 插件一键配置脚本（Windows）
# 作用：从 npm 安装语音插件 @oadank/dsh-input-tools 到当前用户的
#       dsh profile 并注册（dsh.profile.bundles），clone 即用、零手工配置。
# 插件不再内置于仓库（internal-plugins 已移除）——单一真源 = npm / 插件仓库。
# 用法：在源码仓库根目录（管理员 PowerShell 可选）：
#   powershell -ExecutionPolicy Bypass -File scripts\setup-profile.ps1
#   可选参数：-ProfileName <名字>（默认 web）
#             -SkipAsr             （跳过 ASR 安装提示）
# 幂等：重复运行安全（dsh plugin add 已装则更新到 latest）。
# 前置：dsh CLI 可用（本仓库 pnpm install && pnpm run build:web，或已全局安装）。
# [2026-08-23 中文用户名兼容] 本文件必须保持 UTF-8 WITH BOM（PowerShell 5.1 按 ANSI/GBK 读，
# 无 BOM 中文乱码会 ParseError）。改完用编辑器"带 BOM 的 UTF-8"保存。
# ============================================================
param(
  [string]$ProfileName = "web",
  [switch]$SkipAsr
)
$ErrorActionPreference = "Stop"

# [BUG-11 修复 2026-08-23] npm 全局目录（AppData\Roaming\npm）常不在 PATH（尤其全新机器），
# dsh/pnpm 直接"不是内部或外部命令"。开头自动补进当前会话 PATH。
$npmPrefix = ""
try {
  $npmPrefix = (npm config get prefix 2>$null | Out-String).Trim()
} catch { }
if ($npmPrefix -ne "" -and $env:Path -notlike "*$npmPrefix*") {
  $env:Path = "$npmPrefix;$env:Path"
  Write-Host "  已把 npm 全局目录加入 PATH: $npmPrefix" -ForegroundColor DarkGray
}
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dshCmd) {
  Write-Host "  未找到 dsh 命令。" -ForegroundColor Red
  Write-Host "  先确保 CLI 就绪（二选一）：" -ForegroundColor Yellow
  Write-Host "    ① 本地源码：在仓库根目录运行  pnpm install && pnpm run build:web"
  Write-Host "    ② 全局安装：npm install -g @deepseek-ai/dsh"
  Write-Host "  然后再重跑本脚本。" -ForegroundColor Yellow
  exit 1
}

$DshHome = Join-Path $env:USERPROFILE ".dsh"
$ProfilesRoot = Join-Path $DshHome "profiles"
$ProfileDir = Join-Path $ProfilesRoot $ProfileName
# [BUG-8 修复 2026-08-23] 插件实际按 profile 隔离装到 $ProfileDir\node_modules\...，
# 不是 profiles 根目录。检查路径修正。
$PluginRt = Join-Path $ProfileDir "node_modules\@oadank\dsh-input-tools"

Write-Host "==== dsh-input-tools 插件配置（npm 源）====" -ForegroundColor Cyan

# 1. 从 npm 安装并注册插件（官方 dsh plugin 通道：bundles 自动注册、patch 自动应用）
Write-Host "`n[1/3] 安装插件 @oadank/dsh-input-tools（npm 官方源）..." -ForegroundColor Yellow
# [BUG-7 修复 2026-08-23] profile 的 pnpm-workspace.yaml 有 minimumReleaseAge 供应链策略，
# 新发布版本被跳过（实测 0.3.18 拉不到 0.3.20，永远 "Already up to date"）。
# dsh plugin 的 pnpm 调用追加 --config.minimum-release-age=0 绕过新版本保护。
dsh plugin --profile $ProfileName add @oadank/dsh-input-tools --registry=https://registry.npmjs.org/ --config.minimum-release-age=0
if ($LASTEXITCODE -ne 0) {
  Write-Host "  安装失败：dsh 命令不可用或 pnpm 报错。" -ForegroundColor Red
  Write-Host "  请先确保 CLI 就绪：仓库根目录运行 pnpm install && pnpm run build:web（或 npm i -g @deepseek-ai/dsh），再重跑本脚本。" -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path (Join-Path $PluginRt "package.json"))) {
  Write-Host "  警告：未在 $PluginRt 找到插件安装产物，请检查上面 pnpm 输出。" -ForegroundColor Red
  Write-Host "  提示：若你看到 'Already up to date'，可能是 minimumReleaseAge 策略挡了新版本——" -ForegroundColor Yellow
  Write-Host "  重跑本脚本（已自动加 --config.minimum-release-age=0）即可。" -ForegroundColor Yellow
  exit 1
}
# [BUG-7] 输出实际安装的版本号，供核对是否最新
$installedVer = (Get-Content (Join-Path $PluginRt "package.json") -Raw | ConvertFrom-Json).version
Write-Host "  插件已安装并注册: $PluginRt（版本 v$installedVer）" -ForegroundColor Green

# 2. ffmpeg 检查
Write-Host "`n[2/3] 检查 ffmpeg..." -ForegroundColor Yellow
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ffmpeg) {
  Write-Host "  ffmpeg 已就绪: $($ffmpeg.Source)" -ForegroundColor Green
} else {
  Write-Host "  未检测到 ffmpeg（语音转码必需）。" -ForegroundColor Red
  Write-Host "  请运行: winget install ffmpeg   （装完重开终端，或重跑本脚本）" -ForegroundColor Yellow
}

# 3. 可选 ASR
if (-not $SkipAsr) {
  Write-Host "`n[3/3] 可选：本地 ASR（离线语音识别）" -ForegroundColor Yellow
  $asrScript = Join-Path $PluginRt "scripts\install-asr.ps1"
  if (Test-Path $asrScript) {
    Write-Host "  运行本地 ASR 安装（下载 sherpa-onnx + SenseVoice 模型，约 260MB）："
    Write-Host "    powershell -ExecutionPolicy Bypass -File `"$asrScript`""
  }
}

Write-Host ""
Write-Host "==== 完成 ====" -ForegroundColor Cyan
Write-Host "启动 dsh（在仓库根目录）："
Write-Host "  pnpm install"
Write-Host "  pnpm run build:web"
Write-Host "  dsh --profile $ProfileName"
Write-Host "（Windows 可用 nssm 注册为服务；Linux 用 systemd。）"
Write-Host ""
Write-Host "验证插件：打开设置 → 语音服务，能看到引擎配置/能力面板即注册成功。"
Write-Host "升级插件：重跑本脚本（npm 拉取 latest，自动绕过 minimumReleaseAge）。"