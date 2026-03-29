import { useEffect, useState, useCallback } from 'react';
import { useAppState, useAppDispatch } from '../../context/AppContext';
import { getSessionMessages } from '../../services/sessionsApi';
import { getOutgoingMessages, retryOutgoingMessage } from '../../services/outgoingApi';
import { getOrders } from '../../services/ordersApi';
import type { ChatMessageItem, ChatSnapshot, LocalOutgoingMessage, Message, OutgoingMessage } from '../../types/api';
import ChatHeader from './ChatHeader';
import MessageList from './MessageList';
import OutgoingQueuePanel from './OutgoingQueuePanel';
import ReplyBar from './ReplyBar';
import './ChatPanel.css';

function hashComparableImageSeed(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildChatItems(messages: Message[], outgoing: OutgoingMessage[], localOutgoing: LocalOutgoingMessage[]): ChatMessageItem[] {
  const serverOutgoingById = new Map(outgoing.map((item) => [item.id, item]));
  const mergedOutgoingById = new Map<number, OutgoingMessage | LocalOutgoingMessage>();
  const recentOutgoingByFingerprint = new Map<string, OutgoingMessage | LocalOutgoingMessage>();
  const consumedOutgoingIds = new Set<number>();
  const mergedOutgoing = [
    ...outgoing,
    ...localOutgoing.map((item) => {
      const serverItem = serverOutgoingById.get(item.id);
      if (!serverItem) {
        return item;
      }

      return {
        ...serverItem,
        ...item,
        status: serverItem.status,
        sent_at: serverItem.sent_at,
        claimed_at: serverItem.claimed_at,
        error: serverItem.error,
        retries: serverItem.retries,
      };
    }),
  ].filter((item, index, list) => index === list.findIndex((candidate) => candidate.id === item.id));

  mergedOutgoing.forEach((item) => {
    mergedOutgoingById.set(item.id, item);
  });

  const recentSentImageOutgoing = mergedOutgoing
    .filter((item) => item.message_type === 'image' && item.status === 'sent')
    .sort((left, right) => (left.sent_at || left.created_at || 0) - (right.sent_at || right.created_at || 0));
  const unlinkedSelfImageMessages = messages
    .filter((message) => message.is_me === 1 && message.type === 'image' && !message.outgoing_message_id)
    .sort((left, right) => (left.ingested_at || 0) - (right.ingested_at || 0));
  const imageFallbackByMessageId = new Map<number, OutgoingMessage | LocalOutgoingMessage>();
  const normalizeComparableContent = (content: string, type: 'text' | 'image') => {
    const raw = String(content || '').trim();
    if (!raw) {
      return '';
    }

    if (type === 'image') {
      const mediaCacheMatch = raw.match(/\/media-cache\/([a-f0-9]{24})(?:\.[a-z0-9]+)?(?:[?#].*)?$/i);
      const mediaCacheHash = mediaCacheMatch?.[1];
      if (mediaCacheHash) {
        return `image:${mediaCacheHash.toLowerCase()}`;
      }

      const dataUrlMatch = raw.match(/^data:image\/[^;]+;base64,([a-z0-9+/=]+)$/i);
      if (dataUrlMatch?.[1]) {
        const extensionMatch = raw.match(/^data:image\/([^;]+);base64,/i);
        const extension = extensionMatch?.[1]?.toLowerCase() === 'jpeg'
          ? '.jpg'
          : extensionMatch?.[1]
            ? `.${extensionMatch[1].toLowerCase()}`
            : '.png';
        const syntheticSourceUrl = `data-outgoing://${hashComparableImageSeed(raw)}${extension}`;
        return `image:${hashComparableImageSeed(syntheticSourceUrl).padEnd(24, '0').slice(0, 24)}`;
      }
    }

    return type === 'text' ? raw.replace(/\s+/g, ' ') : raw;
  };

  mergedOutgoing.forEach((item) => {
    const comparableContent = item.message_type === 'image'
      ? (item.content || item.media_data || '')
      : item.content;
    const fingerprint = `${item.message_type}:${normalizeComparableContent(comparableContent, item.message_type)}`;
    if (!fingerprint) {
      return;
    }

    const existing = recentOutgoingByFingerprint.get(fingerprint);
    if (!existing || (item.sent_at || item.created_at) > (existing.sent_at || existing.created_at || 0)) {
      recentOutgoingByFingerprint.set(fingerprint, item);
    }
  });

  const availableSentImageOutgoing = [...recentSentImageOutgoing];
  unlinkedSelfImageMessages.forEach((message) => {
    const matchIndex = availableSentImageOutgoing.findIndex((item) => {
      if (consumedOutgoingIds.has(item.id)) {
        return false;
      }

      const outgoingTime = item.sent_at || item.created_at || 0;
      return Math.abs(outgoingTime - message.ingested_at) <= 30;
    });

    if (matchIndex === -1) {
      return;
    }

    const [matchedOutgoing] = availableSentImageOutgoing.splice(matchIndex, 1);
    if (matchedOutgoing) {
      imageFallbackByMessageId.set(message.id, matchedOutgoing);
    }
  });

  const existingOutgoingIds = new Set(
    messages
      .map((message) => message.outgoing_message_id)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  );

  const existingMessageFingerprints = new Set(
    messages
      .filter((message) => message.is_me === 1)
      .map((message) => `${message.type}:${normalizeComparableContent(message.content, message.type)}`)
      .filter(Boolean)
  );

  const messageItems: ChatMessageItem[] = messages.map((message) => ({
    kind: 'message',
    sortTime: message.ingested_at,
    sortSeq: message.seq,
    message: (() => {
      const linkedOutgoing = message.outgoing_message_id
        ? (mergedOutgoingById.get(message.outgoing_message_id) || null)
        : null;
      const fallbackFingerprint = `${message.type}:${normalizeComparableContent(message.content, message.type)}`;
      const fallbackOutgoing = (() => {
        if (message.is_me !== 1) {
          return null;
        }

        const fingerprintMatch = recentOutgoingByFingerprint.get(fallbackFingerprint) || null;
        if (fingerprintMatch) {
          return fingerprintMatch;
        }

        if (message.type !== 'image') {
          return null;
        }

        return imageFallbackByMessageId.get(message.id) || null;
      })();
      const effectiveOutgoing = linkedOutgoing || fallbackOutgoing;

      if (effectiveOutgoing?.id) {
        consumedOutgoingIds.add(effectiveOutgoing.id);
      }

      return {
        ...message,
        outgoing_status: effectiveOutgoing?.status || message.outgoing_status || null,
      };
    })(),
  }));

  const outgoingItems: ChatMessageItem[] = mergedOutgoing
    .filter((item) => {
      if (consumedOutgoingIds.has(item.id)) {
        return false;
      }

      if (existingOutgoingIds.has(item.id)) {
        return false;
      }

      if (item.status !== 'sent') {
        return true;
      }

      const comparableContent = item.message_type === 'image'
        ? (item.content || item.media_data || '')
        : item.content;
      const fingerprint = `${item.message_type}:${normalizeComparableContent(comparableContent, item.message_type)}`;
      return !existingMessageFingerprints.has(fingerprint);
    })
    .map((item) => ({
      kind: 'outgoing',
      sortTime: item.sent_at || item.created_at,
      outgoing: item,
    }));

  return [...messageItems, ...outgoingItems].sort((left, right) => {
    const leftSeq = left.kind === 'message' ? (left.sortSeq ?? left.message?.seq ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    const rightSeq = right.kind === 'message' ? (right.sortSeq ?? right.message?.seq ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    if (leftSeq !== rightSeq) {
      return leftSeq - rightSeq;
    }

    if (left.sortTime !== right.sortTime) {
      return left.sortTime - right.sortTime;
    }

    const leftId = left.kind === 'message' ? (left.message?.id || 0) : (left.outgoing?.id || 0);
    const rightId = right.kind === 'message' ? (right.message?.id || 0) : (right.outgoing?.id || 0);
    if (leftId !== rightId) {
      return leftId - rightId;
    }

    return left.kind === 'message' ? -1 : 1;
  });
}

export default function ChatPanel() {
  const { activeKey, chatCache, localOutgoingByChat } = useAppState();
  const dispatch = useAppDispatch();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [replyingMessage, setReplyingMessage] = useState<Message | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  // Load chat snapshot when activeKey changes
  useEffect(() => {
    if (!activeKey) return;

    setReplyingMessage(null);
    setPreviewImageUrl(null);
    setHighlightedMessageId(null);

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

  const refreshChatSnapshot = useCallback(async (chatKey: string) => {
    const [{ session, messages }, outgoing, linkedOrders] = await Promise.all([
      getSessionMessages(chatKey),
      getOutgoingMessages(chatKey),
      getOrders({ chatKey, limit: 10 }),
    ]);
    const snapshot: ChatSnapshot = { session, messages, outgoing, linkedOrders };
    dispatch({ type: 'SET_CHAT_CACHE', chatKey, snapshot });
  }, [dispatch]);

  const jumpToMessage = useCallback((externalMessageId: string) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]')).find(
      (element) => element.dataset.messageId === externalMessageId,
    );
    if (!target) {
      return;
    }

    setHighlightedMessageId(externalMessageId);
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    window.setTimeout(() => {
      setHighlightedMessageId((current) => (current === externalMessageId ? null : current));
    }, 1800);
  }, []);

  useEffect(() => {
    const handleJump = (event: Event) => {
      const customEvent = event as CustomEvent<{ chatKey?: string; externalMessageId?: string }>;
      const targetChatKey = customEvent.detail?.chatKey;
      const externalMessageId = customEvent.detail?.externalMessageId;
      if (!targetChatKey || !externalMessageId || targetChatKey !== activeKey) {
        return;
      }

      window.setTimeout(() => {
        jumpToMessage(externalMessageId);
      }, 60);
    };

    window.addEventListener('tamperfish:jump-to-message', handleJump as EventListener);
    return () => {
      window.removeEventListener('tamperfish:jump-to-message', handleJump as EventListener);
    };
  }, [activeKey, jumpToMessage]);

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
  const localOutgoing = localOutgoingByChat[activeKey] || [];
  const chatItems = buildChatItems(messages, outgoing, localOutgoing);
  const pendingList = outgoing.filter(
    (o) => o.status === 'pending' || o.status === 'sending'
  );
  const handleRetryOutgoing = async (item: OutgoingMessage) => {
    if (!activeKey) return;
    try {
      await retryOutgoingMessage(item.id);
      await refreshChatSnapshot(activeKey);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  return (
    <div id="chat">
      <ChatHeader
        session={session}
        linkedOrders={linkedOrders}
        pendingCount={pendingList.length}
        onToggleQueue={toggleQueue}
      />
      <MessageList
        key={activeKey}
        items={chatItems}
        customerName={session.customer_name}
        onReply={setReplyingMessage}
        onPreviewImage={setPreviewImageUrl}
        onJumpToMessage={jumpToMessage}
        highlightedMessageId={highlightedMessageId}
        animateMessages={false}
        onRetryOutgoing={handleRetryOutgoing}
      />
      {previewImageUrl ? (
        <div
          className="chat-image-preview-overlay"
          onClick={() => setPreviewImageUrl(null)}
          role="button"
          tabIndex={0}
          aria-label="关闭图片预览"
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setPreviewImageUrl(null);
            }
          }}
        >
          <img
            className="chat-image-preview-full"
            src={previewImageUrl}
            alt="聊天图片预览"
            onClick={(event) => {
              event.stopPropagation();
              setPreviewImageUrl(null);
            }}
          />
        </div>
      ) : null}
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
