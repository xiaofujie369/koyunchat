#!/bin/sh
# 修正数据目录权限（宿主机挂载的目录通常属于 root），然后用普通用户运行
set -e
mkdir -p "${KC_DATA:-/data}"
chown -R koyun:koyun "${KC_DATA:-/data}" 2>/dev/null || true
exec su-exec koyun koyunchat "$@"
