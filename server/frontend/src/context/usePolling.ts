import { useEffect, useRef } from 'react';
import { useAppState, useAppDispatch } from './AppContext';
import { setActiveAccountId, setActiveClientId } from '../services/api';
import { getSettings } from '../services/settingsApi';
import { getSessions } from '../services/sessionsApi';
import { getSessionMessages } from '../services/sessionsApi';
import { getOutgoingMessages } from '../services/outgoingApi';
import { getOrders } from '../services/ordersApi';
import { getOrdersRuntime } from '../services/ordersApi';
import { getAllClients } from '../services/clientsApi';
import type { ChatSnapshot } from '../types/api';

export function usePolling(intervalMs = 3000) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const stateRef = useRef(state);
  stateRef.current = state;

  // Keep api module in sync with active account/client selection
  useEffect(() => {
    setActiveAccountId(state.activeAccountId);
  }, [state.activeAccountId]);

  useEffect(() => {
    setActiveClientId(state.activeClientId);
  }, [state.activeClientId]);

  useEffect(() => {
    let running = true;

    async function poll() {
      if (!running) return;
      const current = stateRef.current;

      try {
        // 0. Fetch client list
        try {
          const clients = await getAllClients();
          if (running) dispatch({ type: 'SET_CLIENTS', clients });
        } catch {
          // Client list failure is non-critical
        }

        // 1. Settings (account + client scoped via headers)
        const settings = await getSettings();
        if (running) dispatch({ type: 'SET_SETTINGS', settings });

        // 2. Sessions (account scoped via headers)
        const sessions = await getSessions();
        if (running) dispatch({ type: 'SET_SESSIONS', sessions });

        // 3. Active chat refresh
        if (current.activeKey) {
          try {
            const chatKey = current.activeKey;
            const [{ session, messages }, outgoing, linkedOrders] = await Promise.all([
              getSessionMessages(chatKey),
              getOutgoingMessages(chatKey),
              getOrders({ chatKey, limit: 10 }),
            ]);
            if (running) {
              const snapshot: ChatSnapshot = { session, messages, outgoing, linkedOrders };
              dispatch({ type: 'SET_CHAT_CACHE', chatKey, snapshot });
            }
          } catch {
            // Active chat refresh failure is non-critical
          }
        }

        // 4. Orders runtime (client scoped via headers)
        try {
          const runtime = await getOrdersRuntime();
          if (running) dispatch({ type: 'SET_RUNTIME', runtime });
        } catch {
          // Runtime failure is non-critical
        }

        // 5. If orders drawer is open, refresh orders
        if (current.isOrdersDrawerOpen) {
          try {
            const orders = await getOrders({
              linked: current.ordersFilter === 'all' ? undefined : current.ordersFilter,
              q: current.ordersSearch || undefined,
              limit: 200,
            });
            if (running) dispatch({ type: 'SET_ORDERS', orders });
          } catch {
            // Orders refresh failure is non-critical
          }
        }
      } catch {
        // Top-level poll failure — just skip this cycle
      }
    }

    // Initial load
    poll();

    const timer = setInterval(poll, intervalMs);
    return () => {
      running = false;
      clearInterval(timer);
    };
  }, [intervalMs, dispatch]);
}
