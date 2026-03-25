import React from 'react';
import type { Session } from '../../types/api';
import { tryParse, timeAgo } from '../../utils';
import type { ProductInfo } from '../../types/api';

interface SidebarItemProps {
  session: Session;
  isActive: boolean;
  pendingCount: number;
  onClick: (chatKey: string) => void;
  index: number;
}

const SidebarItem = React.memo(function SidebarItem({
  session,
  isActive,
  pendingCount,
  onClick,
  index,
}: SidebarItemProps) {
  const p = tryParse<ProductInfo>(session.product_json, {});
  const preview = session.last_message
    ? (session.last_is_me ? '我: ' : '') + session.last_message
    : '暂无消息';
  const timeStr = timeAgo(session.last_time || session.updated_at);

  return (
    <div
      className={`si${isActive ? ' active' : ''}`}
      style={{ animationDelay: `${index * 30}ms` }}
      onClick={() => onClick(session.chat_key)}
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
      <div className="preview">{preview}</div>
      <div className="meta">
        <span className="price">{p.price || ''}</span>
        <span>{p.location || ''}</span>
        <span className="badge">{session.message_count}</span>
      </div>
    </div>
  );
});

export default SidebarItem;
