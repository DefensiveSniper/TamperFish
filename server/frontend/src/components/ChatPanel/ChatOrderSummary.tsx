import type { Order } from '../../types/api';
import { formatDateTime } from '../../utils';

interface ChatOrderSummaryProps {
  linkedOrders: Order[];
}

export default function ChatOrderSummary({ linkedOrders }: ChatOrderSummaryProps) {
  if (!linkedOrders || linkedOrders.length === 0) return null;

  return (
    <div className="chat-order-stack">
      {linkedOrders.map((order) => {
        const priceQuantityText = [
          order.product_price || '',
          order.purchase_quantity ? `x${order.purchase_quantity}` : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <div className="chat-order-card" key={order.order_id}>
            <div className="top">
              <span className="oid">订单号 {order.order_id}</span>
              <span className="status">
                {order.order_status_text || '待发货'}
              </span>
              <span>
                支付 {order.paid_at ? formatDateTime(order.paid_at) : '未识别'}
              </span>
              <span>
                最晚发货{' '}
                {order.latest_ship_at
                  ? formatDateTime(order.latest_ship_at)
                  : '未识别'}
              </span>
            </div>
            <div className="title">
              {order.product_title || '未识别商品标题'}
            </div>
            <div className="meta">
              <span>商品ID {order.product_id || '未识别'}</span>
              <span>金额 {priceQuantityText || '未识别'}</span>
              <span>买家 {order.buyer_name || '未识别'}</span>
              <span>UID {order.buyer_user_id || '未识别'}</span>
              <span>收件 {order.receiver_name || '未识别'}</span>
              <span>地址 {order.receiver_address || '未识别'}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
