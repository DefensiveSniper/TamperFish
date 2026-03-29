import type { Message } from '../types/api';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeComparableText(value: string | null | undefined): string {
  return String(value || '')
    .replace(/[\s\n\r]+/g, '')
    .trim()
    .toLowerCase();
}

function isEquivalentAuthorAlias(
  candidate: string | null | undefined,
  repliedAuthorLabel?: string | null,
): boolean {
  const normalizedCandidate = normalizeComparableText(candidate);
  const normalizedAuthor = normalizeComparableText(repliedAuthorLabel);

  if (!normalizedCandidate || !normalizedAuthor) {
    return false;
  }

  if (normalizedCandidate === normalizedAuthor) {
    return true;
  }

  return (normalizedAuthor === '我' && normalizedCandidate.length > 0)
    || (normalizedCandidate === '我' && normalizedAuthor.length > 0);
}

function stripLeadingEquivalentAuthorLine(
  content: string,
  repliedAuthorLabel?: string | null,
): string {
  const normalizedContent = content.trim();
  const lines = normalizedContent.split(/\r?\n/);
  if (lines.length < 2) {
    return normalizedContent;
  }

  const [firstLine, ...restLines] = lines;
  if (!isEquivalentAuthorAlias(firstLine, repliedAuthorLabel)) {
    return normalizedContent;
  }

  return restLines.join('\n').trim() || normalizedContent;
}

function stripLeadingQuotedTextBlock(content: string, quotedText: string): string {
  const normalizedContent = content.trim();
  if (!normalizedContent || !quotedText) {
    return normalizedContent;
  }

  const quotedPrefixPattern = buildQuotedPrefixPattern([quotedText]);
  if (!quotedPrefixPattern) {
    return normalizedContent;
  }

  const matchedPrefix = normalizedContent.match(quotedPrefixPattern);
  if (!matchedPrefix) {
    return normalizedContent;
  }

  return normalizedContent.slice(matchedPrefix[0].length).trim() || normalizedContent;
}

function stripAuthorThenQuotedTextBlock(
  content: string,
  quotedText: string,
  repliedAuthorLabel?: string | null,
): string {
  const normalizedContent = content.trim();
  if (!normalizedContent || !quotedText || !repliedAuthorLabel) {
    return normalizedContent;
  }

  const lines = normalizedContent.split(/\r?\n/);
  if (lines.length < 3) {
    return normalizedContent;
  }

  const [firstLine, ...restLines] = lines;
  if (!isEquivalentAuthorAlias(firstLine, repliedAuthorLabel)) {
    return normalizedContent;
  }

  const restContent = restLines.join('\n').trim();
  const strippedRest = stripLeadingQuotedTextBlock(restContent, quotedText);
  if (strippedRest === restContent) {
    return normalizedContent;
  }

  return strippedRest || normalizedContent;
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

  if (repliedMessage?.type === 'image') {
    const withoutAliasLine = stripLeadingEquivalentAuthorLine(content, repliedAuthorLabel);
    return withoutAliasLine || content;
  }

  if (!repliedMessage || repliedMessage.type !== 'text') {
    return content;
  }

  const quotedText = repliedMessage.content.trim();
  if (!quotedText) {
    return content;
  }

  function stripLeadingReplyHeader(content: string, quotedText: string, repliedAuthorLabel?: string | null): string {
    const normalizedAuthor = repliedAuthorLabel?.trim() ?? '';
    const escapedQuotedText = escapeRegex(quotedText).replace(/\s+/g, '\\s+');
    const escapedAuthor = normalizedAuthor
      ? escapeRegex(normalizedAuthor).replace(/\s+/g, '\\s+')
      : '[^\\n\\r]+';
    const replyHeaderPattern = new RegExp(
      `^\\s*引用\\s+${escapedAuthor}\\s+的消息[\\s\\n\\r]+${escapedQuotedText}(?:[\\s\\n\\r]+|$)`,
      'u'
    );

    const matchedHeader = content.match(replyHeaderPattern);
    if (!matchedHeader) {
      return content;
    }

    let remainder = content.slice(matchedHeader[0].length).trim();
    const aliasAndQuoteMatch = remainder.match(/^([^\n\r]+)[\s\n\r]+([\s\S]+)$/u);
    if (aliasAndQuoteMatch) {
      const [, aliasLine, restContent] = aliasAndQuoteMatch;
      const normalizedRest = (restContent || '').trim();
      if (isEquivalentAuthorAlias(aliasLine, repliedAuthorLabel) && normalizedRest.startsWith(quotedText)) {
        remainder = normalizedRest.slice(quotedText.length).trim();
      }
    }

    return remainder || content;
  }

  const strippedReplyHeader = stripLeadingReplyHeader(content, quotedText, repliedAuthorLabel);
  if (strippedReplyHeader !== content) {
    let cleaned = strippedReplyHeader;
    const withoutAliasLine = stripLeadingEquivalentAuthorLine(cleaned, repliedAuthorLabel);
    if (withoutAliasLine !== cleaned) {
      cleaned = withoutAliasLine;
    }

    const withoutQuotedText = stripLeadingQuotedTextBlock(cleaned, quotedText);
    if (withoutQuotedText !== cleaned) {
      cleaned = withoutQuotedText;
    }

    return cleaned || content;
  }

  const strippedAuthorThenQuote = stripAuthorThenQuotedTextBlock(content, quotedText, repliedAuthorLabel);
  if (strippedAuthorThenQuote !== content) {
    return strippedAuthorThenQuote || content;
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
