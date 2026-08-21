# ============================================================
# dsh-input-tools 语音源码补丁脚本（Windows）
# 作用：给【官方源码】版 deepseek-harness 打上语音增强补丁
#   （原生语音消息气泡 / AI 语音回复 / voice content 契约）
# 适用版本：官方 deepseek-harness rc.8（commit 141eb6fef8，
#   即 dsh-0.1.0-rc.8 release 合并点）
# 用法：在源码仓库根目录执行（或 -RepoPath 指定）：
#   powershell -ExecutionPolicy Bypass -File apply-voice-patch.ps1
# 前置：已 git clone 官方仓库并 checkout 到 rc.8 基线
# ============================================================
param(
  [string]$RepoPath = ""
)

$ErrorActionPreference = "Stop"
$Patch = Join-Path $PSScriptRoot "dsh-voice-rc8.patch"
$Marker = "本地改造 2026-08-14"   # 补丁内的指纹标记（api-request-trust.ts）

# ── 自动探测源码仓库位置（小白无需知道路径）────────────────────
function Find-Repo {
  # 1. 显式指定
  if ($RepoPath -ne "" -and (Test-Path (Join-Path $RepoPath ".git"))) { return $RepoPath }
  # 2. 当前目录及向上 6 层（脚本可能放在源码仓库里/附近）
  $cur = (Get-Location).Path
  for ($i = 0; $i -le 6; $i++) {
    if (Test-Path (Join-Path $cur ".git")) { return $cur }
    $parent = Split-Path $cur -Parent
    if ($parent -eq $cur) { break }
    $cur = $parent
  }
  # 3. 找不到了——不猜固定路径（客户源码位置可能在任何盘符），返回空让用户输入
  return $null
}

Write-Host "==== dsh 语音源码补丁 ====" -ForegroundColor Cyan
if ($RepoPath -eq "") {
  $found = Find-Repo
  if ($found) {
    $RepoPath = $found
    Write-Host "自动检测到源码仓库: $RepoPath" -ForegroundColor Green
  } else {
    # 找不到 → 交互式让用户输入源码路径（不限定任何盘符/位置）
    Write-Host "`n未自动检测到源码仓库。" -ForegroundColor Yellow
    Write-Host "请把源码仓库根目录（git clone 出来的 deepseek-harness 文件夹）路径告诉我："
    $input = Read-Host "dsh 源码仓库路径"
    if ($input -ne "" -and (Test-Path (Join-Path $input ".git"))) {
      $RepoPath = $input.Trim().Trim('"').Trim("'")
      Write-Host "已使用: $RepoPath" -ForegroundColor Green
    } else {
      Write-Host "路径无效或不是 git 仓库（需要包含 .git 目录）。" -ForegroundColor Red
      Write-Host "可用 -RepoPath 参数直接指定：" -ForegroundColor Yellow
      Write-Host "  powershell -ExecutionPolicy Bypass -File apply-voice-patch.ps1 -RepoPath D:\anywhere\deepseek-harness" -ForegroundColor Yellow
      exit 1
    }
  }
}
Write-Host "源码目录: $RepoPath"
Write-Host "补丁文件: $Patch"

# 1. 校验 git 仓库
if (-not (Test-Path (Join-Path $RepoPath ".git"))) {
  Write-Host "  错误：$RepoPath 不是 git 仓库（未 git clone 官方源码？）" -ForegroundColor Red
  exit 1
}
Set-Location $RepoPath

# 2. 幂等：已打过则跳过
if (Test-Path "packages\client\connection\src\api-request-trust.ts") {
  if (Select-String -Path "packages\client\connection\src\api-request-trust.ts" -Pattern $Marker -Quiet) {
    Write-Host "  检测到语音补丁已应用，跳过。" -ForegroundColor Green
    exit 0
  }
}

# 3. 应用前自检（git apply --check 不实际改动）
Write-Host "`n[1/3] 校验补丁可应用..." -ForegroundColor Yellow
git apply --check $Patch
if ($LASTEXITCODE -ne 0) {
  Write-Host "  补丁无法应用：请确认源码是官方 rc.8（git checkout 到 commit 141eb6fef8 或 tag dsh-0.1.0-rc.8）。" -ForegroundColor Red
  Write-Host "  官方更新后的 master 与本补丁不兼容，请勿在 master 上直接应用。" -ForegroundColor Yellow
  exit 1
}
Write-Host "  校验通过。" -ForegroundColor Green

# 4. 备份当前未提交改动（用于回滚）
Write-Host "`n[2/3] 备份当前工作区改动..." -ForegroundColor Yellow
$Backup = Join-Path $RepoPath (".voice-patch-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".patch")
git diff > $Backup 2>$null
if ((Get-Item $Backup).Length -gt 0) {
  Write-Host "  已有未提交改动，已备份到 $Backup" -ForegroundColor Green
} else {
  Remove-Item $Backup -Force -ErrorAction SilentlyContinue
  Write-Host "  工作区干净，无需备份。" -ForegroundColor Green
}

# 5. 应用补丁
Write-Host "`n[3/3] 应用语音补丁..." -ForegroundColor Yellow
git apply $Patch
if ($LASTEXITCODE -ne 0) {
  Write-Host "  补丁应用失败（已备份可回滚）" -ForegroundColor Red
  exit 1
}
Write-Host "  补丁已应用！" -ForegroundColor Green

Write-Host ""
Write-Host "==== 完成 ====" -ForegroundColor Cyan
Write-Host "后续步骤："
Write-Host "  1. pnpm install"
Write-Host "  2. pnpm run build:web     （构建前端，语音气泡渲染在此步生效）"
Write-Host "  3. 启动 dsh：dsh --profile web（Windows 可注册为 nssm/systemd 服务）"
Write-Host "  4. 安装语音插件：dsh plugin --profile web add @oadank/dsh-input-tools"
Write-Host "回滚：git checkout -- <文件> 或 git apply -R $Patch"
