import { useAppState, useAppDispatch } from '../../context/AppContext';
import { postMarkSessionRead } from '../../services/sessionsApi';
import SidebarItem from './SidebarItem';
import './Sidebar.css';

interface SidebarProps {
  searchQuery: string;
}

export default function Sidebar({ searchQuery }: SidebarProps) {
  const { sessions, activeKey, chatCache, bootstrapError } = useAppState();
  const dispatch = useAppDispatch();

  const filtered = sessions;

  const handleClick = (chatKey: string, externalMessageId?: string | null) => {
    dispatch({ type: 'SET_ACTIVE_KEY', key: chatKey });
    if (externalMessageId) {
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('tamperfish:jump-to-message', {
          detail: { chatKey, externalMessageId },
        }));
      }, 0);
    }
    postMarkSessionRead(chatKey).catch(() => {});
  };

  return (
    <div id="sidebar">
      {filtered.length === 0 ? (
        <div id="sidebar-msg">
          {sessions.length === 0 ? (bootstrapError || (searchQuery ? '🔍 无匹配结果' : '加载中...')) : '🔍 无匹配结果'}
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
              searchQuery={searchQuery}
              index={index}
            />
          );
        })
      )}
    </div>
  );
}
