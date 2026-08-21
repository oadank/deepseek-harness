#!/usr/bin/env bash
# ============================================================
# dsh-input-tools 内置插件一键配置脚本（Linux/macOS）
# 作用：把仓库内置的语音插件（internal-plugins/dsh-input-tools）
#       注册进当前用户的 dsh profile，clone 即用、零手工配置。
# 用法：在源码仓库根目录：
#   bash scripts/setup-profile.sh [profile名字]   # 默认 web
# 幂等：重复运行安全（插件已存在则更新，已注册则跳过）。
# ============================================================
set -e

PROFILE_NAME="${1:-web}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_SRC="$REPO_ROOT/internal-plugins/dsh-input-tools"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILES_ROOT="$DSH_HOME/profiles"
PLUGIN_DST="$PROFILES_ROOT/node_modules/@oadank/dsh-input-tools"
PROFILE_DIR="$PROFILES_ROOT/$PROFILE_NAME"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

echo "==== dsh-input-tools 内置插件配置 ===="
echo "仓库根: $REPO_ROOT"

# 1. 校验插件源
if [ ! -f "$PLUGIN_SRC/package.json" ]; then
  echo "错误：找不到内置插件 $PLUGIN_SRC" >&2
  exit 1
fi

# 2. 复制插件到 profiles/node_modules/@oadank
echo ""
echo "[1/4] 安装插件到 profile..."
mkdir -p "$PROFILES_ROOT/node_modules/@oadank"
rm -rf "$PLUGIN_DST"
cp -r "$PLUGIN_SRC" "$PLUGIN_DST"
echo "  插件已安装: $PLUGIN_DST"

# 3. 注册到 cordis.patch.yml（幂等）
echo ""
echo "[2/4] 注册插件到 profile $PROFILE_NAME ..."
mkdir -p "$PROFILE_DIR"
INSERT_BLOCK=$(cat <<'EOF'

# [dsh-input-tools 自动生成] 语音能力一体化插件（host=语音工具/TTS/ASR/克隆/自动回复；client=工具条/语音设置页）
- insert:
    - id: dsh-input-tools
      name: '@oadank/dsh-input-tools'
EOF
)
if [ ! -f "$PATCH_FILE" ]; then
  printf '%s\n' "$INSERT_BLOCK" > "$PATCH_FILE"
  echo "  已创建 $PATCH_FILE 并注册插件"
elif grep -q "dsh-input-tools" "$PATCH_FILE"; then
  echo "  cordis.patch.yml 已含 dsh-input-tools，跳过注册。"
else
  printf '%s\n' "$INSERT_BLOCK" >> "$PATCH_FILE"
  echo "  已追加注册到现有 cordis.patch.yml"
fi

# 4. ffmpeg 检查
echo ""
echo "[3/4] 检查 ffmpeg..."
if command -v ffmpeg >/dev/null 2>&1; then
  echo "  ffmpeg 已就绪: $(command -v ffmpeg)"
else
  echo "  未检测到 ffmpeg（语音转码必需）。" >&2
  echo "  Debian/Ubuntu: sudo apt install ffmpeg"
  echo "  macOS: brew install ffmpeg"
fi

# 5. 可选 ASR 提示
echo ""
echo "[4/4] 可选：本地 ASR（离线语音识别）"
echo "  插件内有 scripts/install-asr.ps1（Windows 专用）。"
echo "  Linux 请自行部署 sherpa-onnx 识别服务监听 127.0.0.1:18790（POST /transcribe、GET /health），"
echo "  或用设置页的 ASR cmd/api 模式。"

echo ""
echo "==== 完成 ===="
echo "启动 dsh（在仓库根目录）："
echo "  pnpm install"
echo "  pnpm run build:web"
echo "  dsh --profile $PROFILE_NAME"
echo "（可用 systemd 注册为服务。）"
echo ""
echo "验证插件：打开设置 → 语音服务，能看到引擎配置/能力面板即注册成功。"
echo "升级仓库后重跑本脚本即可同步插件更新。"
