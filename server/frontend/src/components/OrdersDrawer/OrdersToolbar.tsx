import { useState } from 'react';
import { useAppState, useAppDispatch } from '../../context/AppContext';
import { postOrdersFullScan } from '../../services/ordersApi';
import { useToast } from '../../hooks/useToast';

export default function OrdersToolbar() {
  const { ordersFilter, ordersSearch, qianniuRuntime } = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [scanning, setScanning] = useState(false);

  const filters: { key: 'all' | 'linked' | 'unlinked'; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'linked', label: '已关联' },
    { key: 'unlinked', label: '未关联' },
  ];

  const handleFullScan = async () => {
    setScanning(true);
    try {
      const result = await postOrdersFullScan();
      dispatch({ type: 'SET_RUNTIME', runtime: result.runtime });
      toast('已下发千牛全量扫描请求', 'success');
    } catch (e: unknown) {
      toast((e as Error).message, 'error');
    } finally {
      setScanning(false);
    }
  };

  const isScanning = qianniuRuntime.scanState === 'scanning' || scanning;

  return (
    <div className="orders-toolbar">
      <div className="orders-filter-group">
        {filters.map((f) => (
          <button
            key={f.key}
            className={`btn${ordersFilter === f.key ? ' active' : ''}`}
            onClick={() =>
              dispatch({ type: 'SET_ORDERS_FILTER', filter: f.key })
            }
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="orders-search-row">
        <input
          id="orders-search"
          type="text"
          placeholder="搜索订单号 / 买家 / 电话尾号 / 商品 ID"
          value={ordersSearch}
          onChange={(e) =>
            dispatch({ type: 'SET_ORDERS_SEARCH', search: e.target.value })
          }
        />
        <button
          className="btn"
          disabled={isScanning}
          onClick={handleFullScan}
        >
          {isScanning ? '扫描中...' : '全量扫描'}
        </button>
      </div>
    </div>
  );
}
