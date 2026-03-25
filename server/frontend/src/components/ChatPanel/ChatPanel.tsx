import { useEffect, useState, useCallback } from 'react';
import { useAppState, useAppDispatch } from '../../context/AppContext';
import { getSessionMessages } from '../../services/sessionsApi';
import { getOutgoingMessages } from '../../services/outgoingApi';
import { getOrders } from '../../services/ordersApi';
import type { ChatSnapshot, Message } from '../../types/api';
import ChatHeader from './ChatHeader';
import MessageList from './MessageList';
import OutgoingQueuePanel from './OutgoingQueuePanel';
import ReplyBar from './ReplyBar';
import './ChatPanel.css';

export default function ChatPanel() {
  const { activeKey, chatCache } = useAppState();
  const dispatch = useAppDispatch();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [replyingMessage, setReplyingMessage] = useState<Message | null>(null);

  // Load chat snapshot when activeKey changes
  useEffect(() => {
    if (!activeKey) return;

    setReplyingMessage(null);

    const chatKey = activeKey;
    const cached = chatCache[chatKey];

    if (!cached) {
      setLoading(true);
      setError(null);
    }

    (async () => {
      try {
        const [{ session, messages }, outgoing, linkedOrders] = await Promise.all([
          getSessionMessages(chatKey),
          getOutgoingMessages(chatKey),
          getOrders({ chatKey, limit: 10 }),
        ]);
        const snapshot: ChatSnapshot = { session, messages, outgoing, linkedOrders };
        dispatch({ type: 'SET_CHAT_CACHE', chatKey, snapshot });
        setLoading(false);
        setError(null);
      } catch (e: unknown) {
        setLoading(false);
        if (!cached) {
          setError((e as Error).message);
        }
      }
    })();
    // We only want to re-fetch when activeKey changes, not when chatCache changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, dispatch]);

  const toggleQueue = useCallback(() => {
    setQueueOpen((prev) => !prev);
  }, []);

  // No active session
  if (!activeKey) {
    return (
      <div id="chat">
        <div id="chat-empty">
          <div className="empty-icon">💬</div>
          <div className="empty-text">从左侧选择一个会话</div>
        </div>
      </div>
    );
  }

  const snapshot = chatCache[activeKey];

  // Loading state (no cache)
  if (loading && !snapshot) {
    return (
      <div id="chat">
        <div id="chat-empty">
          <div className="empty-icon" style={{ animation: 'pulse 1s infinite' }}>
            ⏳
          </div>
          <div className="empty-text">加载中...</div>
        </div>
      </div>
    );
  }

  // Error state (no cache)
  if (error && !snapshot) {
    return (
      <div id="chat">
        <div id="chat-empty">
          <div className="empty-icon">⚠️</div>
          <div className="empty-text">{error}</div>
        </div>
      </div>
    );
  }

  if (!snapshot) return null;

  const { session, messages, outgoing, linkedOrders } = snapshot;
  const pendingList = outgoing.filter(
    (o) => o.status === 'pending' || o.status === 'sending'
  );

  return (
    <div id="chat">
      <ChatHeader
        session={session}
        linkedOrders={linkedOrders}
        pendingCount={pendingList.length}
        onToggleQueue={toggleQueue}
      />
      <MessageList
        messages={messages}
        customerName={session.customer_name}
        onReply={setReplyingMessage}
      />
      <OutgoingQueuePanel
        outgoing={outgoing}
        isOpen={queueOpen}
        onClose={() => setQueueOpen(false)}
      />
      <ReplyBar
        chatKey={activeKey}
        session={session}
        replyingMessage={replyingMessage}
        onCancelReply={() => setReplyingMessage(null)}
      />
    </div>
  );
}
