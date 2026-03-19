import { useEffect } from 'react';
import { useAppState, useAppDispatch } from '../../context/AppContext';
import { getOrders } from '../../services/ordersApi';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import OrdersRuntimeCard from './OrdersRuntimeCard';
import OrdersToolbar from './OrdersToolbar';
import OrderCard from './OrderCard';
import './OrdersDrawer.css';

export default function OrdersDrawer() {
  const { isOrdersDrawerOpen, ordersCache, ordersFilter, ordersSearch } =
    useAppState();
  const dispatch = useAppDispatch();

  const debouncedSearch = useDebouncedValue(ordersSearch, 180);

  // Load orders when drawer opens or filter/search changes
  useEffect(() => {
    if (!isOrdersDrawerOpen) return;

    (async () => {
      try {
        const orders = await getOrders({
          linked: ordersFilter === 'all' ? undefined : ordersFilter,
          q: debouncedSearch || undefined,
          limit: 200,
        });
        dispatch({ type: 'SET_ORDERS', orders });
      } catch {
        // non-critical
      }
    })();
  }, [isOrdersDrawerOpen, ordersFilter, debouncedSearch, dispatch]);

  const handleClose = () => {
    dispatch({ type: 'TOGGLE_ORDERS_DRAWER', open: false });
  };

  return (
    <aside
      id="orders-drawer"
      className={isOrdersDrawerOpen ? 'show' : ''}
    >
      <div className="orders-drawer-header">
        <div className="orders-drawer-title">
          <span className="orders-drawer-icon">📦</span>
          <div>
            <div className="orders-drawer-name">千牛订单</div>
            <div className="orders-drawer-subtitle">
              待发货订单聚合与会话关联
            </div>
          </div>
        </div>
        <button className="orders-close-btn" onClick={handleClose}>
          ✕
        </button>
      </div>

      <OrdersRuntimeCard />
      <OrdersToolbar />

      <div className="orders-list">
        {ordersCache.length === 0 ? (
          <div className="orders-empty">当前筛选条件下没有订单</div>
        ) : (
          ordersCache.map((order) => (
            <OrderCard
              key={order.order_id}
              order={order}
              onCloseDrawer={handleClose}
            />
          ))
        )}
      </div>
    </aside>
  );
}
