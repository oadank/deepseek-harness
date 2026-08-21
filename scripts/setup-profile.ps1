# ============================================================
# dsh-input-tools 内置插件一键配置脚本（Windows）
# 作用：把仓库内置的语音插件（internal-plugins/dsh-input-tools）
#       注册进当前用户的 dsh profile，clone 即用、零手工配置。
# 用法：在源码仓库根目录（管理员 PowerShell 可选）：
#   powershell -ExecutionPolicy Bypass -File scripts\setup-profile.ps1
#   可选参数：-ProfileName <名字>（默认 web）
#             -SkipAsr             （跳过 ASR 安装提示）
# 幂等：重复运行安全（插件已存在则更新，已注册则跳过）。
# ============================================================
param(
  [string]$ProfileName = "web",
  [switch]$SkipAsr
)
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path $PSScriptRoot -Parent
$PluginSrc = Join-Path $RepoRoot "internal-plugins\dsh-input-tools"
$DshHome = Join-Path $env:USERPROFILE ".dsh"
$ProfilesRoot = Join-Path $DshHome "profiles"
$PluginDst = Join-Path $ProfilesRoot "node_modules\@oadank\dsh-input-tools"
$ProfileDir = Join-Path $ProfilesRoot $ProfileName
$PatchFile = Join-Path $ProfileDir "cordis.patch.yml"

Write-Host "==== dsh-input-tools 内置插件配置 ====" -ForegroundColor Cyan
Write-Host "仓库根: $RepoRoot"

# 1. 校验插件源
if (-not (Test-Path (Join-Path $PluginSrc "package.json"))) {
  Write-Host "  错误：找不到内置插件 $PluginSrc（internal-plugins/dsh-input-tools）" -ForegroundColor Red
  exit 1
}

# 2. 复制插件到 profiles/node_modules/@oadank（幂等：已存在则更新）
Write-Host "`n[1/4] 安装插件到 profile..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path (Join-Path $ProfilesRoot "node_modules\@oadank") | Out-Null
if (Test-Path $PluginDst) {
  Write-Host "  插件已存在，更新为仓库内置版本..."
  Remove-Item -Recurse -Force $PluginDst
}
Copy-Item -Recurse -Force $PluginSrc $PluginDst
Write-Host "  插件已安装: $PluginDst" -ForegroundColor Green

# 3. 注册到 cordis.patch.yml（幂等：已有 dsh-input-tools 则跳过）
Write-Host "`n[2/4] 注册插件到 profile $ProfileName ..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
$InsertBlock = @"
# [dsh-input-tools 自动生成] 语音能力一体化插件（host=语音工具/TTS/ASR/克隆/自动回复；client=工具条/语音设置页）
- insert:
    - id: dsh-input-tools
      name: '@oadank/dsh-input-tools'
"@
if (-not (Test-Path $PatchFile)) {
  Set-Content -Path $PatchFile -Value $InsertBlock -Encoding UTF8
  Write-Host "  已创建 $PatchFile 并注册插件" -ForegroundColor Green
} else {
  if (Select-String -Path $PatchFile -Pattern "dsh-input-tools" -Quiet) {
    Write-Host "  cordis.patch.yml 已含 dsh-input-tools，跳过注册。" -ForegroundColor Green
  } else {
    Add-Content -Path $PatchFile -Value "`n$InsertBlock" -Encoding UTF8
    Write-Host "  已追加注册到现有 cordis.patch.yml" -ForegroundColor Green
  }
}

# 4. ffmpeg 检查
Write-Host "`n[3/4] 检查 ffmpeg..." -ForegroundColor Yellow
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ffmpeg) {
  Write-Host "  ffmpeg 已就绪: $($ffmpeg.Source)" -ForegroundColor Green
} else {
  Write-Host "  未检测到 ffmpeg（语音转码必需）。" -ForegroundColor Red
  Write-Host "  请运行: winget install ffmpeg   （装完重开终端，或重跑本脚本）" -ForegroundColor Yellow
}

# 5. 可选 ASR
if (-not $SkipAsr) {
  Write-Host "`n[4/4] 可选：本地 ASR（离线语音识别）" -ForegroundColor Yellow
  $asrScript = Join-Path $PluginSrc "scripts\install-asr.ps1"
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
Write-Host "升级仓库后重跑本脚本即可同步插件更新。"
