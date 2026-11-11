# Koyun Chat 客服系统

在线客服、团队办公和 AI 辅助的一体化系统，用来替代 tawk。多个网站可以统一接入同一套工作台。

- 后端：Go 单二进制（SQLite WAL、WebSocket），内存占用约 20–40MB
- 前端：工作台 `web/app`（Vue 3，无需构建），访客挂件 `web/widget.js`（Shadow DOM，原生 JS），客户社区 `web/c`，全部打包进二进制
- AI：Claude API（官方 Go SDK）或 OpenAI 兼容接口，支持中转地址
- IP 归属地：`data/geo.mmdb`（DB-IP City Lite，需自行下载）

## 功能

- 实时访客：IP、归属地、设备、当前页面（含 SPA 路由变化）、本页停留时长、浏览轨迹、访问次数、来源，也能主动发起对话
- 会话：分配和转接、内部备注、快捷回复（`/` 触发）、文件和截图（粘贴即发）、访客输入预览、结束会话后访客评分、桌面通知和提示音
- AI：
  - 自动接待（客服离线时接待 / AI 优先接待），客服一回复就自动停止，遇到无法回答的问题会转人工
  - 回复建议（结合知识库和访客账户信息）
  - 润色和多语种翻译
  - 会话总结
  - 团队群聊里 @AI
- 团队协作：公开频道、私人群组（邀请、移除、退出、解散）、私信、正在输入提示、未读数
- 客户社区：公开群、私密群（邀请链接）、公告频道；禁言、移出、封禁、慢速模式；客户身份通过 Xboard 接口验证
- Telegram 互通：社区群 ↔ TG 群双向同步；每个客服会话自动在 TG 客服群建话题，可直接在 TG 回复访客
- 系统声音：系统设置 → 系统声音设置（点开展开），上传本地提示音（mp3 / m4a / wav / ogg，≤2MB），可改名、替换、删除、设为默认；个人设置里可单独选择
- 插件管理（仿 Xboard）：
  - 邮件插件：自己填发件邮箱（任意 SMTP，可多个，可改可删，可测试），在会话里给离线客户发邮件，自动留内部备注和发送记录
- 管理：多站点（独立的颜色、欢迎语、域名白名单、AI 模式、知识库）、成员和角色、AI 配置

## 目录

| 路径 | 说明 |
|---|---|
| `server/` | 源码：main / db / auth / hub（WebSocket）/ visitor / agent / team / community / telegram / ai / sounds（系统声音）/ plugins（插件和邮件）/ util |
| `server/web/` | 前端静态资源（编译时打包进程序） |
| `build.sh` | 编译 / 上线脚本：在远程编译机上编译，可选上传到线上服务器 |
| `build.env.example` | `build.sh` 的配置示例，复制成 `build.env` 后填写（`build.env` 不会提交） |

## 编译

需要 Go 1.26+，纯 Go 实现（不需要 CGO）：

```bash
cd server && CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o ../koyunchat .
```

本机内存较小时，可以用 `build.sh` 在远程编译机上编译：

```bash
cp build.env.example build.env   # 填写编译机和线上服务器
bash build.sh                    # 只编译，产物取回 ./koyunchat
bash build.sh deploy             # 编译 + 上传线上 + 重启（旧程序备份为 koyunchat.prev）
```

## 运行

```bash
./koyunchat -data /opt/koyunchat/data -addr 127.0.0.1:8790 -api-url https://chatapi.example.com
./koyunchat -data /opt/koyunchat/data -admin-email you@example.com -admin-pass 新密码   # 创建或重置管理员
```

- 数据都在 `-data` 目录：`chat.db`（数据库）、`uploads/`（文件和提示音）、`geo.mmdb`（IP 库）。备份 `chat.db` 和 `uploads/` 即可
- 管理后台在随机路径 `/<admin_path>/`（首次启动生成，日志里会打印），根路径 `/` 是客户社区
- 建议用 systemd 运行，前面放 Nginx 反向代理（需要转发 WebSocket：`/ws/`）并配置 HTTPS
- 推荐两个域名：一个给后台和社区，一个给访客挂件、WebSocket 和 API

## 接入网站

站点管理 → 复制嵌入代码，放到 `</body>` 前：

```html
<script src="https://chatapi.example.com/widget.js" data-site="站点密钥" async></script>
```

Xboard：后台 → 系统配置 → 主题配置 → 自定义页脚 HTML，粘贴嵌入代码。
站点开启「Xboard 用户识别」后，挂件会在用户浏览器里同源读取 `/api/v1/user/info` 和 `getSubscribe`，把邮箱、套餐、到期、流量、余额带给客服。不需要改动 Xboard，也不会上传订阅链接和 UUID。

非 Xboard 网站可以在挂件代码之前写 `window.KoyunChat = { user: { email, name, ... } }` 传入用户信息。
`KoyunChat.open()` 和 `KoyunChat.close()` 可以用自己的按钮打开或关闭聊天窗口。
