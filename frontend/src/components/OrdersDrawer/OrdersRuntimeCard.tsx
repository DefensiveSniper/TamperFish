import { useState } from 'react';
import { useAppState, useAppDispatch } from '../../context/AppContext';
import { postOrdersSyncNow } from '../../services/ordersApi';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils';

export default function OrdersRuntimeCard() {
  const { qianniuRuntime } = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [syncingNow, setSyncingNow] = useState(false);

  const getStatus = () => {
    if (qianniuRuntime.scanState === 'scanning') {
      return { className: 'scanning', text: '全量扫描中' };
    }
    if (qianniuRuntime.isOnline) {
      return { className: 'online', text: '脚本在线' };
    }
    return { className: 'offline', text: '脚本离线' };
  };

  const status = getStatus();
  const stats = qianniuRuntime.lastSyncStats || {
    inserted: 0,
    updated: 0,
    matched: 0,
    unmatched: 0,
  };
  const syncedAtText = qianniuRuntime.lastSyncAt
    ? formatDateTime(qianniuRuntime.lastSyncAt)
    : '尚未同步';
  const pageText = qianniuRuntime.pageUrl
    ? '已打开 batch-consign 页面'
    : '尚未检测到千牛页面';

  const syncNowPending = !!qianniuRuntime.syncNowNonce;
  const syncNowDisabled =
    !qianniuRuntime.isOnline ||
    qianniuRuntime.scanState === 'scanning' ||
    syncNowPending ||
    syncingNow;

  const handleSyncNow = async () => {
    if (!qianniuRuntime.isOnline) {
      toast('当前未检测到千牛脚本在线', 'error');
      return;
    }
    setSyncingNow(true);
    try {
      const result = await postOrdersSyncNow();
      dispatch({ type: 'SET_RUNTIME', runtime: result.runtime });
      toast('已下发千牛当前页立即同步请求', 'success');
    } catch (e: unknown) {
      toast((e as Error).message, 'error');
    } finally {
      setSyncingNow(false);
    }
  };

  return (
    <div className="orders-runtime">
      <div className="orders-runtime-top">
        <div className="orders-runtime-heading">
          <span className={`orders-runtime-status ${status.className}`}>
            {status.text}
          </span>
          <span className="orders-runtime-page">{pageText}</span>
        </div>
        <div className="orders-runtime-actions">
          <button
            className="btn"
            disabled={syncNowDisabled}
            onClick={handleSyncNow}
          >
            {syncNowPending || syncingNow ? '同步中...' : '立即同步'}
          </button>
        </div>
      </div>
      <div className="orders-runtime-grid">
        <div className="orders-runtime-metric">
          <div className="label">当前页订单</div>
          <div className="value">{qianniuRuntime.visibleOrderCount || 0}</div>
        </div>
        <div className="orders-runtime-metric">
          <div className="label">最近同步</div>
          <div className="value">{syncedAtText}</div>
        </div>
        <div className="orders-runtime-metric">
          <div className="label">最近写库</div>
          <div className="value">
            {(stats.inserted || 0) + (stats.updated || 0)} 条
          </div>
        </div>
        <div className="orders-runtime-metric">
          <div className="label">关联结果</div>
          <div className="value">
            {stats.matched || 0} 已关联 / {stats.unmatched || 0} 未关联
          </div>
        </div>
      </div>
    </div>
  );
}
