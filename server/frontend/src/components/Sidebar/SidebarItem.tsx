import React from 'react';
import type { Session } from '../../types/api';
import { tryParse, timeAgo } from '../../utils';
import type { ProductInfo } from '../../types/api';

interface SidebarItemProps {
  session: Session;
  isActive: boolean;
  pendingCount: number;
  onClick: (chatKey: string, externalMessageId?: string | null) => void;
  searchQuery: string;
  index: number;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHighlightedText(text: string, query: string) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return text;
  }

  const matcher = new RegExp(`(${escapeRegExp(normalizedQuery)})`, 'ig');
  const parts = text.split(matcher);
  return parts.map((part, index) => {
    const isMatch = part.toLowerCase() === normalizedQuery.toLowerCase();
    return isMatch
      ? <mark key={`${part}-${index}`} className="search-hit">{part}</mark>
      : <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>;
  });
}

const SidebarItem = React.memo(function SidebarItem({
  session,
  isActive,
  pendingCount,
  onClick,
  searchQuery,
  index,
}: SidebarItemProps) {
  const p = tryParse<ProductInfo>(session.product_json, {});
  const preview = session.search_match_preview || (session.last_message
    ? (session.last_is_me ? '我: ' : '') + session.last_message
    : '暂无消息');
  const timeStr = timeAgo(session.last_time || session.updated_at);
  const hasSearchMatch = Boolean(searchQuery.trim() && session.search_match_preview);

  return (
    <div
      className={`si${isActive ? ' active' : ''}`}
      style={{ animationDelay: `${index * 30}ms` }}
      onClick={() => onClick(session.chat_key, session.search_match_external_message_id)}
    >
      <div className="name">
        <span>{session.customer_name}</span>
        {session.product_id && (
          <span className="pid">#{session.product_id.slice(-4)}</span>
        )}
        {pendingCount > 0 && (
          <span className="pending-dot" title="有待发消息" />
        )}
        <span
          style={{
            marginLeft: 'auto',
            fontSize: '10px',
            color: 'var(--muted)',
            fontWeight: 'normal',
            letterSpacing: 0,
          }}
        >
          {timeStr}
        </span>
      </div>
      <div className={`preview${hasSearchMatch ? ' search-preview' : ''}`}>
        {renderHighlightedText(preview, searchQuery)}
      </div>
      <div className="meta">
        <span className="price">{p.price || ''}</span>
        <span>{p.location || ''}</span>
        {session.unread_count > 0 && (
          <span className="badge">{session.unread_count}</span>
        )}
      </div>
    </div>
  );
});

export default SidebarItem;
