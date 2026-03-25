import { useAppState, useAppDispatch } from '../../context/AppContext';

export default function OrdersOverlay() {
  const { isOrdersDrawerOpen } = useAppState();
  const dispatch = useAppDispatch();

  return (
    <div
      id="orders-overlay"
      className={isOrdersDrawerOpen ? 'show' : ''}
      onClick={() => dispatch({ type: 'TOGGLE_ORDERS_DRAWER', open: false })}
    />
  );
}
