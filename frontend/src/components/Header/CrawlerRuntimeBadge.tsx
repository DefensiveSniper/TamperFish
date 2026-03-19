import { useAppState } from '../../context/AppContext';
import { getCrawlerSyncText } from './CrawlerToggle';

function getCrawlerHeartbeatText(lastHeartbeatAt: number | null): string {
  const ts = Number(lastHeartbeatAt || 0);
  if (!ts) return '未上报';
  const diff = Math.max(Math.floor(Date.now() / 1000) - ts, 0);
  if (diff < 5) return '刚刚';
  if (diff < 60) return `${diff} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  return `${Math.floor(diff / 3600)} 小时前`;
}

export default function CrawlerRuntimeBadge() {
  const { appSettings } = useAppState();

  const syncText = getCrawlerSyncText(appSettings);
  const heartbeatText = getCrawlerHeartbeatText(appSettings.crawlerLastHeartbeatAt);

  const className =
    syncText === '已同步'
      ? 'online'
      : syncText === '同步中'
        ? 'syncing'
        : 'offline';

  const actualText =
    typeof appSettings.crawlerReportedEnabled === 'boolean'
      ? appSettings.crawlerReportedEnabled
        ? '脚本巡逻开'
        : '脚本巡逻关'
      : '脚本未上报';

  const title = `3210 正在控制油猴脚本 xm-crawl-toggle；最近心跳：${heartbeatText}`;

  return (
    <span
      className={`runtime-badge ${className}`}
      title={title}
    >
      {actualText} · {syncText} · {heartbeatText}
    </span>
  );
}
