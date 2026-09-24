#!/usr/bin/env bash
# ============================================================
# dsh-input-tools 插件一键配置脚本（Linux/macOS）
# 作用：从 npm 安装语音插件 @oadank/dsh-input-tools 到当前用户的
#       dsh profile 并注册（dsh.profile.bundles），clone 即用、零手工配置。
# 插件不再内置于仓库（internal-plugins 已移除）——单一真源 = npm / 插件仓库。
# 用法：在源码仓库根目录：
#   bash scripts/setup-profile.sh [profile名字]   # 默认 web
# 幂等：重复运行安全（dsh plugin add 已装则更新到 latest）。
# 前置：dsh CLI 可用（本仓库 pnpm install 之后：pnpm exec dsh，或已全局安装）。
# ============================================================
set -e

PROFILE_NAME="${1:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILES_ROOT="$DSH_HOME/profiles"
PLUGIN_RT="$PROFILES_ROOT/node_modules/@oadank/dsh-input-tools"

echo "==== dsh-input-tools 插件配置（npm 源）===="

# 1. 从 npm 安装并注册插件（官方 dsh plugin 通道）
echo ""
echo "[1/3] 安装插件 @oadank/dsh-input-tools（npm 官方源）..."
if command -v dsh >/dev/null 2>&1; then
  DSH_CMD="dsh"
else
  echo "  未找到 dsh 命令，尝试 pnpm exec dsh（需先 pnpm install）..."
  DSH_CMD="pnpm exec dsh"
fi
$DSH_CMD plugin --profile "$PROFILE_NAME" add @oadank/dsh-input-tools --registry=https://registry.npmjs.org/
if [ ! -f "$PLUGIN_RT/package.json" ]; then
  echo "错误：未在 $PLUGIN_RT 找到插件安装产物，请检查上面输出。" >&2
  exit 1
fi
echo "  插件已安装并注册: $PLUGIN_RT"

# 2. ffmpeg 检查
echo ""
echo "[2/3] 检查 ffmpeg..."
if command -v ffmpeg >/dev/null 2>&1; then
  echo "  ffmpeg 已就绪: $(command -v ffmpeg)"
else
  echo "  未检测到 ffmpeg（语音转码必需）。" >&2
  echo "  Debian/Ubuntu: sudo apt install ffmpeg"
  echo "  macOS: brew install ffmpeg"
fi

# 3. 可选 ASR 提示
echo ""
echo "[3/3] 可选：本地 ASR（离线语音识别）"
echo "  插件内有 scripts/install-asr.ps1（Windows 专用）。"
echo "  Linux 请自行部署 sherpa-onnx 识别服务监听 127.0.0.1:18790（POST /transcribe、GET /health），"
echo "  或用设置页的 ASR cmd/api 模式。"

echo ""
echo "==== 完成 ===="
echo "启动 dsh（在仓库根目录）："
echo "  pnpm install && pnpm run build:lib && pnpm run build:web"
echo "  pnpm exec dsh --profile $PROFILE_NAME"
echo "（Windows 可用 nssm 注册为服务；Linux 用 systemd。）"
echo ""
echo "验证插件：打开设置 → 语音服务，能看到引擎配置/能力面板即注册成功。"
echo "升级插件：重跑本脚本（npm 拉取 latest）。"
