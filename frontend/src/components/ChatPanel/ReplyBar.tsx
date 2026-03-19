import { useState, useRef } from 'react';
import { postOutgoingMessage } from '../../services/outgoingApi';
import { useToast } from '../../hooks/useToast';
import { useAppDispatch } from '../../context/AppContext';
import { getSessionMessages } from '../../services/sessionsApi';
import { getOutgoingMessages } from '../../services/outgoingApi';
import { getOrders } from '../../services/ordersApi';
import type { ChatSnapshot, Session } from '../../types/api';

interface ReplyBarProps {
  chatKey: string;
  session: Session;
}

export default function ReplyBar({ chatKey, session }: ReplyBarProps) {
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const dispatch = useAppDispatch();

  const handleSend = async () => {
    const trimmed = content.trim();
    if (!trimmed || sending) return;

    setSending(true);
    try {
      const r = await postOutgoingMessage({
        chatKey,
        sessionId: session.session_id || undefined,
        content: trimmed,
        source: 'manual',
      });
      if (r.ok) {
        setContent('');
        toast(`人工回复已入队 #${r.id}`, 'success');
        // Refresh chat snapshot
        try {
          const [{ session: s, messages }, outgoing, linkedOrders] = await Promise.all([
            getSessionMessages(chatKey),
            getOutgoingMessages(chatKey),
            getOrders({ chatKey, limit: 10 }),
          ]);
          const snapshot: ChatSnapshot = { session: s, messages, outgoing, linkedOrders };
          dispatch({ type: 'SET_CHAT_CACHE', chatKey, snapshot });
        } catch {
          // non-critical
        }
      } else {
        toast('入队失败', 'error');
      }
    } catch (e: unknown) {
      toast((e as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div id="outbox-bar">
      <div className="outbox-meta">
        <div className="outbox-title">人工回复</div>
        <div className="outbox-subtitle">
          消息会先进入 pending 队列，再由浏览器自动发送
        </div>
      </div>
      <input
        id="ob-input"
        ref={inputRef}
        type="text"
        placeholder="输入人工回复内容，提交后进入 pending 队列..."
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button
        id="ob-send"
        onClick={handleSend}
        disabled={sending}
      >
        {sending ? '发送中...' : '发送 ↗'}
      </button>
    </div>
  );
}
