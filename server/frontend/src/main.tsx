import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/global.css';
import './styles/buttons.css';
import './components/Sidebar/Sidebar.css';
import './components/ChatPanel/ChatPanel.css';
import './components/OrdersDrawer/OrdersDrawer.css';
import './components/Header/Header.css';

createRoot(document.getElementById('root')!).render(<App />);
