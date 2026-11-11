# Koyun Chat 客服系统

在线客服、团队办公、客户社区和 AI 辅助的一体化系统，用来替代 tawk。多个网站可以统一接入同一套工作台。

| 部分 | 技术 | 目录 |
|---|---|---|
| 后端 | Go 单程序（SQLite WAL、WebSocket），内存约 20–40MB | `backend/` |
| 管理面板 | React 19 + TypeScript + shadcn/ui（Radix）+ TailwindCSS 4 + Zustand | `admin/` |
| 客户社区 | Vue 3 + TypeScript + NaiveUI | `user/` |
| 访客挂件 | 原生 JS（Shadow DOM），不依赖任何框架 | `backend/web/widget.js` |
| 部署 | Docker + Docker Compose（可选自带 Caddy 自动 HTTPS） | `Dockerfile`、`docker-compose.yml` |
| AI | Claude API 或 OpenAI 兼容接口，支持中转地址 | |

两个前端编译后打包进 Go 程序，最终只有一个文件，部署和备份都很简单。

## 一键部署（Docker）

```bash
git clone https://github.com/xiaofujie369/koyunchat.git && cd koyunchat
cp .env.example .env          # 填 KC_API_URL 等
docker compose up -d          # 拉取镜像并启动（想自己编译：docker compose build）
docker compose exec -u koyun koyunchat koyunchat -admin-email you@example.com -admin-pass 你的密码   # 创建管理员
docker compose logs koyunchat | grep "console at"     # 查看管理后台地址（随机路径）
```

- 数据在 `./data`：`chat.db`（数据库）、`uploads/`（文件和提示音）。备份这两个即可
- 默认只监听本机 `127.0.0.1:8790`，前面放 Nginx 反向代理（要转发 WebSocket 的 `/ws/`）
- 没有现成的反向代理？在 `.env` 填好两个域名后 `docker compose --profile caddy up -d`，自带的 Caddy 会自动申请 HTTPS 证书
- IP 归属地（可选）：把 [DB-IP City Lite](https://db-ip.com/db/download/ip-to-city-lite)（mmdb 格式）放到 `data/geo.mmdb` 后重启
- 健康检查：`GET /healthz`
- 镜像由 GitHub Actions 自动构建（`ghcr.io/xiaofujie369/koyunchat`，支持 amd64 / arm64）

推荐两个域名：一个给后台和社区（例如 `chat.example.com`），一个给访客挂件、WebSocket 和接口（例如 `chatapi.example.com`）。

## 地址

| 地址 | 内容 |
|---|---|
| `/<随机路径>/` | 管理面板（首次启动生成，日志里会打印） |
| `/<随机路径>/legacy/` | 旧版管理面板（过渡期保留） |
| `/`、`/c/` | 客户社区 |
| `/c/legacy/` | 旧版客户社区（过渡期保留） |
| `/widget.js` | 访客挂件 |

## 本地开发

```bash
# 后端
cd backend && go run . -data ./dev-data
# 管理面板（热更新，接口代理到 127.0.0.1:8790）
cd admin && npm install && npm run dev
# 客户社区
cd user && npm install && npm run dev
```

不用 Docker 编译单个程序：

```bash
(cd admin && npm ci && npm run build) && (cd user && npm ci && npm run build)
cd backend && CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o ../koyunchat .
```

本机内存小时，可以用 `build.sh` 在远程编译机上编译（`cp build.env.example build.env` 后填写）：`bash build.sh`，加 `deploy` 参数会上传到线上服务器并重启。

不用 Docker 运行：`./koyunchat -data /opt/koyunchat/data -addr 127.0.0.1:8790 -api-url https://chatapi.example.com`（这几个参数也可以用环境变量 `KC_DATA`、`KC_ADDR`、`KC_API_URL` 设置）。

## 功能

- 实时访客：IP、归属地、设备、当前页面（含 SPA 路由变化）、本页停留时长、浏览轨迹、访问次数、来源，也能主动发起对话
- 会话：分配和转接、内部备注、快捷回复（`/` 触发）、文件和截图（粘贴即发）、访客输入预览、结束会话后访客评分、桌面通知和提示音
- AI：自动接待（客服离线时 / AI 优先，客服一回复就停止，答不了转人工）、回复建议（结合知识库和访客账户信息）、润色和多语种翻译、会话总结、团队群聊里 @AI
- 团队协作：公开频道、私人群组（邀请、移除、退出、解散）、私信、正在输入提示、未读数
- 客户社区：公开群、私密群（邀请链接）、公告频道；禁言、移出、封禁、慢速模式；客户身份通过 Xboard 接口验证，群里只显示昵称
- Telegram 互通：社区群 ↔ TG 群双向同步；每个客服会话自动在 TG 客服群建话题，可直接在 TG 回复访客
- 系统设置：每一项单独点开展开，标题行显示当前状态（系统声音、AI、Telegram）
- 系统声音：上传本地提示音（mp3 / m4a / wav / ogg，≤2MB），可改名、替换、删除、设为默认；个人设置里可单独选择
- 插件管理（仿 Xboard）：邮件插件——自己填发件邮箱（任意 SMTP，可多个，可改可删，可测试），在会话里给离线客户发邮件，自动留内部备注和发送记录
- 管理：多站点（独立的颜色、欢迎语、域名白名单、AI 模式、知识库）、成员和角色；浅色 / 深色主题

## 接入网站

站点管理 → 复制嵌入代码，放到 `</body>` 前：

```html
<script src="https://chatapi.example.com/widget.js" data-site="站点密钥" async></script>
```

Xboard：后台 → 系统配置 → 主题配置 → 自定义页脚 HTML，粘贴嵌入代码。
站点开启「Xboard 用户识别」后，挂件会在用户浏览器里同源读取 `/api/v1/user/info` 和 `getSubscribe`，把邮箱、套餐、到期、流量、余额带给客服。不需要改动 Xboard，也不会上传订阅链接和 UUID。

非 Xboard 网站可以在挂件代码之前写 `window.KoyunChat = { user: { email, name, ... } }` 传入用户信息。
`KoyunChat.open()` 和 `KoyunChat.close()` 可以用自己的按钮打开或关闭聊天窗口。
