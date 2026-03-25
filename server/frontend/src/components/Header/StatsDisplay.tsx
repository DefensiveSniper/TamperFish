import { useAppState } from '../../context/AppContext';
import { getCrawlerSyncText } from './CrawlerToggle';

export default function StatsDisplay() {
  const { sessions, appSettings } = useAppState();
  const crawlerSyncText = getCrawlerSyncText(appSettings);

  return (
    <span id="stats">
      {sessions.length} 个会话 · AI{appSettings.autoReplyEnabled ? '开' : '关'} · 巡逻{crawlerSyncText}
    </span>
  );
}
