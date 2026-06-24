/**
 * feishu.js — 飞书群机器人消息发送模块
 *
 * 支持三种消息类型：
 *   1. text        — 纯文本消息
 *   2. post        — 富文本消息（推荐，格式更丰富）
 *   3. interactive — 消息卡片（视觉效果最好）
 *
 * 飞书机器人 Webhook 格式：
 *   POST https://open.feishu.cn/open-apis/bot/v2/hook/<webhook_id>
 *   Content-Type: application/json
 *
 * 参考文档：https://open.feishu.cn/document/client-docs/bot-v2/add-manually
 */

/**
 * 发送文本消息到飞书群
 * @param {string} webhookUrl - 飞书机器人 Webhook URL
 * @param {string} content - 消息内容
 * @returns {Promise<{ok: boolean, data: any}>}
 */
export async function sendTextMessage(webhookUrl, content) {
  const payload = {
    msg_type: 'text',
    content: {
      text: content,
    },
  };
  return postToFeishu(webhookUrl, payload);
}

/**
 * 发送富文本消息到飞书群
 * Rich text supports: text, a, at, img, media_person, emoji
 *
 * @param {string} webhookUrl - 飞书机器人 Webhook URL
 * @param {string} title - 消息标题
 * @param {Array<Array<object>>} content - 富文本内容行
 * @returns {Promise<{ok: boolean, data: any}>}
 */
export async function sendPostMessage(webhookUrl, title, content) {
  const payload = {
    msg_type: 'post',
    content: {
      post: {
        zh_cn: {
          title,
          content,
        },
      },
    },
  };
  return postToFeishu(webhookUrl, payload);
}

/**
 * 发送消息卡片（Interactive Card）
 * 最丰富的格式，支持头图、分割线、按钮等
 *
 * @param {string} webhookUrl - 飞书机器人 Webhook URL
 * @param {object} card - 卡片结构体
 * @returns {Promise<{ok: boolean, data: any}>}
 */
export async function sendCardMessage(webhookUrl, card) {
  const payload = {
    msg_type: 'interactive',
    card,
  };
  return postToFeishu(webhookUrl, payload);
}

/**
 * 发送一封邮件的格式化通知到飞书群
 * 使用富文本（post）格式，展示发件人、主题、正文预览
 *
 * @param {string} webhookUrl - 飞书 Webhook URL
 * @param {object} email - 解析后的邮件对象
 * @param {object} options - 可选配置
 * @returns {Promise<{ok: boolean, data: any}>}
 */
export async function sendEmailNotification(webhookUrl, email, options = {}) {
  const title = options.title || '📬 新邮件通知';
  const tag = options.tag || '';
  const maxBodyPreview = options.maxBodyPreview || 800;

  // 正文预览（截取前 N 字符）
  const bodyPreview = email.textBody
    ? email.textBody.replace(/\r\n/g, '\n').substring(0, maxBodyPreview)
    : '(无文本内容)';
  const bodyLines = bodyPreview.split('\n');
  const previewLines = bodyLines.slice(0, 15); // 最多显示 15 行
  const truncated = bodyLines.length > 15 || bodyPreview.length > maxBodyPreview;

  // 构建富文本内容
  const contentLines = [];

  // 第一行：标签 + 主题
  const subjectLine = [];
  if (tag) {
    subjectLine.push({ tag: 'text', text: `${tag} ` });
  }
  subjectLine.push({ tag: 'text', text: `📧 ${email.subject}`, style: ['bold'] });
  contentLines.push(subjectLine);

  // 分隔行
  contentLines.push([{ tag: 'text', text: '──────────────────' }]);

  // 发件人
  contentLines.push([
    { tag: 'text', text: '发件人：', style: ['bold'] },
    { tag: 'text', text: email.from },
  ]);

  // 收件人
  if (email.to) {
    contentLines.push([
      { tag: 'text', text: '收件人：', style: ['bold'] },
      { tag: 'text', text: email.to },
    ]);
  }

  // 时间
  if (email.date) {
    contentLines.push([
      { tag: 'text', text: '时间：', style: ['bold'] },
      { tag: 'text', text: email.date },
    ]);
  }

  // 分隔线
  contentLines.push([{ tag: 'text', text: '──────────────────' }]);

  // 正文预览
  for (const line of previewLines) {
    if (line.trim()) {
      contentLines.push([{ tag: 'text', text: line }]);
    }
  }

  if (truncated) {
    contentLines.push([
      { tag: 'text', text: '\n... (内容已截断)', style: ['italic'] },
    ]);
  }

  // 没有正文时的提示
  if (!email.textBody && email.htmlBody) {
    contentLines.push([
      { tag: 'text', text: '（此邮件为 HTML 格式，请在邮箱中查看完整内容）', style: ['italic'] },
    ]);
  }

  return sendPostMessage(webhookUrl, title, contentLines);
}

/**
 * 发送一封邮件的卡片通知（更美观的方式）
 * 使用 Interactive Card 格式
 */
export async function sendEmailCardNotification(webhookUrl, email, options = {}) {
  const title = options.title || '📬 新邮件通知';
  const tag = options.tag || '';
  const maxBodyPreview = options.maxBodyPreview || 500;

  const bodyPreview = email.textBody
    ? email.textBody.replace(/\r\n/g, '\n').substring(0, maxBodyPreview)
    : '(无文本内容)';

  const card = {
    header: {
      title: {
        tag: 'plain_text',
        content: tag ? `[${tag}] ${title}` : title,
      },
      template: 'indigo',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**📧 主题：** ${email.subject}`,
        },
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**发件人：** ${email.from}`,
        },
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**收件人：** ${email.to || '未知'}`,
        },
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**时间：** ${email.date || '未知'}`,
        },
      },
      {
        tag: 'hr',
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**正文预览：**\n${bodyPreview}${bodyPreview.length >= maxBodyPreview ? '\n...' : ''}`,
        },
      },
    ],
  };

  return sendCardMessage(webhookUrl, card);
}

/**
 * 发送消息到多个飞书群
 * @param {string[]} webhookUrls - Webhook URL 列表
 * @param {function} sendFn - 发送函数，如 sendEmailNotification
 * @param {...any} args - 传给 sendFn 的参数
 */
export async function broadcastToFeishu(webhookUrls, sendFn, ...args) {
  const results = [];
  for (const url of webhookUrls) {
    if (!url || url.trim() === '') continue;
    try {
      const result = await sendFn(url, ...args);
      results.push({ url: maskWebhookUrl(url), ok: result.ok });
    } catch (err) {
      results.push({ url: maskWebhookUrl(url), ok: false, error: err.message });
    }
  }
  return results;
}

// ============================================================
// 内部工具
// ============================================================

/**
 * 发送 HTTP POST 请求到飞书 Webhook
 */
async function postToFeishu(webhookUrl, payload) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  return {
    ok: response.ok && data.code === 0,
    status: response.status,
    data,
  };
}

/**
 * 脱敏 Webhook URL（只显示前几位，隐藏 key）
 */
function maskWebhookUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    const last = parts[parts.length - 1];
    if (last && last.length > 8) {
      parts[parts.length - 1] = last.substring(0, 4) + '****' + last.substring(last.length - 4);
    }
    u.pathname = parts.join('/');
    return u.toString();
  } catch {
    return url.substring(0, 30) + '****';
  }
}
