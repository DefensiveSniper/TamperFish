import { useEffect, useRef } from 'react';
import type { Message } from '../../types/api';
import MessageBubble from './MessageBubble';

interface MessageListProps {
  messages: Message[];
  customerName: string;
  onReply: (message: Message) => void;
}

export default function MessageList({ messages, customerName, onReply }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);
  const messageByExternalId = new Map(
    messages
      .filter((message) => Boolean(message.external_message_id))
      .map((message) => [message.external_message_id as string, message])
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Auto-scroll to bottom on new messages
    const isNewMessage = messages.length > prevCountRef.current;
    prevCountRef.current = messages.length;

    if (isNewMessage) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // On first mount, scroll to bottom
  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  return (
    <div id="messages" ref={containerRef}>
      {messages.length > 0 ? (
        messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            customerName={customerName}
            onReply={onReply}
            repliedMessage={m.reply_to_message_id ? messageByExternalId.get(m.reply_to_message_id) || null : null}
          />
        ))
      ) : (
        <div
          style={{
            textAlign: 'center',
            color: 'var(--muted)',
            marginTop: '40px',
            fontSize: '13px',
          }}
        >
          暂无消息
        </div>
      )}
    </div>
  );
}
