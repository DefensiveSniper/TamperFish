import { useAppState, useAppDispatch } from '../../context/AppContext';
import { postMarkSessionRead } from '../../services/sessionsApi';
import SidebarItem from './SidebarItem';
import './Sidebar.css';

interface SidebarProps {
  searchQuery: string;
}

export default function Sidebar({ searchQuery }: SidebarProps) {
  const { sessions, activeKey, chatCache } = useAppState();
  const dispatch = useAppDispatch();

  const filtered = searchQuery
    ? sessions.filter((s) => {
        const lq = searchQuery.toLowerCase();
        return (
          s.customer_name.toLowerCase().includes(lq) ||
          (s.chat_key || '').toLowerCase().includes(lq) ||
          (s.last_message || '').toLowerCase().includes(lq) ||
          (s.product_id || '').includes(lq)
        );
      })
    : sessions;

  const handleClick = (chatKey: string) => {
    dispatch({ type: 'SET_ACTIVE_KEY', key: chatKey });
    postMarkSessionRead(chatKey).catch(() => {});
  };

  return (
    <div id="sidebar">
      {filtered.length === 0 ? (
        <div id="sidebar-msg">
          {sessions.length === 0 ? '加载中...' : '🔍 无匹配结果'}
        </div>
      ) : (
        filtered.map((session, index) => {
          const cached = chatCache[session.chat_key];
          const outgoing = cached?.outgoing || [];
          const pendingCount = outgoing.filter(
            (o) => o.status === 'pending' || o.status === 'sending'
          ).length;

          return (
            <SidebarItem
              key={session.chat_key}
              session={session}
              isActive={activeKey === session.chat_key}
              pendingCount={pendingCount}
              onClick={handleClick}
              index={index}
            />
          );
        })
      )}
    </div>
  );
}
