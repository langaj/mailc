/**
 * index.js — Cloudflare Email Worker 主入口
 *
 * 功能：接收邮件 → 解析 → 转发到飞书群机器人
 *
 * 部署要求：
 *   1. 设置环境变量或 secret: FEISHU_WEBHOOK_URL
 *   2. 在 Cloudflare Dashboard → Email → Email Routing 中配置路由规则
 *   3. 用 `npx wrangler deploy` 部署
 */

import { parseEmail } from './email-parser.js';
import { sendEmailNotification, broadcastToFeishu } from './feishu.js';

// ============================================================
// 邮件事件处理 — Cloudflare Email Routing 触发
// ============================================================
export default {
  /**
   * 邮件接收处理入口
   * @param {EmailMessage} message - Cloudflare 邮件对象
   * @param {object} env - 环境变量 / secrets
   * @param {ExecutionContext} ctx - 执行上下文
   */
  async email(message, env, ctx) {
    const logger = createLogger(env.LOG_LEVEL || 'info');
    const startTime = Date.now();

    logger.info('📧 收到新邮件', {
      from: message.from,
      to: message.to,
      headers: {
        subject: message.headers.get('subject'),
      },
    });

    try {
      // ---- Step 1: 发件人过滤 ----
      const senderFilter = filterSender(message.from, env);
      if (!senderFilter.allowed) {
        logger.info('⏭️ 发件人被过滤', { from: message.from, reason: senderFilter.reason });
        return;
      }

      // ---- Step 2: 解析邮件内容 ----
      const email = await parseEmail(message.raw);
      logger.info('✅ 邮件解析完成', {
        subject: email.subject,
        from: email.from,
        hasText: !!email.textBody,
        hasHtml: !!email.htmlBody,
        size: email.textBody ? email.textBody.length : 0,
      });

      // ---- Step 3: 获取飞书 Webhook 列表 ----
      const webhookUrls = getFeishuWebhooks(env);
      if (webhookUrls.length === 0) {
        logger.error('❌ 未配置飞书 Webhook URL，请在环境变量 / secrets 中设置 FEISHU_WEBHOOK_URL');
        return;
      }

      // ---- Step 4: 发送到飞书（默认使用富文本格式） ----
      const useCard = env.FEISHU_USE_CARD === 'true';
      const sendFn = useCard
        ? (await import('./feishu.js')).sendEmailCardNotification
        : sendEmailNotification;

      const results = await broadcastToFeishu(webhookUrls, sendFn, email, {
        title: env.FEISHU_MSG_TITLE || '📬 新邮件通知',
        tag: env.FEISHU_MSG_TAG || '',
        maxBodyPreview: parseInt(env.FEISHU_MAX_BODY_PREVIEW || '800', 10),
      });

      const elapsed = Date.now() - startTime;
      const successCount = results.filter(r => r.ok).length;
      logger.info(`✅ 飞书转发完成 (${successCount}/${results.length})`, {
        results,
        elapsedMs: elapsed,
      });

    } catch (error) {
      logger.error('❌ 邮件处理失败', {
        error: error.message,
        stack: error.stack,
        elapsedMs: Date.now() - startTime,
      });
    }
  },

  /**
   * HTTP 请求处理（可选，用于健康检查或手动触发）
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          name: 'cloud-mail-worker',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          feishuConfigured: !!env.FEISHU_WEBHOOK_URL,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 手动触发测试（需要验证 token）
    if (url.pathname === '/test' && request.method === 'POST') {
      const authToken = request.headers.get('X-Auth-Token');
      if (authToken !== env.AUTH_TOKEN) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // 发送测试消息到飞书
      const webhookUrls = getFeishuWebhooks(env);
      if (webhookUrls.length === 0) {
        return new Response(JSON.stringify({ error: 'feishu not configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const testEmail = {
        from: 'test@example.com',
        to: 'you@example.com',
        subject: '🧪 测试邮件通知',
        textBody: '这是一封来自 Cloudflare Worker 的测试消息。\n\n如果你的飞书群机器人收到了这条消息，说明配置正确！',
        htmlBody: '',
        date: new Date().toISOString(),
        cc: '',
        messageId: 'test-' + Date.now(),
      };

      const results = await broadcastToFeishu(webhookUrls, sendEmailNotification, testEmail, {
        title: '🧪 测试通知',
        tag: '',
      });

      return new Response(JSON.stringify({ results, ok: results.some(r => r.ok) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 404
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

// ============================================================
// 辅助函数
// ============================================================

/**
 * 发件人过滤逻辑
 *
 * 规则优先级：
 *   1. BLOCKED_SENDERS 命中 → 拒绝
 *   2. ALLOWED_SENDERS 非空且未命中 → 拒绝
 *   3. 其他 → 允许
 */
function filterSender(from, env) {
  if (!from) return { allowed: false, reason: 'empty-sender' };

  const blocked = (env.BLOCKED_SENDERS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowed = (env.ALLOWED_SENDERS || '').split(',').map(s => s.trim()).filter(Boolean);

  // 检查是否在黑名单中
  for (const pattern of blocked) {
    if (matchSender(from, pattern)) {
      return { allowed: false, reason: `blocked by pattern: ${pattern}` };
    }
  }

  // 如果白名单非空，检查是否在白名单中
  if (allowed.length > 0) {
    for (const pattern of allowed) {
      if (matchSender(from, pattern)) {
        return { allowed: true };
      }
    }
    return { allowed: false, reason: 'not in allowed senders' };
  }

  return { allowed: true };
}

/**
 * 发件人地址匹配（支持精确匹配和通配符 *@domain.com）
 */
function matchSender(from, pattern) {
  if (pattern === '*') return true;
  if (pattern.includes('*')) {
    const regex = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      'i'
    );
    return regex.test(from);
  }
  return from.toLowerCase() === pattern.toLowerCase();
}

/**
 * 获取所有已配置的飞书 Webhook URL
 */
function getFeishuWebhooks(env) {
  const urls = [];
  // 按序号尝试 FEISHU_WEBHOOK_URL, FEISHU_WEBHOOK_URL_2, FEISHU_WEBHOOK_URL_3...
  for (let i = 1; ; i++) {
    const key = i === 1 ? 'FEISHU_WEBHOOK_URL' : `FEISHU_WEBHOOK_URL_${i}`;
    const url = env[key];
    if (!url) break;
    urls.push(url);
  }
  // 兼容旧配置 FEISHU_WEBHOOK（不带 URL 后缀）
  if (urls.length === 0 && env.FEISHU_WEBHOOK) {
    urls.push(env.FEISHU_WEBHOOK);
  }
  return urls;
}

/**
 * 创建日志记录器
 */
function createLogger(level) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = levels[level] ?? 1;

  function log(levelName, levelValue, msg, data) {
    if (levelValue < currentLevel) return;
    const entry = { level: levelName, msg, time: new Date().toISOString() };
    if (data) entry.data = data;
    // 使用 console 输出，Cloudflare 会自动收集
    if (levelValue <= 1) {
      console.log(JSON.stringify(entry));
    } else {
      console.error(JSON.stringify(entry));
    }
  }

  return {
    debug: (msg, data) => log('debug', 0, msg, data),
    info: (msg, data) => log('info', 1, msg, data),
    warn: (msg, data) => log('warn', 2, msg, data),
    error: (msg, data) => log('error', 3, msg, data),
  };
}
