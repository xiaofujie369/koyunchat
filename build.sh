#!/bin/bash
# Koyun Chat 编译 / 上线脚本
# 在远程编译机上编译（本机内存小时很有用），产物取回 ./koyunchat；可选上传到线上服务器并重启。
#
# 服务器信息写在同目录的 build.env 里（已加入 .gitignore，不会上传仓库），参考 build.env.example。
# 用法：
#   bash build.sh            只编译
#   bash build.sh deploy     编译后上传线上并重启（线上旧程序备份为 koyunchat.prev）
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
[ -f "$HERE/build.env" ] || { echo "缺少 $HERE/build.env，请参考 build.env.example 创建"; exit 1; }
# shellcheck disable=SC1091
source "$HERE/build.env"
: "${BUILD_HOST:?build.env 里要填 BUILD_HOST}" "${BUILD_DIR:=/opt/koyunchat-build}"

# 编译机密码（可选）：BUILD_PASSWORD_FILE 指向的文件里以 BUILD_PASSWORD_KEY 开头的那一行，第二列是密码
SSH=(ssh -o StrictHostKeyChecking=accept-new)
if [ -n "${BUILD_PASSWORD_FILE:-}" ]; then
  export SSHPASS=$(grep -m1 "^${BUILD_PASSWORD_KEY:-编译机密码}" "$BUILD_PASSWORD_FILE" | awk '{print $2}')
  [ -n "$SSHPASS" ] || { echo "在 $BUILD_PASSWORD_FILE 里找不到编译机密码"; exit 1; }
  SSH=(sshpass -e "${SSH[@]}")
fi
ENV_CMD=${BUILD_GO_ENV:+source $BUILD_GO_ENV && }

echo "==> 同步源码到编译机"
"${SSH[@]}" "$BUILD_HOST" "mkdir -p $BUILD_DIR/src"
rsync -az --delete --exclude node_modules --exclude 'backend/web/admin/*' --exclude 'backend/web/user/*' --exclude data --exclude data-dev --exclude .git \
  --exclude koyunchat --exclude build.env -e "${SSH[*]}" "$HERE/" "$BUILD_HOST:$BUILD_DIR/src/"

echo "==> 在编译机上编译（低优先级）：先编译两个前端，再编译 Go 程序"
"${SSH[@]}" "$BUILD_HOST" "${ENV_CMD}cd $BUILD_DIR/src/admin && (npm ci --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error) && \
  nice -n 10 npm run build && cd $BUILD_DIR/src/user && (npm ci --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error) && \
  nice -n 10 npm run build && cd $BUILD_DIR/src/backend && export GOTOOLCHAIN=local CGO_ENABLED=0 && \
  nice -n 10 go vet . && nice -n 10 go build -trimpath -ldflags '-s -w' -o $BUILD_DIR/koyunchat . && sha256sum $BUILD_DIR/koyunchat"

echo "==> 取回程序"
rsync -az -e "${SSH[*]}" "$BUILD_HOST:$BUILD_DIR/koyunchat" "$HERE/koyunchat.new"
chmod +x "$HERE/koyunchat.new" && mv "$HERE/koyunchat.new" "$HERE/koyunchat"
sha256sum "$HERE/koyunchat"

if [ "${1:-}" = deploy ]; then
  : "${DEPLOY_HOST:?build.env 里要填 DEPLOY_HOST}" "${DEPLOY_DIR:=/opt/koyunchat}"
  echo "==> 上传到线上并重启（旧程序备份为 koyunchat.prev）"
  scp -q "$HERE/koyunchat" "$DEPLOY_HOST:$DEPLOY_DIR/koyunchat.new"
  ssh "$DEPLOY_HOST" "cd $DEPLOY_DIR && cp -p koyunchat koyunchat.prev && mv koyunchat.new koyunchat && systemctl restart koyunchat && sleep 2 && systemctl is-active koyunchat"
fi
echo "==> 完成"
