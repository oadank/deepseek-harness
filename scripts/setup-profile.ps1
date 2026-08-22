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
# ============================================================
param(
  [string]$ProfileName = "web",
  [switch]$SkipAsr
)
$ErrorActionPreference = "Stop"

$DshHome = Join-Path $env:USERPROFILE ".dsh"
$ProfilesRoot = Join-Path $DshHome "profiles"
$ProfileDir = Join-Path $ProfilesRoot $ProfileName
$PluginRt = Join-Path $ProfilesRoot "node_modules\@oadank\dsh-input-tools"

Write-Host "==== dsh-input-tools 插件配置（npm 源）====" -ForegroundColor Cyan

# 1. 从 npm 安装并注册插件（官方 dsh plugin 通道：bundles 自动注册、patch 自动应用）
Write-Host "`n[1/3] 安装插件 @oadank/dsh-input-tools（npm 官方源）..." -ForegroundColor Yellow
dsh plugin --profile $ProfileName add @oadank/dsh-input-tools --registry=https://registry.npmjs.org/
if ($LASTEXITCODE -ne 0) {
  Write-Host "  安装失败：dsh 命令不可用或 pnpm 报错。" -ForegroundColor Red
  Write-Host "  请先确保 CLI 就绪：仓库根目录运行 pnpm install && pnpm run build:web（或 npm i -g @deepseek-ai/dsh），再重跑本脚本。" -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path (Join-Path $PluginRt "package.json"))) {
  Write-Host "  警告：未在 $PluginRt 找到插件安装产物，请检查上面 pnpm 输出。" -ForegroundColor Red
  exit 1
}
Write-Host "  插件已安装并注册: $PluginRt" -ForegroundColor Green

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
Write-Host "升级插件：重跑本脚本（npm 拉取 latest）。"
