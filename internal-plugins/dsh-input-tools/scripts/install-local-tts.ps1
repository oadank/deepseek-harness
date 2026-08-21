# ============================================================
# dsh-input-tools 本地 TTS 一键安装脚本（Windows）
# 安装内容：
#   1. sherpa-onnx（含 sherpa-onnx-offline-tts.exe 离线 TTS）
#   2. 中文 MeloTTS VITS 模型（vits-melo-tts-zh_en）
#   3. ffmpeg（无则用 winget 安装）
#   4. 生成 local-tts.mjs 启动脚本（与插件"本地命令"契约一致：
#      node local-tts.mjs <文本> → stdout 输出 mp3 音频字节）
#
# 安装位置（2026-08-22 改）：默认装到**独立目录**，不装插件包目录——
#   插件包（profile 副本或源码 internal-plugins）会随升级/重装被覆盖，
#   模型放里面会丢。默认顺序：
#     1) -InstallDir 参数显式指定（最高优先，可指定源码 internal-plugins 等任意位置）
#     2) 检测已有 sherpa-onnx（ASR 装过则复用同一份，省一次下载）：
#        ~\.dsh\sherpa-onnx / C:\D\opt\sherpa-onnx / D:\opt\deepseek-harness\asr
#     3) 以上都没有 → ~\.dsh\sherpa-onnx（dsh 数据目录，跨升级保留）
# 用法：以管理员身份打开 PowerShell，执行：
#   powershell -ExecutionPolicy Bypass -File "<脚本路径>\install-local-tts.ps1"
#   或指定安装目录：... install-local-tts.ps1 -InstallDir "D:\opt\my-sherpa"
# 装完后到 dsh 设置 → 语音服务 → 本地 TTS，把提示的命令填进「本地命令」。
# ============================================================
param(
  [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"
$Version = "v1.13.6"

# ---- 下载/解压工具函数（2026-08-21 增强：断点续传 + 完整性校验 + 损坏自动重试）----
# ⚠️ PowerShell 坑：$ErrorActionPreference=Stop 时 curl/tar 写 stderr 会抛 NativeCommandError（0.3.5 实测踩中）。
# 原生命令一律 cmd /c 包装 + 2>nul + 临时放宽 EAP，只依据 $LASTEXITCODE。
function Download-Resume {
  param([string]$Url, [string]$OutFile)
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    Write-Host "  下载（第 $attempt 次尝试）: $Url" -ForegroundColor Yellow
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    cmd /c "curl.exe -sL -C - --retry 3 --retry-delay 2 --connect-timeout 20 -o `"$OutFile`" `"$Url`" 2>nul"
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($code -eq 0) { return $true }
    Write-Host "  下载中断（exit=$code），3 秒后重试..." -ForegroundColor Yellow
    Start-Sleep -Seconds 3
  }
  return $false
}
function Expand-TarBz2 {
  param([string]$Archive, [string]$Dest, [int]$Strip = 0)
  $tmpDir = Join-Path $Dest ".extract-tmp"
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $stripArgs = ""
  if ($Strip -gt 0) { $stripArgs = "--strip-components=$Strip" }
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  cmd /c "tar -xjf `"$Archive`" -C `"$tmpDir`" $stripArgs 2>nul"
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prevEAP
  if ($code -ne 0) {
    Write-Host "  解压失败：压缩包损坏或不完整（$Archive）" -ForegroundColor Red
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    Remove-Item -Force $Archive -ErrorAction SilentlyContinue
    return $false
  }
  Get-ChildItem $tmpDir | Move-Item -Destination $Dest -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
  return $true
}

# ---- 0. 确定安装目录（独立目录，不装插件包内）----
if ($InstallDir -eq "") {
  # 复用已有 sherpa-onnx（ASR 装过则共用，省一次下载）
  foreach ($c in @("$env:USERPROFILE\.dsh\sherpa-onnx", "C:\D\opt\sherpa-onnx", "D:\opt\deepseek-harness\asr")) {
    if (Test-Path (Join-Path $c "bin")) { $InstallDir = $c; break }
  }
  if ($InstallDir -eq "") { $InstallDir = Join-Path $env:USERPROFILE ".dsh\sherpa-onnx" }
}

Write-Host "==== dsh 本地 TTS 一键安装 ====" -ForegroundColor Cyan
Write-Host "安装目录:   $InstallDir"
Write-Host "  （独立目录，不随插件升级/重装被覆盖；与 ASR 共用同一份 sherpa-onnx）" -ForegroundColor DarkGray

# ---- 0b. 幂等保护：已完整安装则直接退出 ----
$exeExists = Test-Path "$InstallDir\bin\sherpa-onnx-offline-tts.exe"
$modelExists = Test-Path "$InstallDir\models\melo\model.onnx"
if ($exeExists -and $modelExists) {
  Write-Host "`n检测到本机已完整安装 sherpa-onnx + MeloTTS 模型。" -ForegroundColor Green
  Write-Host "无需重复下载（local-tts.mjs 仍会确保存在）。" -ForegroundColor Green
}

# ---- 1. 创建目录 ----
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path "$InstallDir\models" | Out-Null
New-Item -ItemType Directory -Force -Path "$InstallDir\bin" | Out-Null
New-Item -ItemType Directory -Force -Path "$InstallDir\tmp" | Out-Null

# ---- 2. 检查 ffmpeg（合成后放大音量 + 转 mp3 必需）----
Write-Host "`n[1/3] 检查 ffmpeg..." -ForegroundColor Yellow
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
  Write-Host "  未找到 ffmpeg，尝试 winget 安装（首次安装需同意条款）..." -ForegroundColor Yellow
  try {
    winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
  } catch {
    Write-Host "  winget 安装失败，请手动安装 ffmpeg 并加入 PATH" -ForegroundColor Red
    exit 1
  }
}
Write-Host "  ffmpeg: $($ffmpeg.Source)" -ForegroundColor Green

# ---- 3. 下载 sherpa-onnx（与 ASR 共用；含 offline-tts.exe）----
Write-Host "`n[2/3] 下载 sherpa-onnx $Version ..." -ForegroundColor Yellow
$pkgUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/$Version/sherpa-onnx-$Version-win-x64-shared-MD-Release.tar.bz2"
$pkgFile = "$InstallDir\tmp\sherpa-onnx.tar.bz2"
if (-not (Test-Path "$InstallDir\bin\sherpa-onnx-offline-tts.exe")) {
  if (-not (Test-Path "$InstallDir\bin\sherpa-onnx-offline.exe")) {
    if (-not (Download-Resume $pkgUrl $pkgFile)) {
      Write-Host "  sherpa-onnx 下载失败（网络不稳定）。请检查网络后重跑本脚本" -ForegroundColor Red
      exit 1
    }
    Write-Host "  解压..."
    if (-not (Expand-TarBz2 $pkgFile "$InstallDir\tmp")) {
      Write-Host "  sherpa-onnx 压缩包损坏已删除，请重跑本脚本自动重新下载" -ForegroundColor Red
      exit 1
    }
    $extracted = Get-ChildItem "$InstallDir\tmp" -Directory | Where-Object { $_.Name -like "sherpa-onnx-*win*" } | Select-Object -First 1
    if ($extracted) {
      Copy-Item "$($extracted.FullName)\bin\*" "$InstallDir\bin\" -Force
      Copy-Item "$($extracted.FullName)\lib\*" "$InstallDir\lib\" -Force -ErrorAction SilentlyContinue
      Write-Host "  sherpa-onnx 解压完成" -ForegroundColor Green
    } else {
      Write-Host "  解压目录未找到，检查 tmp 目录" -ForegroundColor Red
      exit 1
    }
  } else {
    Write-Host "  检测到已有 sherpa-onnx（ASR 已装），离线 TTS exe 应同在 bin/ 下" -ForegroundColor Yellow
  }
} else {
  Write-Host "  sherpa-onnx 已存在，跳过下载" -ForegroundColor Green
}

# ---- 4. 下载 MeloTTS 中文模型（断点续传 + 完整性校验）----
Write-Host "`n[3/3] 下载中文 MeloTTS VITS 模型..." -ForegroundColor Yellow
$modelDir = "$InstallDir\models\melo"
$modelUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2"
$modelFile = "$InstallDir\tmp\melo.tar.bz2"
if (-not (Test-Path "$modelDir\model.onnx")) {
  if (-not (Download-Resume $modelUrl $modelFile)) {
    Write-Host "  MeloTTS 模型下载失败（网络不稳定）。请检查网络后重跑本脚本" -ForegroundColor Red
    exit 1
  }
  New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
  Write-Host "  解压模型..."
  if (-not (Expand-TarBz2 $modelFile $modelDir 1)) {
    Write-Host "  模型压缩包损坏已删除，请重跑本脚本自动重新下载" -ForegroundColor Red
    exit 1
  }
  if (-not (Test-Path "$modelDir\model.onnx")) {
    Write-Host "  解压后未找到 model.onnx（压缩包异常），已清理。请重跑本脚本" -ForegroundColor Red
    Remove-Item -Recurse -Force $modelDir -ErrorAction SilentlyContinue
    Remove-Item -Force $modelFile -ErrorAction SilentlyContinue
    exit 1
  }
  Write-Host "  模型解压完成" -ForegroundColor Green
} else {
  Write-Host "  模型已存在，跳过下载" -ForegroundColor Green
}

# ---- 5. 写 local-tts.mjs 启动脚本（契约：node local-tts.mjs <文本> → stdout 输出 mp3）----
# 注意：JS 里含反引号模板字符串，必须用单引号 here-string（@'...'@）字面生成，再替换路径占位符
Write-Host "`n写入 local-tts.mjs 启动脚本..." -ForegroundColor Yellow
$exePath = "$InstallDir\bin\sherpa-onnx-offline-tts.exe".Replace('\', '/')
$basePath = "$InstallDir\models\melo".Replace('\', '/')
$launcherTemplate = @'
// local-tts.mjs — 本地 MeloTTS（sherpa-onnx VITS 中文模型）TTS 包装
// 契约（配合 dsh-input-tools 的"本地命令"）：文本作末参，stdout 输出音频字节（mp3）。
// 本文件由 install-local-tts.ps1 自动生成，勿手改；重装会重新生成。
import { execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const SHERPA = '__SHERPA__'
const BASE = '__BASE__'
const text = process.argv.slice(2).join(' ')
if (!text) {
  console.error('local-tts: 缺少文本参数')
  process.exit(1)
}
const tmp = join(process.env.TEMP ?? '/tmp', `dsh-local-tts-${process.pid}-${Date.now()}`)
const wav = `${tmp}.wav`
const mp3 = `${tmp}.mp3`
try {
  execFileSync(SHERPA, [
    '--vits-model=' + BASE + '/model.onnx',
    '--vits-tokens=' + BASE + '/tokens.txt',
    '--vits-lexicon=' + BASE + '/lexicon.txt',
    '--vits-dict-dir=' + BASE + '/dict',
    '--vits-length-scale=1.0',
    '--output-filename=' + wav,
    text,
  ], { windowsHide: true, stdio: 'ignore', timeout: 120_000 })
  // 本地合成音量偏小：ffmpeg 放大 4 倍并转 mp3
  execFileSync('ffmpeg', ['-y', '-i', wav, '-af', 'volume=4.0', '-c:a', 'libmp3lame', '-b:a', '128k', mp3], {
    windowsHide: true, stdio: 'ignore', timeout: 60_000,
  })
  process.stdout.write(readFileSync(mp3))
} finally {
  try { unlinkSync(wav) } catch { /* 忽略 */ }
  try { unlinkSync(mp3) } catch { /* 忽略 */ }
}
'@
$launcher = $launcherTemplate.Replace('__SHERPA__', $exePath).Replace('__BASE__', $basePath)
$launcherFile = Join-Path $InstallDir "local-tts.mjs"
Set-Content -Path $launcherFile -Value $launcher -Encoding UTF8
Write-Host "  local-tts.mjs: $launcherFile" -ForegroundColor Green

# ---- 6. 完成提示（命令只在路径含空格时才加引号；插件已能正确处理引号）----
Write-Host "`n==== 安装完成 ====" -ForegroundColor Cyan
$nodeExe = (Get-Command node).Source
$nodePart = if ($nodeExe -match ' ') { "`"$nodeExe`"" } else { $nodeExe }
$launcherPart = if ($launcherFile -match ' ') { "`"$launcherFile`"" } else { $launcherFile }
$cmdLine = "$nodePart $launcherPart"
Write-Host "请到 dsh 设置 → 语音服务 → 本地 TTS，把下面这行填进「本地命令」："
Write-Host ""
Write-Host "  $cmdLine" -ForegroundColor Green
Write-Host ""
Write-Host "然后点「试听本地 TTS」验证。若想用常驻 HTTP 模式，可自行加一层服务包装。" -ForegroundColor Cyan
