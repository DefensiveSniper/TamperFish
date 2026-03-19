import { useState } from 'react';
import { AppProvider } from './context/AppContext';
import { usePolling } from './context/usePolling';
import Header from './components/Header/Header';
import Sidebar from './components/Sidebar/Sidebar';
import ChatPanel from './components/ChatPanel/ChatPanel';
import OrdersOverlay from './components/OrdersDrawer/OrdersOverlay';
import OrdersDrawer from './components/OrdersDrawer/OrdersDrawer';
import Toast from './components/Toast/Toast';

function AppContent() {
  const [searchQuery, setSearchQuery] = useState('');

  // Start polling for data
  usePolling(3000);

  return (
    <>
      <Header searchQuery={searchQuery} onSearchChange={setSearchQuery} />
      <div className="layout">
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
