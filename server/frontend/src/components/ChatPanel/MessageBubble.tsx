import type { Message } from '../../types/api';
import { formatReplyText, stripQuotedReplyPrefix } from '../../utils/replyPreview';

interface MessageBubbleProps {
  message: Message;
  customerName: string;
  animateDelay?: number;
  onReply: (message: Message) => void;
  repliedMessage: Message | null;
}

function renderReplyPreview(message: Message | null, customerName: string) {
  if (!message) {
    return (
      <>
        <div className="bubble-reply-meta">引用消息</div>
        <div className="bubble-reply-body">原消息暂不可用</div>
      </>
    );
  }

  const authorLabel = message.is_me ? '我' : customerName;

  if (message.type === 'image') {
    return (
      <>
        <div className="bubble-reply-meta">引用 {authorLabel} 的图片</div>
        <div className="bubble-reply-body bubble-reply-body-image">
          <div className="bubble-reply-image-wrap">
            <img className="bubble-reply-image" src={message.content} alt="引用图片" />
            <span className="bubble-reply-image-label">图片引用</span>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="bubble-reply-meta">
        引用 <span className="bubble-reply-author">{authorLabel}</span> 的消息
      </div>
      <div className="bubble-reply-body">{formatReplyText(message)}</div>
    </>
  );
}

export default function MessageBubble({
  message,
  customerName,
  animateDelay,
  onReply,
  repliedMessage,
}: MessageBubbleProps) {
  const side = message.is_me ? 'me' : 'them';
  const label = message.is_me ? '我' : customerName;
  const repliedAuthorLabel = repliedMessage
    ? (repliedMessage.is_me ? '我' : customerName)
    : null;
  const displayText = stripQuotedReplyPrefix(message, repliedMessage, repliedAuthorLabel);
  const style = animateDelay != null
    ? { animationDelay: `${animateDelay}ms` }
    : { animation: 'none' };

  return (
    <div className={`mr ${side}`} style={style}>
      <div className="ml">{label}</div>
      <div className="bub">
        {message.reply_to_message_id ? (
          <div className="bubble-reply-preview">{renderReplyPreview(repliedMessage, customerName)}</div>
        ) : null}
        {message.type === 'image' ? (
          <img
            className="chat-img"
            src={message.content}
            alt="图片"
            onClick={() => window.open(message.content, '_blank')}
          />
        ) : (
          displayText || message.content
        )}
      </div>
      <button
        type="button"
        className="bubble-reply-btn"
        onClick={() => onReply(message)}
        disabled={!message.external_message_id}
        title={message.external_message_id ? '引用这条消息' : '当前消息还没有原生 messageId，暂时不能引用'}
      >
        引用
      </button>
    </div>
  );
}
