import { useEffect, useRef } from 'react';
import type { Message } from '../../types/api';
import MessageBubble from './MessageBubble';

interface MessageListProps {
  messages: Message[];
  customerName: string;
}

export default function MessageList({ messages, customerName }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

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
