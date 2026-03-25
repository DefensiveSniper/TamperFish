import { useState } from 'react';
import { useAppState, useAppDispatch } from '../../context/AppContext';
import { patchSettings, postInitialCrawl } from '../../services/settingsApi';
import { useToast } from '../../hooks/useToast';

export default function InitialCrawlControls() {
  const { appSettings } = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(appSettings.initialCrawlSessionCount || 30);

  const isCrawling =
    !!appSettings.initialCrawlRequestedNonce &&
    appSettings.initialCrawlRequestedNonce !== appSettings.initialCrawlHandledNonce;

  const handleTrigger = async () => {
    setBusy(true);
    try {
      // Save count first
      await patchSettings({ initialCrawlSessionCount: count });
      // Then trigger crawl
      const result = await postInitialCrawl();
      // Reload settings to get updated nonce state
      dispatch({
        type: 'SET_SETTINGS',
        settings: {
          ...appSettings,
          initialCrawlSessionCount: count,
          initialCrawlRequestedNonce: result.requestedNonce,
        },
      });
      toast(`已请求初始遍历 ${count} 个会话`, 'success');
    } catch (e: unknown) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        type="number"
        min={1}
        max={100}
        value={count}
        title="初始遍历会话数量"
        style={{
          width: '48px',
          padding: '2px 4px',
          borderRadius: '4px',
          border: '1px solid #555',
          background: '#2a2a2a',
          color: '#eee',
          fontSize: '12px',
          textAlign: 'center',
        }}
        onChange={(e) => setCount(Number(e.target.value) || 30)}
      />
      <button
        className="btn"
        title="手动触发初始遍历 N 个会话"
        disabled={busy || isCrawling}
        onClick={handleTrigger}
      >
        {isCrawling ? '遍历中...' : '初始遍历'}
      </button>
    </>
  );
}
