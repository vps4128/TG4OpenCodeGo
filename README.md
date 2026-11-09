# TG4OpenCodeGo

通过 Telegram 查询 OpenCode Go 订阅用量，并定时主动推送的机器人。

> 仓库已从 `oc-tg` 更名为 `TG4OpenCodeGo`。容器名、数据卷、systemd 服务名等运行时标识仍沿用 `oc-tg`，以免影响已有部署。

- 查询 5 小时滚动 / 每周 / 每月三个窗口的已用百分比和重置时间
- 每天定时推送用量汇总，时间可自定义（支持多个时间点）
- 用量跨过阈值（默认 50/80/95/100%）时主动告警
- 额度用尽或窗口状态异常时告警
- 每个聊天独立配置时区、推送时间、阈值
- Long Polling，无需公网 IP、域名或 HTTPS 证书
- SQLite 本地存储，单容器部署

## 效果

```text
📊 OpenCode Go 用量
🕐 2026-10-22 23:47 (GMT+8)

5 小时窗口  ░░░░░░░░░░  1%
　↳ 04:22 重置（4小时34分后）
本周        ██░░░░░░░░  22%
　↳ 10-26 08:00 重置（3天8小时12分后）
本月        █░░░░░░░░░  11%
　↳ 11-20 11:52 重置（28天12小时5分后）

🟢 状态正常 · 更新于 23:47
🚦 告警阈值：50/80/95/100%
🔔 定时推送：09:00 · 下次 10-23 09:00
```

## 快速开始（Docker）

### 1. 创建 Telegram 机器人

在 Telegram 里找 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，按提示创建后拿到 Token。

### 2. 创建 OpenCode Go API Key

登录 [opencode.ai](https://opencode.ai) 控制台，进入 **Settings → API Keys**，创建一个 Key（`sk-...`）。

建议为机器人单独创建一个 Key，方便随时吊销。

### 3. 配置并启动

```bash
cp .env.example .env
# 编辑 .env，至少填写：
#   TELEGRAM_BOT_TOKEN=...
#   OPENCODE_API_KEY=sk-...
chmod 600 .env
docker compose pull
docker compose up -d
docker compose logs -f
```

> 镜像由 GitHub Actions 构建并推送到 `ghcr.io/vps4128/tg4opencodego`。首次使用前请确认仓库的 Actions 已成功运行；如果镜像是私有的，先执行 `docker login ghcr.io`（见“镜像构建”）。

### 4. 绑定并查询

私聊机器人发送 `/start`。如果没有设置 `ALLOWED_USER_IDS`，第一个发送 `/start` 的用户会自动成为 owner。

然后发送 `/usage` 即可看到用量。

> 如果担心 bot 在绑定前被其他人使用，可以先给机器人发任意消息拿到自己的 user id，填入 `ALLOWED_USER_IDS` 后再启动。

> 群聊中默认不开启定时推送，需要 owner 在群里发送 `/subscribe`。

## 本机运行

需要 Node.js 24+（使用内置 `node:sqlite`，无需编译原生模块）。

```bash
npm install
cp .env.example .env
npm run dev
```

生产构建：

```bash
npm run build
npm start
```

健康检查（同时检查用量拉取和 Telegram 轮询心跳）：

```bash
npm run healthcheck
```

## 命令

| 命令 | 说明 |
|---|---|
| `/start` | 绑定 owner、查看欢迎信息 |
| `/help` | 查看全部命令 |
| `/usage` | 立即查询三个窗口用量 |
| `/subscribe` | 开启定时推送 |
| `/unsubscribe` | 关闭定时推送（阈值告警不受影响） |
| `/times 09:00,20:00` | 设置每天推送时间（最多 6 个） |
| `/times default` | 恢复默认推送时间 |
| `/threshold 50,80,95,100` | 设置告警阈值（最多 10 个） |
| `/threshold off` | 关闭全部主动告警 |
| `/tz Asia/Shanghai` | 设置当前聊天的时区 |
| `/history` | 查看最近 10 次用量快照 |
| `/status` | 查看配置、最后拉取时间、下次推送 |
| `/test` | 立即发送一条测试消息 |
| `/id` | 查看 chat id / user id |

用量消息附带按钮：`🔄 刷新`、`🔔/🔕 推送开关`、`📈 历史`。

手动刷新有 30 秒冷却。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | 必填 | BotFather 获取的 Token |
| `OPENCODE_API_KEY` | 必填 | OpenCode Go API Key |
| `OPENCODE_BASE_URL` | `https://opencode.ai` | API 地址 |
| `OPENCODE_USAGE_PATH` | `/inference/go/v1/usage` | 用量接口路径 |
| `ALLOWED_USER_IDS` | 空 | 允许使用的 user id，逗号分隔 |
| `DEFAULT_TZ` | `Asia/Shanghai` | 新聊天的默认时区 |
| `DEFAULT_PUSH_TIMES` | `09:00` | 新聊天的默认推送时间 |
| `CHECK_INTERVAL_MIN` | `15` | 用量轮询间隔（分钟，最小 5） |
| `ALERT_THRESHOLDS` | `50,80,95,100` | 新聊天的默认阈值 |
| `SQLITE_PATH` | `./data/oc-tg.db` | SQLite 文件路径 |
| `HEALTH_FILE` | 与 SQLite 同目录的 `heartbeat` | 用量拉取心跳文件 |
| `TELEGRAM_HEALTH_FILE` | 与 SQLite 同目录的 `telegram-heartbeat` | 轮询心跳文件 |
| `LOG_LEVEL` | `info` | pino 日志级别 |

## 推送与告警规则

### 定时推送

- 按每个聊天的时区、`/times` 配置的时间发送。
- 发送时拉取最新数据；失败时如果存在旧快照，会发送旧数据并标注“数据可能已过期”。

### 阈值告警

- 每次成功拉取后，与上一条快照比较，找出新跨过的阈值。
- 同一 `窗口 + 重置时间 + 阈值` 只发送一次。
- 如果两次轮询之间从 40% 直接跳到 85%，会补发 50%、80% 两条，不会漏。
- 窗口重置后（`resetsAt` 变化），新周期可以再次告警。
- `/threshold off` 会同时关闭阈值告警、100% 通知和状态异常通知。

### 异常通知

- API Key 无效（401/403）、接口持续失败时通知 owner，同一类错误每小时最多一次。
- Telegram 返回 403（机器人被屏蔽）时，自动停止该聊天的推送。

## 部署

### Docker Compose（推荐）

`docker-compose.yml` 直接使用 GHCR 上的镜像。更新版本：

```bash
docker compose pull
docker compose up -d
```

数据保存在命名卷 `oc-tg-data` 中：

```bash
docker volume inspect oc-tg_oc-tg-data
```

备份：

```bash
docker run --rm -v oc-tg_oc-tg-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/oc-tg-data.tar.gz -C /data .
```

如果希望直接访问 SQLite 文件，把 `docker-compose.yml` 中的卷改成 `./data:/app/data`，并先执行：

```bash
mkdir -p data
chown 1000:1000 data
```

### systemd

```bash
sudo useradd --system --home /opt/oc-tg --shell /usr/sbin/nologin oc-tg
sudo mkdir -p /opt/oc-tg
sudo cp -r dist package.json package-lock.json deploy /opt/oc-tg/
sudo cp .env /opt/oc-tg/.env
sudo chown -R oc-tg:oc-tg /opt/oc-tg
cd /opt/oc-tg && sudo -u oc-tg npm ci --omit=dev
sudo cp deploy/oc-tg.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now oc-tg
sudo journalctl -u oc-tg -f
```

> `deploy/oc-tg.service` 中的 `/usr/bin/node` 需按实际 Node 路径调整（用 `which node` 查看）。

## 常见问题

**401 / API Key 无效**

在 OpenCode 控制台重新创建 API Key，更新 `.env` 后重启容器：

```bash
docker compose up -d --force-recreate
```

**收不到定时推送**

1. `/status` 检查推送是否开启、下次推送时间。
2. 确认聊天时区正确（`/tz`）。
3. 群聊需要 owner 发送 `/subscribe`。
4. 查看 `docker compose logs -f`。

**429 限流**

程序会读取 `Retry-After` 自动退避，一般无需处理。手动刷新请间隔 30 秒以上。

**按钮没反应 / 突然收不到消息**

通常是通过代理或 TUN 访问 Telegram 时长轮询连接被静默挂起。程序已为 `getUpdates` 设置 45 秒客户端超时，并写入轮询心跳；健康检查超过 5 分钟没有成功轮询会标记 unhealthy。可以：

```bash
docker compose ps
docker compose restart
```

如果仍然复现，把 `.env` 里的 `LOG_LEVEL` 改成 `debug` 后重启，日志会记录每个 update 的类型。

**时区**

使用 IANA 时区名，例如 `Asia/Shanghai`、`Asia/Tokyo`、`Europe/London`。不要填 `UTC+8`。

**数据保留**

快照、告警状态和推送日志保留 90 天，每天自动清理。

## 开发与测试

```bash
npm run typecheck
npm test
npm run build
```

测试覆盖 API 客户端（200/401/429/5xx/超时/非法 JSON）、格式化、阈值跨越、调度参数、SQLite 读写和告警去重。

目录结构：

```text
src/
├─ index.ts            启动与优雅退出
├─ config.ts           环境变量校验
├─ opencode.ts         用量 API 客户端
├─ format.ts           消息与时间格式化
├─ alerts.ts           阈值/异常事件计算
├─ db.ts               SQLite 存储
├─ usage-coordinator.ts 拉取、存快照、评估告警
├─ scheduler.ts        定时推送与轮询
├─ notifier.ts         Telegram 发送封装
├─ bot.ts              命令与按钮
└─ healthcheck.ts      Docker 健康检查
```

## 镜像构建（GitHub Actions）

每次 `git push`（任意分支或 tag），[.github/workflows/docker.yml](.github/workflows/docker.yml) 会：

1. 安装依赖、类型检查、运行测试
2. 构建 Docker 镜像
3. 推送到 GitHub Container Registry：`ghcr.io/vps4128/tg4opencodego`

镜像标签：

- `latest`：`main` 分支最新构建
- `<branch>`：对应分支的最新构建
- `sha-<commit>`：按提交区分
- `v1.2.3` 等：推送 `v*` 标签时生成

PR 只构建、不推送。

部署机器更新：

```bash
docker compose pull
docker compose up -d
```

如果镜像/包是私有的，需要先登录 GHCR（PAT 勾选 `read:packages`）：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u vps4128 --password-stdin
```

也可以把镜像设为公开：GitHub → Packages → `tg4opencodego` → Package settings → Change visibility。

本地开发直接 `npm run dev`；需要本地构建镜像时：

```bash
docker build -t ghcr.io/vps4128/tg4opencodego:latest .
```

## 安全说明

- API Key 只保存在 `.env`，不会写入数据库、日志或 Telegram 消息。
- 非 owner / 非白名单用户无法使用机器人。
- 使用 Long Polling，不开放任何入站端口。
- 容器以非 root 用户运行，数据目录单独挂载。
- `.env` 已在 `.gitignore` 和 `.dockerignore` 中排除。

## 接口说明

用量数据来自：

```http
GET https://opencode.ai/inference/go/v1/usage
Authorization: Bearer <OpenCode Go API Key>
```

返回三个窗口的 `status`、`percent` 和 `resetsAt`。该接口不提供分模型明细，因此本工具只展示三个窗口的汇总。
