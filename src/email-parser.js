/**
 * email-parser.js — 邮件解析模块
 *
 * Cloudflare Email Worker 收到原始邮件后，解析发件人、收件人、主题、正文。
 * 支持纯文本和 HTML 正文提取。
 */

/**
 * 解析邮件原始数据
 * @param {ReadableStream} rawStream - Cloudflare EmailMessage 的 raw 属性
 * @returns {Promise<{from: string, to: string, subject: string, textBody: string, htmlBody: string, headers: object}>}
 */
export async function parseEmail(rawStream) {
  const raw = await streamToString(rawStream);
  return parseRawEmail(raw);
}

/**
 * 从 ReadableStream 读取全部字节并转为 UTF-8 字符串
 */
async function streamToString(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let done = false;

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    done = streamDone;
    if (value) {
      result += decoder.decode(value, { stream: true });
    }
  }
  // 处理剩余字节
  result += decoder.decode();
  return result;
}

/**
 * 解析原始 RFC 2822 邮件字符串
 * 返回结构化字段
 */
function parseRawEmail(raw) {
  // 拆分 header 和 body（RFC 2822 用空行分隔）
  const headerEnd = raw.indexOf('\n\n');
  if (headerEnd === -1) {
    return { from: '', to: '', subject: '', textBody: raw, htmlBody: '', headers: {} };
  }

  const headerSection = raw.substring(0, headerEnd);
  const bodySection = raw.substring(headerEnd + 2);

  // 解析 header（支持折叠 header，即换行后以空格开头的 continuation line）
  const headers = parseHeaders(headerSection);

  // 提取 MIME 结构
  const contentType = headers['content-type'] || '';
  const isMultipart = contentType.startsWith('multipart/');
  const boundary = getBoundary(contentType);

  let textBody = '';
  let htmlBody = '';

  if (isMultipart && boundary) {
    const parts = parseMultipart(bodySection, boundary);
    for (const part of parts) {
      const partHeaders = part.headers;
      const partType = partHeaders['content-type'] || '';
      const encoding = partHeaders['content-transfer-encoding'] || '';

      let decodedBody = part.body;
      if (encoding.toLowerCase().includes('base64')) {
        decodedBody = decodeBase64(part.body);
      } else if (encoding.toLowerCase().includes('quoted-printable')) {
        decodedBody = decodeQuotedPrintable(part.body);
      }

      if (partType.startsWith('text/plain')) {
        textBody = decodedBody;
      } else if (partType.startsWith('text/html')) {
        htmlBody = decodedBody;
      }
    }
  } else {
    // 非 multipart，直接按 text/plain 处理
    const encoding = headers['content-transfer-encoding'] || '';
    let decoded = bodySection;
    if (encoding.toLowerCase().includes('base64')) {
      decoded = decodeBase64(bodySection);
    } else if (encoding.toLowerCase().includes('quoted-printable')) {
      decoded = decodeQuotedPrintable(bodySection);
    }
    textBody = decoded.trim();
  }

  return {
    from: decodeMimeHeader(headers['from'] || ''),
    to: decodeMimeHeader(headers['to'] || ''),
    cc: decodeMimeHeader(headers['cc'] || ''),
    subject: decodeMimeHeader(headers['subject'] || '(无主题)'),
    date: headers['date'] || '',
    messageId: (headers['message-id'] || '').replace(/[<>]/g, ''),
    textBody,
    htmlBody,
    headers,
  };
}

/**
 * 解析 RFC 2822 header 区域，支持折叠 header
 */
function parseHeaders(headerSection) {
  const headers = {};
  // 先合拢折叠 header（以空格/tab 开头的行接续到上一行）
  const unfolded = headerSection
    .split('\n')
    .reduce((acc, line) => {
      if (line.startsWith(' ') || line.startsWith('\t')) {
        if (acc.length > 0) {
          acc[acc.length - 1] += line;
        } else {
          acc.push(line);
        }
      } else {
        acc.push(line);
      }
      return acc;
    }, []);

  for (const line of unfolded) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();
    // 同名 header 累加
    if (headers[key]) {
      headers[key] += ', ' + value;
    } else {
      headers[key] = value;
    }
  }

  return headers;
}

/**
 * 从 Content-Type 中提取 boundary
 */
function getBoundary(contentType) {
  const match = contentType.match(/boundary\s*=\s*["']?([^"'\s;]+)["']?/i);
  return match ? match[1] : null;
}

/**
 * 解析 multipart 邮件体（支持递归处理嵌套 multipart）
 */
function parseMultipart(body, boundary) {
  const parts = [];
  const delimiter = `--${boundary}`;
  const endDelimiter = `--${boundary}--`;

  // 按 boundary 分割
  const sections = body.split(/\r?\n/);
  let currentPart = null;
  let inHeader = true;
  let headerLines = [];
  let bodyLines = [];

  for (const line of sections) {
    const trimmed = line.trim();
    if (trimmed === delimiter || trimmed.startsWith(delimiter)) {
      // 保存上一个 part
      if (currentPart !== null) {
        const partRaw = {
          header: headerLines.join('\n'),
          body: bodyLines.join('\n'),
        };
        currentPart = {
          headers: parseHeaders(partRaw.header),
          body: partRaw.body.trim(),
        };
        // 检查是否有嵌套 multipart
        const partContentType = currentPart.headers['content-type'] || '';
        if (partContentType.startsWith('multipart/')) {
          const nestedBoundary = getBoundary(partContentType);
          if (nestedBoundary) {
            const nestedParts = parseMultipart(currentPart.body, nestedBoundary);
            parts.push(...nestedParts);
          } else {
            parts.push(currentPart);
          }
        } else {
          parts.push(currentPart);
        }
      }
      // 开始新 part
      currentPart = {};
      inHeader = true;
      headerLines = [];
      bodyLines = [];
      continue;
    }
    if (trimmed === endDelimiter) {
      break;
    }
    if (currentPart !== null) {
      if (inHeader) {
        if (line === '' || line === '\r') {
          inHeader = false;
        } else {
          headerLines.push(line);
        }
      } else {
        bodyLines.push(line);
      }
    }
  }

  // 处理最后一个 part
  if (currentPart !== null && headerLines.length > 0) {
    const partRaw = {
      header: headerLines.join('\n'),
      body: bodyLines.join('\n'),
    };
    currentPart = {
      headers: parseHeaders(partRaw.header),
      body: partRaw.body.trim(),
    };
    parts.push(currentPart);
  }

  return parts;
}

/**
 * Base64 解码
 */
function decodeBase64(str) {
  try {
    // 移除空白字符
    const clean = str.replace(/[\s\r\n]/g, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return str;
  }
}

/**
 * Quoted-Printable 解码
 */
function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, '')           // 软换行
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

/**
 * 解码 MIME encoded-word: =?charset?B?base64?= / =?charset?Q?qp?=
 */
function decodeMimeHeader(header) {
  if (!header) return '';
  return header.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, charset, encoding, encoded) => {
      try {
        let decoded;
        if (encoding.toUpperCase() === 'B') {
          decoded = atob(encoded);
        } else {
          // Q-encoding
          decoded = encoded
            .replace(/_/g, ' ')
            .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
              String.fromCharCode(parseInt(h, 16))
            );
        }
        // 尝试用 UTF-8 解码，否则返回原始字符串
        const encoder = new TextEncoder();
        const bytes = encoder.encode(decoded);
        const decoder_ = new TextDecoder(charset.toLowerCase() === 'utf-8' ? 'utf-8' : 'utf-8');
        return decoder_.decode(bytes);
      } catch {
        return encoded;
      }
    }
  );
}
