import type { Message } from '../../types/api';

interface MessageBubbleProps {
  message: Message;
  customerName: string;
  animateDelay?: number;
  onReply: (message: Message) => void;
  repliedMessage: Message | null;
}

function buildReplyPreview(message: Message | null): string {
  if (!message) {
    return '引用消息';
  }

  if (message.type === 'image') {
    return '[图片]';
  }

  const normalized = message.content.trim();
  return normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized;
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
  const style = animateDelay != null
    ? { animationDelay: `${animateDelay}ms` }
    : { animation: 'none' };

  return (
    <div className={`mr ${side}`} style={style}>
      <div className="ml">{label}</div>
      <div className="bub">
        {message.reply_to_message_id ? (
          <div className="bubble-reply-preview">{buildReplyPreview(repliedMessage)}</div>
        ) : null}
        {message.type === 'image' ? (
          <img
            className="chat-img"
            src={message.content}
            alt="图片"
            onClick={() => window.open(message.content, '_blank')}
          />
        ) : (
          message.content
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
