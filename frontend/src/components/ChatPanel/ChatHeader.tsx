import type { Session, Order } from '../../types/api';
import type { ProductInfo } from '../../types/api';
import { tryParse } from '../../utils';
import { useAppState } from '../../context/AppContext';
import { useIsMobile } from '../../hooks/useIsMobile';
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
  const isMobile = useIsMobile();
  const p = tryParse<ProductInfo>(session.product_json, {});

  const handleBack = () => {
    // Trigger browser back to match the history entry pushed by useMobileNav
    history.back();
  };

  return (
    <div id="chat-header">
      {isMobile && (
        <button className="chat-back-btn" onClick={handleBack} aria-label="返回会话列表">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>会话</span>
        </button>
      )}
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
