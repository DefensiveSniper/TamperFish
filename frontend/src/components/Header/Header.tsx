import { useCallback } from 'react';
import { useAppState, useAppDispatch } from '../../context/AppContext';
import { useToast } from '../../hooks/useToast';
import { getOutgoingMessages } from '../../services/outgoingApi';
import AiToggle from './AiToggle';
import CrawlerToggle from './CrawlerToggle';
import CrawlerRuntimeBadge from './CrawlerRuntimeBadge';
import InitialCrawlControls from './InitialCrawlControls';
import StatsDisplay from './StatsDisplay';
import './Header.css';

interface HeaderProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export default function Header({ searchQuery, onSearchChange }: HeaderProps) {
  const { isOrdersDrawerOpen } = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();

  const handleOrdersClick = useCallback(() => {
    dispatch({ type: 'TOGGLE_ORDERS_DRAWER' });
  }, [dispatch]);

  const handleQueueClick = useCallback(async () => {
    try {
      const all = await getOutgoingMessages();
      if (!all.length) {
        toast('队列为空', '');
        return;
      }
      const pending = all.filter(
        (o) => o.status === 'pending' || o.status === 'sending'
      ).length;
      const sent = all.filter((o) => o.status === 'sent').length;
      const failed = all.filter((o) => o.status === 'failed').length;
      toast(
        `${all.length} 条: ${pending} 待发 · ${sent} 已发 · ${failed} 失败`,
        ''
      );
    } catch (e: unknown) {
      toast((e as Error).message, 'error');
    }
  }, [toast]);

  const handleRefresh = useCallback(() => {
    // Polling will handle the actual refresh; just show feedback
    toast('已刷新', '');
  }, [toast]);

  return (
    <header>
      <div className="logo">
        <div className="logo-icon">鱼</div>
        <h1>闲鱼聚合</h1>
      </div>
      <input
        id="search"
        type="text"
        placeholder="搜索买家 / 内容..."
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
      />
      <div className="header-actions">
        <AiToggle />
        <CrawlerToggle />
        <CrawlerRuntimeBadge />
        <InitialCrawlControls />
        <button
          className={`btn${isOrdersDrawerOpen ? ' active' : ''}`}
          title="查看千牛订单"
          onClick={handleOrdersClick}
        >
          📦 订单
        </button>
        <button className="btn" title="查看待发队列" onClick={handleQueueClick}>
          📤 待发队列
        </button>
        <button className="btn" onClick={handleRefresh}>
          ↻ 刷新
        </button>
        <StatsDisplay />
      </div>
    </header>
  );
}
