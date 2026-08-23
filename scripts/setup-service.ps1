# ============================================================
# dsh-web Windows 服务一键注册脚本（nssm）
# 自动处理三个最常见的坑：
#   ① node 路径：自动用 (Get-Command node).Source，不再手填错路径
#   ② DSH_HOME：自动设为 <当前用户>\.dsh（nssm 默认 LocalSystem 会读系统账户目录，
#      导致插件不加载、语音设置页空白——必须显式指定）
#   ③ 日志：自动指向 <仓库>/logs/dsh-web.out.log / err.log
#   ④ ffmpeg：自动探测 ffmpeg 路径并写入 DSH_VOICE_FFMPEG_BIN——语音识别(transcribeVoice)
#      依赖它把浏览器 webm/ogg 录音转成 sherpa 能吃的 wav；不设会导致真实语音消息识别失败
#      （设置页的识别「测试」因示例是预渲染 wav 所以能过，但真录音是 webm 必挂）
#   ⑤ DSH_FORCE_BROWSE_PICKER=1：nssm 服务跑在 Session 0，原生 IFileOpenDialog 弹不出，
#      强制目录选择走浏览器固定对话框（与 resolve.ts win32 默认回落 browse 形成双保险）
#      ——否则「设置 → 工作区目录」选了毫无反应，用户无法选择工作区。
#
# 用法（管理员 PowerShell，在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts\setup-service.ps1
# 可选参数：
#   -Port 3080
#   -TrustedHosts "a.ts.net,b.ts.net"   # 远程访问时加 --trusted-host（逗号分隔）
#   -ServiceName dsh-web
#   -NoStart     # 只注册不启动
# 删除服务：nssm remove dsh-web confirm
# ============================================================
param(
  [int]$Port = 3080,
  [string]$TrustedHosts = "",
  [string]$ServiceName = "dsh-web",
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

Write-Host "==== dsh-web 服务注册 ====" -ForegroundColor Cyan

# ---- 1. 前置检查：nssm / node / 仓库 ----
$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if (-not $nssm) {
  Write-Host "  未找到 nssm，正在安装（winget）..." -ForegroundColor Yellow
  winget install nssm --accept-package-agreements --accept-source-agreements | Out-Null
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
  $nssm = Get-Command nssm -ErrorAction SilentlyContinue
  if (-not $nssm) {
    Write-Host "  nssm 安装失败，请手动安装：winget install nssm 或 https://nssm.cc" -ForegroundColor Red
    exit 1
  }
}

$nodeExe = (Get-Command node).Source
if (-not $nodeExe) {
  Write-Host "  未找到 node，请先安装 Node.js >= 20" -ForegroundColor Red
  exit 1
}
if (-not (Test-Path "$RepoRoot\apps\cli\src\bin.ts")) {
  Write-Host "  当前目录不是 dsh 源码仓库（找不到 apps\cli\src\bin.ts）" -ForegroundColor Red
  Write-Host "  请在源码仓库根目录运行本脚本" -ForegroundColor Red
  exit 1
}

# ---- 2. DSH_HOME：自动取当前用户 .dsh（必须显式，nssm LocalSystem 默认读系统账户）----
$DshHome = Join-Path $env:USERPROFILE ".dsh"
if (-not (Test-Path $DshHome)) {
  Write-Host "  警告：$DshHome 不存在——请先运行 setup-profile.ps1 生成 profile，再注册服务" -ForegroundColor Yellow
}
Write-Host "  node:    $nodeExe"
Write-Host "  仓库:    $RepoRoot"
Write-Host "  DSH_HOME:$DshHome   （服务将使用你的数据目录，插件/配置才找得到）" -ForegroundColor Green

# ---- 2b. 探测 ffmpeg 路径（语音识别转码必需）----
$ff = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ff) { $ff = "ffmpeg" }   # 兜底走 PATH（服务进程继承系统 PATH）
Write-Host "  ffmpeg:  $ff   （写入 DSH_VOICE_FFMPEG_BIN，语音识别转码用）" -ForegroundColor Green

# ---- 2c. 目录选择器：强制 browse（nssm Session 0 下原生弹窗失效）----
$PickerEnv = "DSH_FORCE_BROWSE_PICKER=1"
Write-Host "  选择器:  $PickerEnv   （nssm Session 0 弹不出原生目录框，强制用浏览器 browse）" -ForegroundColor Green

# ---- 3. 组装启动参数 ----
$binEntry = "--import tsx/esm apps/cli/src/bin.ts web --no-open --port $Port --host 127.0.0.1"
if ($TrustedHosts -ne "") {
  foreach ($h in ($TrustedHosts -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })) {
    $binEntry += " --trusted-host $h"
  }
}
Write-Host "  参数:    $binEntry"

# ---- 4. 注册服务（幂等：已存在先删；EAP=Stop 下 nssm 对不存在服务报错写 stderr 会抛 NativeCommandError，需临时放宽）----
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $nssm.Source stop $ServiceName 2>$null | Out-Null
& $nssm.Source remove $ServiceName confirm 2>$null | Out-Null
$ErrorActionPreference = $prevEAP
& $nssm.Source install $ServiceName "$nodeExe" "$binEntry" | Out-Null
& $nssm.Source set $ServiceName AppDirectory "$RepoRoot" | Out-Null
& $nssm.Source set $ServiceName AppEnvironmentExtra "DSH_HOME=$DshHome" "DSH_VOICE_FFMPEG_BIN=$ff" $PickerEnv | Out-Null
& $nssm.Source set $ServiceName Start SERVICE_AUTO_START | Out-Null
New-Item -ItemType Directory -Force -Path "$RepoRoot\logs" | Out-Null
& $nssm.Source set $ServiceName AppStdout "$RepoRoot\logs\$ServiceName.out.log" | Out-Null
& $nssm.Source set $ServiceName AppStderr "$RepoRoot\logs\$ServiceName.err.log" | Out-Null
& $nssm.Source set $ServiceName AppRotateFiles 1 | Out-Null
Write-Host "  服务已注册：$ServiceName" -ForegroundColor Green

# ---- 5. 启动 ----
if ($NoStart) {
  Write-Host "  已跳过启动（-NoStart）。启动：nssm start $ServiceName" -ForegroundColor Yellow
} else {
  & $nssm.Source start $ServiceName | Out-Null
  Start-Sleep -Seconds 3
  $state = (Get-Service $ServiceName -ErrorAction SilentlyContinue).Status
  Write-Host "  服务状态：$state" -ForegroundColor Green
  if ($state -ne "Running") {
    Write-Host "  启动失败，查看日志：$RepoRoot\logs\dsh-web.err.log" -ForegroundColor Red
    exit 1
  }
}

Write-Host "`n浏览器打开 http://127.0.0.1:$Port ，设置 → 语音服务 应能看到能力面板。" -ForegroundColor Cyan
