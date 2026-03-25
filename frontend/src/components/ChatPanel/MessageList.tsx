import React, { useEffect, useRef } from 'react';
import type { Message } from '../../types/api';
import MessageBubble from './MessageBubble';

const FIVE_MINUTES_S = 5 * 60;

/**
 * 将 Unix 秒时间戳格式化为时间分隔条文案。
 * 今天只显示时间，昨天加"昨天"前缀，7天内显示星期，更早显示月日，跨年显示完整年月日。
 */
function formatDividerTime(tsSeconds: number): string {
  const date = new Date(tsSeconds * 1000);
  const now = new Date();

  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const timeStr = `${hh}:${mm}`;

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMsg   = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((startOfToday.getTime() - startOfMsg.getTime()) / 86400000);

  if (diffDays === 0) return timeStr;
  if (diffDays === 1) return `昨天 ${timeStr}`;
  if (diffDays < 7) {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `${weekdays[date.getDay()]} ${timeStr}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${timeStr}`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${timeStr}`;
}

/** 判断两条消息之间是否需要插入时间分隔条（间隔 >= 5 分钟，或第一条消息）。 */
function needsDivider(prevTsSeconds: number | null, curTsSeconds: number): boolean {
  if (prevTsSeconds === null) return true;
  return (curTsSeconds - prevTsSeconds) >= FIVE_MINUTES_S;
}

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
        messages.flatMap((m, i) => {
          const prevTs = i === 0 ? null : (messages[i - 1]?.ingested_at ?? null);
          const items: React.ReactNode[] = [];

          if (needsDivider(prevTs, m.ingested_at)) {
            items.push(
              <div key={`divider-${m.id}`} className="msg-divider">
                <span>{formatDividerTime(m.ingested_at)}</span>
              </div>
            );
          }

          items.push(
            <MessageBubble
              key={m.id}
              message={m}
              customerName={customerName}
              onReply={onReply}
              repliedMessage={m.reply_to_message_id ? messageByExternalId.get(m.reply_to_message_id) || null : null}
            />
          );

          return items;
        })
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
