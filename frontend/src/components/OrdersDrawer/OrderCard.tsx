import type { Order } from '../../types/api';
import { formatDateTime } from '../../utils';
import { useAppDispatch } from '../../context/AppContext';
import OrderMetaRow from './OrderMetaRow';

interface OrderCardProps {
  order: Order;
  onCloseDrawer: () => void;
}

export default function OrderCard({ order, onCloseDrawer }: OrderCardProps) {
  const dispatch = useAppDispatch();
  const linked = !!order.chat_key;

  const paidAtText = order.paid_at ? formatDateTime(order.paid_at) : '未识别';
  const latestShipAtText = order.latest_ship_at
    ? formatDateTime(order.latest_ship_at)
    : '未识别';
  const lastSeenText = order.last_seen_at
    ? formatDateTime(order.last_seen_at)
    : '未记录';

  const buyerText = [
    order.buyer_name || '未识别',
    order.buyer_user_id ? `UID ${order.buyer_user_id}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const priceQuantityText = [
    order.product_price || '',
    order.purchase_quantity ? `x${order.purchase_quantity}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const handleJumpToSession = () => {
    if (order.chat_key) {
      onCloseDrawer();
      dispatch({ type: 'SET_ACTIVE_KEY', key: order.chat_key });
    }
  };

  return (
    <div className="order-card">
      <div className="order-card-header">
        <div className="order-card-order-id">订单号 {order.order_id}</div>
        <span
          className={`order-card-link-state ${linked ? 'linked' : 'unlinked'}`}
        >
          {linked ? '已关联会话' : '未关联会话'}
        </span>
      </div>
      <div className="order-card-title">
        {order.product_title || '未识别商品标题'}
      </div>
      <div className="order-card-meta">
        <OrderMetaRow label="买家" value={buyerText} />
        <OrderMetaRow
          label="收件人"
          value={order.receiver_name || ''}
          copyable
          copyLabel="收件人"
        />
        <OrderMetaRow
          label="手机号"
          value={order.receiver_phone || ''}
          copyable
          copyLabel="手机号"
        />
        <OrderMetaRow
          label="地址"
          value={order.receiver_address || ''}
          copyable
          copyLabel="地址"
        />
        <OrderMetaRow label="商品ID" value={order.product_id || ''} />
        <OrderMetaRow label="金额 / 数量" value={priceQuantityText} />
      </div>
      <div className="order-card-times">
        <div>
          <strong>订单状态</strong> {order.order_status_text || '状态未知'}
        </div>
        <div>
          <strong>支付时间</strong> {paidAtText}
        </div>
        <div>
          <strong>最晚发货</strong> {latestShipAtText}
        </div>
        <div>
          <strong>最近看到</strong> {lastSeenText}
        </div>
      </div>
      <div className="order-card-actions">
        {linked && (
          <button className="btn" onClick={handleJumpToSession}>
            跳转会话
          </button>
        )}
      </div>
    </div>
  );
}
