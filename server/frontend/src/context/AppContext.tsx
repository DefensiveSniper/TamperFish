import React, { createContext, useContext, useReducer, useCallback, type ReactNode } from 'react';
import type { Session, AppSettings, QianniuRuntime, Order, ChatSnapshot, Client, LocalOutgoingMessage, OutgoingMessage, Message } from '../types/api';

export interface AppState {
  sessions: Session[];
  activeKey: string | null;
  appSettings: AppSettings;
  qianniuRuntime: QianniuRuntime;
  chatCache: Record<string, ChatSnapshot>;
  localOutgoingByChat: Record<string, LocalOutgoingMessage[]>;
  ordersCache: Order[];
  ordersFilter: 'all' | 'linked' | 'unlinked';
  ordersSearch: string;
  isOrdersDrawerOpen: boolean;
  toast: { message: string; type: 'success' | 'error' | '' } | null;
  bootstrapError: string | null;
  // Multi-client state
  clients: Client[];
  activeClientId: string;
  activeAccountId: string;
}

const defaultSettings: AppSettings = {
  autoReplyEnabled: false,
  crawlerDesiredEnabled: false,
  crawlerReportedEnabled: null,
  crawlerLastHeartbeatAt: null,
  initialCrawlSessionCount: 20,
  initialCrawlNonce: null,
};

const defaultRuntime: QianniuRuntime = {
  isOnline: false,
  pageUrl: '',
  visibleOrderCount: 0,
  scanState: 'idle',
  lastHeartbeatAt: null,
  lastSyncAt: null,
  lastSyncStats: null,
  syncNowNonce: null,
  fullScanNonce: null,
};

const initialState: AppState = {
  sessions: [],
  activeKey: null,
  appSettings: defaultSettings,
  qianniuRuntime: defaultRuntime,
  chatCache: {},
  localOutgoingByChat: {},
  ordersCache: [],
  ordersFilter: 'all',
  ordersSearch: '',
  isOrdersDrawerOpen: false,
  toast: null,
  bootstrapError: null,
  clients: [],
  activeClientId: '',
  activeAccountId: 'default',
};

type Action =
  | { type: 'SET_SESSIONS'; sessions: Session[] }
  | { type: 'SET_ACTIVE_KEY'; key: string | null }
  | { type: 'SET_SETTINGS'; settings: AppSettings }
  | { type: 'SET_RUNTIME'; runtime: QianniuRuntime }
  | { type: 'SET_CHAT_CACHE'; chatKey: string; snapshot: ChatSnapshot }
  | { type: 'UPSERT_LOCAL_OUTGOING'; chatKey: string; item: LocalOutgoingMessage }
  | { type: 'MARK_LOCAL_OUTGOING_FAILED'; chatKey: string; localId: string; error: string }
  | { type: 'RECONCILE_LOCAL_OUTGOING'; chatKey: string; outgoing: OutgoingMessage[]; messages: Message[] }
  | { type: 'SET_ORDERS'; orders: Order[] }
  | { type: 'SET_ORDERS_FILTER'; filter: 'all' | 'linked' | 'unlinked' }
  | { type: 'SET_ORDERS_SEARCH'; search: string }
  | { type: 'TOGGLE_ORDERS_DRAWER'; open?: boolean }
  | { type: 'SHOW_TOAST'; message: string; toastType: 'success' | 'error' | '' }
  | { type: 'CLEAR_TOAST' }
  | { type: 'SET_BOOTSTRAP_ERROR'; error: string | null }
  | { type: 'SET_CLIENTS'; clients: Client[] }
  | { type: 'SET_ACTIVE_CLIENT'; clientId: string }
  | { type: 'SET_ACTIVE_ACCOUNT'; accountId: string };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_SESSIONS':
      return { ...state, sessions: action.sessions };
    case 'SET_ACTIVE_KEY':
      return { ...state, activeKey: action.key };
    case 'SET_SETTINGS':
      return { ...state, appSettings: action.settings };
    case 'SET_RUNTIME':
      return { ...state, qianniuRuntime: action.runtime };
    case 'SET_CHAT_CACHE':
      return { ...state, chatCache: { ...state.chatCache, [action.chatKey]: action.snapshot } };
    case 'UPSERT_LOCAL_OUTGOING': {
      const current = state.localOutgoingByChat[action.chatKey] || [];
      return {
        ...state,
        localOutgoingByChat: {
          ...state.localOutgoingByChat,
          [action.chatKey]: [...current.filter((item) => item.local_id !== action.item.local_id), action.item],
        },
      };
    }
    case 'MARK_LOCAL_OUTGOING_FAILED': {
      const current = state.localOutgoingByChat[action.chatKey] || [];
      return {
        ...state,
        localOutgoingByChat: {
          ...state.localOutgoingByChat,
          [action.chatKey]: current.map((item) => (
            item.local_id === action.localId
              ? {
                ...item,
                status: 'failed',
                error: action.error,
              }
              : item
          )),
        },
      };
    }
    case 'RECONCILE_LOCAL_OUTGOING': {
      const current = state.localOutgoingByChat[action.chatKey] || [];
      if (!current.length) {
        return state;
      }

      const serverOutgoingById = new Map(action.outgoing.map((item) => [item.id, item]));
      const deliveredOutgoingIds = new Set(
        action.messages
          .map((message) => message.outgoing_message_id)
          .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      );

      return {
        ...state,
        localOutgoingByChat: {
          ...state.localOutgoingByChat,
          [action.chatKey]: current.flatMap((item) => {
            if (deliveredOutgoingIds.has(item.id)) {
              return [];
            }

            const serverItem = serverOutgoingById.get(item.id);
            if (serverItem) {
              return [{
                ...item,
                status: serverItem.status,
                sent_at: serverItem.sent_at,
                claimed_at: serverItem.claimed_at,
                error: serverItem.error,
                retries: serverItem.retries,
              }];
            }

            if (item.status === 'failed') {
              return [item];
            }

            return [item];
          }),
        },
      };
    }
    case 'SET_ORDERS':
      return { ...state, ordersCache: action.orders };
    case 'SET_ORDERS_FILTER':
      return { ...state, ordersFilter: action.filter };
    case 'SET_ORDERS_SEARCH':
      return { ...state, ordersSearch: action.search };
    case 'TOGGLE_ORDERS_DRAWER':
      return { ...state, isOrdersDrawerOpen: action.open ?? !state.isOrdersDrawerOpen };
    case 'SHOW_TOAST':
      return { ...state, toast: { message: action.message, type: action.toastType } };
    case 'CLEAR_TOAST':
      return { ...state, toast: null };
    case 'SET_BOOTSTRAP_ERROR':
      return { ...state, bootstrapError: action.error };
    case 'SET_CLIENTS': {
      const ids = action.clients.map((c) => c.client_id);
      const needFix = ids.length > 0 && !ids.includes(state.activeClientId);
      return {
        ...state,
        clients: action.clients,
        ...(needFix ? { activeClientId: ids[0] } : {}),
      };
    }
    case 'SET_ACTIVE_CLIENT':
      return { ...state, activeClientId: action.clientId };
    case 'SET_ACTIVE_ACCOUNT':
      return { ...state, activeAccountId: action.accountId };
    default:
      return state;
  }
}

// Create the context with both state and dispatch
const AppStateContext = createContext<AppState>(initialState);
const AppDispatchContext = createContext<React.Dispatch<Action>>(() => {});

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>
        {children}
      </AppDispatchContext.Provider>
    </AppStateContext.Provider>
  );
}

export function useAppState() {
  return useContext(AppStateContext);
}

export function useAppDispatch() {
  return useContext(AppDispatchContext);
}

// Convenience hook for toast
export function useToast() {
  const dispatch = useAppDispatch();
  const show = useCallback((message: string, type: 'success' | 'error' | '' = '') => {
    dispatch({ type: 'SHOW_TOAST', message, toastType: type });
    setTimeout(() => dispatch({ type: 'CLEAR_TOAST' }), 3000);
  }, [dispatch]);
  return show;
}
