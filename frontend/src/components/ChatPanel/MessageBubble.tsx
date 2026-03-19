import type { Message } from '../../types/api';

interface MessageBubbleProps {
  message: Message;
  customerName: string;
  animateDelay?: number;
}

export default function MessageBubble({
  message,
  customerName,
  animateDelay,
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
    </div>
  );
}
