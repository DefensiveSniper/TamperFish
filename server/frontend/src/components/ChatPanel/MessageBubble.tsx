import type { Message, OutgoingMessage } from '../../types/api';
import { formatReplyText, stripQuotedReplyPrefix } from '../../utils/replyPreview';
import { isBrokenLoopbackChatImageUrl, resolveChatImageUrl } from '../../utils/mediaUrl';

interface MessageBubbleProps {
  message: Message | null;
  outgoing?: OutgoingMessage | null;
  customerName: string;
  animateDelay?: number;
  onReply: (message: Message) => void;
  onPreviewImage?: (imageUrl: string) => void;
  onJumpToMessage?: (externalMessageId: string) => void;
  isHighlighted?: boolean;
  repliedMessage: Message | null;
  onRetryOutgoing?: (item: OutgoingMessage) => void;
}

const outgoingStatusLabelMap: Record<OutgoingMessage['status'], string> = {
  pending: '发送中',
  sending: '发送中',
  sent: '已发送',
  failed: '重新发送',
};

function renderReplyPreview(
  message: Message | null,
  customerName: string,
  onJumpToMessage?: (externalMessageId: string) => void,
) {
  if (!message) {
    return (
      <>
        <div className="bubble-reply-meta">引用消息</div>
        <div className="bubble-reply-body">原消息暂不可用</div>
      </>
    );
  }

  const authorLabel = message.is_me ? '我' : customerName;
  const canJump = Boolean(message.external_message_id && onJumpToMessage);
  const handleJump = () => {
    if (message.external_message_id && onJumpToMessage) {
      onJumpToMessage(message.external_message_id);
    }
  };

  if (message.type === 'image') {
    const resolvedReplyImage = resolveChatImageUrl(message.content);
    return (
      <button
        type="button"
        className={`bubble-reply-preview${canJump ? ' clickable' : ''}`}
        onClick={handleJump}
        disabled={!canJump}
      >
        <div className="bubble-reply-meta">引用 {authorLabel} 的图片</div>
        <div className="bubble-reply-body bubble-reply-body-image unified">
          <div className="bubble-reply-image-wrap">
            <img className="bubble-reply-image" src={resolvedReplyImage} alt="引用图片" />
            <span className="bubble-reply-image-label">图片引用</span>
          </div>
        </div>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`bubble-reply-preview${canJump ? ' clickable' : ''}`}
      onClick={handleJump}
      disabled={!canJump}
    >
      <div className="bubble-reply-meta">
        引用 <span className="bubble-reply-author">{authorLabel}</span> 的消息
      </div>
      <div className="bubble-reply-body unified">{formatReplyText(message)}</div>
    </button>
  );
}

export default function MessageBubble({
  message,
  outgoing = null,
  customerName,
  animateDelay,
  onReply,
  onPreviewImage,
  onJumpToMessage,
  isHighlighted = false,
  repliedMessage,
  onRetryOutgoing,
}: MessageBubbleProps) {
  const isOutgoingOnly = Boolean(outgoing && !message);
  const side = isOutgoingOnly || message?.is_me ? 'me' : 'them';
  const repliedAuthorLabel = repliedMessage
    ? (repliedMessage.is_me ? '我' : customerName)
    : null;
  const displayText = message
    ? stripQuotedReplyPrefix(message, repliedMessage, repliedAuthorLabel)
    : '';
  const style = animateDelay != null
    ? { animationDelay: `${animateDelay}ms` }
    : { animation: 'none' };
  const bubbleText = message
    ? (displayText || message.content)
    : (outgoing?.message_type === 'image' ? null : outgoing?.content || '');
  const bubbleImage = message?.type === 'image'
    ? message.content
    : outgoing?.message_type === 'image'
      ? (outgoing.media_data || outgoing.content)
      : null;
  const resolvedBubbleImage = bubbleImage ? resolveChatImageUrl(bubbleImage) : null;
  const showBrokenImagePlaceholder = Boolean(
    bubbleImage
    && isBrokenLoopbackChatImageUrl(bubbleImage)
    && resolvedBubbleImage === bubbleImage,
  );
  const effectiveStatus = outgoing?.status || message?.outgoing_status || null;
  const statusLabel = effectiveStatus ? outgoingStatusLabelMap[effectiveStatus] : null;
  const canRetry = outgoing?.status === 'failed' && Boolean(onRetryOutgoing);
  const canReply = Boolean(message?.external_message_id);
  const resolvedLabel = side === 'me' ? '我' : customerName;
  const shouldHideAuthorLabel = Boolean(message?.is_me && message?.reply_to_message_id);

  return (
    <div
      className={`mr ${side}${isHighlighted ? ' highlighted' : ''}`}
      style={style}
      data-message-id={message?.external_message_id || ''}
    >
      {!shouldHideAuthorLabel ? <div className="ml">{resolvedLabel}</div> : null}
      <div className="bub">
        {message?.reply_to_message_id ? (
          renderReplyPreview(repliedMessage, customerName, onJumpToMessage)
        ) : null}
        {resolvedBubbleImage && !showBrokenImagePlaceholder ? (
          <img
            className="chat-img"
            src={resolvedBubbleImage}
            alt="图片"
            onClick={() => onPreviewImage?.(resolvedBubbleImage)}
          />
        ) : showBrokenImagePlaceholder ? (
          <div className="chat-img-broken-placeholder">
            <div className="chat-img-broken-icon">图片</div>
            <div className="chat-img-broken-text">该图片尚未同步到服务器</div>
          </div>
        ) : (
          bubbleText
        )}
        {statusLabel ? (
          <div className="bubble-status-row">
            {canRetry ? (
              <button
                type="button"
                className="bubble-status-action failed"
                onClick={() => onRetryOutgoing?.(outgoing as OutgoingMessage)}
              >
                {statusLabel}
              </button>
            ) : (
              <span className={`bubble-status-text ${effectiveStatus || ''}`}>{statusLabel}</span>
            )}
          </div>
        ) : null}
      </div>
      {canReply ? (
        <button
          type="button"
          className="bubble-reply-btn"
          onClick={() => onReply(message as Message)}
          title="引用这条消息"
        >
          ↩
        </button>
      ) : null}
    </div>
  );
}
