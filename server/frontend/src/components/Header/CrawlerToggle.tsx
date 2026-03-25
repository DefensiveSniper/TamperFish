import { useState } from 'react';
import { useAppState, useAppDispatch } from '../../context/AppContext';
import { patchSettings } from '../../services/settingsApi';
import { useToast } from '../../hooks/useToast';

function getCrawlerSyncText(settings: {
  crawlerLastHeartbeatAt: number | null;
  crawlerReportedEnabled: boolean | null;
  crawlerDesiredEnabled: boolean;
}): string {
  const lastHeartbeatAt = Number(settings.crawlerLastHeartbeatAt || 0);
  if (!lastHeartbeatAt) return '未同步';
  const secondsSinceHeartbeat = Math.floor(Date.now() / 1000) - lastHeartbeatAt;
  if (
    secondsSinceHeartbeat > 10 ||
    typeof settings.crawlerReportedEnabled !== 'boolean'
  ) {
    return '未同步';
  }
  return settings.crawlerReportedEnabled === !!settings.crawlerDesiredEnabled
    ? '已同步'
    : '同步中';
}

export default function CrawlerToggle() {
  const { appSettings } = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const desiredEnabled = !!appSettings.crawlerDesiredEnabled;
  const syncText = getCrawlerSyncText(appSettings);

  let pillClass = 'btn toggle-pill';
  if (desiredEnabled && syncText === '已同步') {
    pillClass += ' on';
  } else if (!desiredEnabled) {
    pillClass += ' off';
  } else {
    pillClass += ' warn';
  }

  const title = desiredEnabled
    ? '点击关闭油猴脚本 xm-crawl-toggle；精准发送与按需补水仍会继续'
    : '点击开启油猴脚本 xm-crawl-toggle，用于常驻预热会话索引';

  const handleClick = async () => {
    const nextValue = !desiredEnabled;
    setBusy(true);
    try {
      const result = await patchSettings({ crawlerDesiredEnabled: nextValue });
      dispatch({ type: 'SET_SETTINGS', settings: result });
      toast(
        nextValue
          ? '已请求开启后台巡逻；精准发送始终可用'
          : '已请求关闭后台巡逻；精准发送与按需补水不受影响',
        'success'
      );
    } catch (e: unknown) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className={pillClass}
      title={title}
      disabled={busy}
      onClick={handleClick}
    >
      <span className="toggle-indicator" />
      <span>
        {desiredEnabled ? '巡逻开启' : '巡逻关闭'} · {syncText}
      </span>
    </button>
  );
}

export { getCrawlerSyncText };
