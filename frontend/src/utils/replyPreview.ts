import type { Message } from '../types/api';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildQuotedPrefixPattern(parts: Array<string | null | undefined>): RegExp | null {
  const normalizedParts = parts
    .map((part) => part?.trim() ?? '')
    .filter(Boolean);

  if (normalizedParts.length === 0) {
    return null;
  }

  const separatorPattern = '[\\s\\n\\r:：>】）)】\\-]+';
  const pattern = normalizedParts
    .map((part) => escapeRegex(part).replace(/\s+/g, '\\s+'))
    .join(separatorPattern);

  return new RegExp(`^\\s*${pattern}[\\s\\n\\r:：>】）)】\\-]*`, 'u');
}

/**
 * 生成引用预览文案，截断过长的文本内容。
 * @param message - 被引用的消息；传 null 时返回空字符串。
 * @param maxLen - 文本最大字符数，超出则截断并追加省略号，默认 48。
 * @returns 简短的引用预览文案。
 */
export function formatReplyText(message: Message | null, maxLen = 48): string {
  if (!message) {
    return '';
  }

  if (message.type === 'image') {
    return '[图片]';
  }

  const normalized = message.content.trim();
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized;
}

/**
 * 如果当前消息正文以被引用文本开头，则在显示层移除这段重复前缀。
 * 仅对文本引用生效，不修改原始消息内容。
 * @param message - 当前显示的消息。
 * @param repliedMessage - 被引用的原消息。
 * @param repliedAuthorLabel - 被引用消息对应的显示作者名。
 * @returns 去重后的正文文本。
 */
export function stripQuotedReplyPrefix(
  message: Message,
  repliedMessage: Message | null,
  repliedAuthorLabel?: string | null,
): string {
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  if (!content || message.type !== 'text' || !message.reply_to_message_id) {
    return content;
  }

  if (!repliedMessage || repliedMessage.type !== 'text') {
    return content;
  }

  const quotedText = repliedMessage.content.trim();
  if (!quotedText) {
    return content;
  }

  if (content === quotedText) {
    return '';
  }

  const prefixPatterns = [
    buildQuotedPrefixPattern([repliedAuthorLabel, quotedText]),
    buildQuotedPrefixPattern([quotedText]),
  ].filter((pattern): pattern is RegExp => pattern instanceof RegExp);

  for (const prefixPattern of prefixPatterns) {
    const matchedPrefix = content.match(prefixPattern);
    if (matchedPrefix) {
      const remainder = content.slice(matchedPrefix[0].length).trim();
      return remainder || content;
    }
  }

  const normalizedAuthorLabel = repliedAuthorLabel?.trim();
  const combinedPrefix = normalizedAuthorLabel ? `${normalizedAuthorLabel}\n${quotedText}` : '';

  if (combinedPrefix && content.startsWith(combinedPrefix)) {
    const remainder = content
      .slice(combinedPrefix.length)
      .replace(/^[\s\n\r:：>】）)】\-]+/, '')
      .trim();
    return remainder || content;
  }

  if (!content.startsWith(quotedText)) {
    return content;
  }

  const remainder = content.slice(quotedText.length).replace(/^[\s\n\r:：>】）)】\-]+/, '').trim();
  return remainder || content;
}
