# cloud-mail-worker

📬 Cloudflare Email Worker — 邮件接收并转发到飞书群机器人

基于 [maillab/cloud-mail](https://github.com/maillab/cloud-mail) 的思路，专为飞书用户定制的邮件通知 Worker。

---

## 架构

```
发件人 → Cloudflare Email Routing → Cloudflare Worker → 飞书群机器人
                                    ├─ 解析邮件（发件人/主题/正文）
                                    ├─ 白名单/黑名单过滤
                                    └─ POST 到飞书 Webhook
```

## 快速部署

### 前置条件

1. **Cloudflare 账号** — [注册](https://dash.cloudflare.com/signup)
2. **域名** — 在 Cloudflare 管理 DNS
3. **飞书群机器人** — 在飞书群中创建机器人 Webhook

### 第一步：获取飞书群机器人 Webhook

1. 打开飞书群 → 群设置 → **群机器人**
2. 点击 **添加机器人**，选择 **自定义机器人（通过 Webhook 发送消息）**
3. 设置机器人名称（如「邮件通知」）
4. 复制 Webhook 地址，格式如下：
   ```
   https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```
5. 点击「完成」

> **安全性建议：** 在飞书机器人设置中开启 **IP 白名单**，将 Cloudflare Worker 的出口 IP 加入白名单（参考 [Cloudflare IP 范围](https://www.cloudflare.com/ips/)）

### 第二步：配置并部署

```bash
# 1. 进入项目目录
cd cloud-mail-worker

# 2. 安装依赖
npm install

# 3. 设置飞书 Webhook URL（作为加密 secret）
npx wrangler secret put FEISHU_WEBHOOK_URL
# 粘贴你的飞书机器人 Webhook URL

# 4. （可选）如果要在多个群中转发
npx wrangler secret put FEISHU_WEBHOOK_URL_2
npx wrangler secret put FEISHU_WEBHOOK_URL_3

# 5. 部署 Worker
npx wrangler deploy
```

### 第三步：配置邮件路由

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 选择你的域名 → **Email** → **Email Routing**
3. 完成域名邮件设置（添加 MX 记录等，按 Dashboard 引导操作）
4. 在 **Routing rules** 中添加规则：
   - 动作: **Send to Worker**
   - Worker: **cloud-mail-worker**
   - 匹配规则: `*@你的域名.com` 或具体的地址

## 配置说明

### 环境变量 / Secrets

| 变量名 | 是否必填 | 说明 |
|---|---|---|
| `FEISHU_WEBHOOK_URL` | **是** | 飞书群机器人 Webhook URL |
| `FEISHU_WEBHOOK_URL_2` | 否 | 第二个飞书群 Webhook（可选） |
| `FEISHU_WEBHOOK_URL_3` | 否 | 第三个飞书群 Webhook（可选） |
| `ALLOWED_SENDERS` | 否 | 白名单，逗号分隔，留空=允许所有 |
| `BLOCKED_SENDERS` | 否 | 黑名单，逗号分隔，支持通配符 `*@spam.com` |
| `FEISHU_MSG_TITLE` | 否 | 飞书消息标题，默认「📬 新邮件通知」 |
| `FEISHU_MSG_TAG` | 否 | 消息前缀标签，如「[外部邮件]」 |
| `FEISHU_USE_CARD` | 否 | 设为 `true` 使用消息卡片格式（更美观） |
| `FEISHU_MAX_BODY_PREVIEW` | 否 | 正文预览最大字符数，默认 800 |
| `LOG_LEVEL` | 否 | 日志级别：`debug` / `info` / `warn` / `error` |
| `AUTH_TOKEN` | 否 | HTTP 测试接口的鉴权 token |

**建议将 `FEISHU_WEBHOOK_URL*` 用 `wrangler secret put` 设置**（加密存储），其他变量可以用 `[vars]` 在 `wrangler.toml` 中配置。

### 发件人过滤规则

```
优先级: 黑名单 > 白名单 > 默认允许

示例：
  BLOCKED_SENDERS = spam@example.com,*@bad-domain.com
  ALLOWED_SENDERS = friend@example.com

结果：只接受 friend@example.com 的邮件，即使它在白名单中也先过黑名单
```

## 自定义开发

### 目录结构

```
cloud-mail-worker/
├── src/
│   ├── index.js          # 主入口 — 邮件处理逻辑
│   ├── email-parser.js   # 邮件解析（RFC 2822 / MIME）
│   └── feishu.js         # 飞书机器人 API 封装
├── wrangler.toml         # Cloudflare Worker 配置
├── package.json
├── .env.example          # 环境变量示例
└── README.md
```

### 本地测试

```bash
# 启动本地开发服务器（仅 HTTP 部分可测）
npx wrangler dev

# 访问健康检查
curl http://localhost:8787/health

# 发送测试消息（需配置 AUTH_TOKEN）
curl -X POST http://localhost:8787/test \
  -H "X-Auth-Token: your-token" \
  -H "Content-Type: application/json"
```

> 注意：`wrangler dev` 不能完整模拟 Email Routing，完整测试需要部署后发真实邮件。

### 飞书消息格式切换

编辑 `src/index.js` 中 `sendEmailCardNotification` 与 `sendEmailNotification` 的切换逻辑。

- **富文本（post）** — 默认，文字信息为主，兼容性好
- **消息卡片（interactive）** — 设置 `FEISHU_USE_CARD=true`，视觉效果更好

## 常见问题

**Q: 收不到飞书通知？**
1. 检查 `wrangler tail` 日志是否有报错
2. 确认飞书 Webhook URL 正确
3. 确认域名已完成 Email Routing 设置（MX 记录等）
4. 检查发件人过滤规则

**Q: 飞书返回 `code: 10003`？**
→ Webhook URL 不正确或已失效，在飞书群中重新生成。

**Q: 邮件正文乱码？**
→ 部分非 UTF-8 编码邮件可能需要调整 `email-parser.js` 中的解码逻辑。默认支持 UTF-8/Base64/Quoted-Printable 解码。

## License

MIT
