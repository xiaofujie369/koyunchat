# Koyun Chat 镜像：编译两个前端（React 管理面板、Vue 客户社区）和后端（Go），最终镜像只有一个程序
# 构建：docker build -t koyunchat .

# ---- 1. 编译管理面板 ----
FROM node:22-alpine AS admin
WORKDIR /src/admin
COPY admin/package.json admin/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY admin/ ./
RUN mkdir -p ../backend/web/admin && npm run build

# ---- 1b. 编译客户社区 ----
FROM node:22-alpine AS user
WORKDIR /src/user
COPY user/package.json user/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY user/ ./
RUN mkdir -p ../backend/web/user && npm run build

# ---- 2. 编译 Go 程序（纯 Go，不需要 CGO）----
FROM golang:1.26-alpine AS backend
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
COPY --from=admin /src/backend/web/admin ./web/admin
COPY --from=user /src/backend/web/user ./web/user
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /koyunchat .

# ---- 3. 运行 ----
FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata wget su-exec \
 && addgroup -S koyun && adduser -S -G koyun -h /data koyun
COPY --from=backend /koyunchat /usr/local/bin/koyunchat
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
ENV KC_ADDR=0.0.0.0:8790 KC_DATA=/data TZ=Asia/Shanghai
VOLUME /data
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8790/healthz || exit 1
ENTRYPOINT ["entrypoint.sh"]
