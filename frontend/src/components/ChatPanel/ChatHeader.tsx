import type { Session, Order } from '../../types/api';
import type { ProductInfo } from '../../types/api';
import { tryParse } from '../../utils';
import { useAppState } from '../../context/AppContext';
import ChatOrderSummary from './ChatOrderSummary';

interface ChatHeaderProps {
  session: Session;
  linkedOrders: Order[];
  pendingCount: number;
  onToggleQueue: () => void;
}

export default function ChatHeader({
  session,
  linkedOrders,
  pendingCount,
  onToggleQueue,
}: ChatHeaderProps) {
  const { appSettings } = useAppState();
  const p = tryParse<ProductInfo>(session.product_json, {});

  return (
    <div id="chat-header">
      <div className="info">
        <div className="cn">{session.customer_name}</div>
        <div className="cm">
          {p.price && <span className="product-tag">💰 {p.price}</span>}
          {p.location && <span className="product-tag">📍 {p.location}</span>}
          {p.url && (
            <a
              className="pl"
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
              title={p.url}
            >
              🔗 商品链接
            </a>
          )}
          {appSettings.autoReplyEnabled ? (
            <span className="chat-mode-badge ai-on">AI 自动回复中</span>
          ) : (
            <span className="chat-mode-badge ai-off">人工接管中</span>
          )}
          {pendingCount > 0 && (
            <span className="pending-count-badge" onClick={onToggleQueue}>
              ⏳ {pendingCount} 条待发
            </span>
          )}
        </div>
        <ChatOrderSummary linkedOrders={linkedOrders} />
      </div>
    </div>
  );
}
