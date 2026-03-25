import { useState } from 'react';
import { AppProvider, useAppState } from './context/AppContext';
import { usePolling } from './context/usePolling';
import { useIsMobile } from './hooks/useIsMobile';
import { useMobileNav } from './hooks/useMobileNav';
import { useViewportHeight } from './hooks/useViewportHeight';
import Header from './components/Header/Header';
import Sidebar from './components/Sidebar/Sidebar';
import ChatPanel from './components/ChatPanel/ChatPanel';
import OrdersOverlay from './components/OrdersDrawer/OrdersOverlay';
import OrdersDrawer from './components/OrdersDrawer/OrdersDrawer';
import Toast from './components/Toast/Toast';

function AppContent() {
  const [searchQuery, setSearchQuery] = useState('');
  const { activeKey } = useAppState();
  const isMobile = useIsMobile();

  // Start polling for data
  usePolling(3000);

  // Pin layout to visual viewport (fixes iOS Safari keyboard)
  useViewportHeight();

  // Manage mobile history-based navigation (back gesture support)
  useMobileNav();

  // On mobile: "list" = show sidebar, "chat" = show chat panel
  const mobileView = isMobile && activeKey ? 'chat' : 'list';

  return (
    <>
      <Header searchQuery={searchQuery} onSearchChange={setSearchQuery} />
      <div className={`layout${isMobile ? ` mobile-view-${mobileView}` : ''}`}>
        <Sidebar searchQuery={searchQuery} />
        <ChatPanel />
      </div>
      <OrdersOverlay />
      <OrdersDrawer />
      <Toast />
    </>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
