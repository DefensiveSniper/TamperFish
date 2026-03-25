import { useState } from 'react';
import { useAppState, useAppDispatch } from '../../context/AppContext';
import { patchSettings } from '../../services/settingsApi';
import { useToast } from '../../hooks/useToast';

export default function AiToggle() {
  const { appSettings } = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const enabled = !!appSettings.autoReplyEnabled;

  const pillClass = `btn toggle-pill ${enabled ? 'on' : 'off'}`;
  const title = enabled
    ? '点击关闭 AI 自动回复，转为人工介入'
    : '点击开启 AI 自动回复';

  const handleClick = async () => {
    const nextValue = !enabled;
    setBusy(true);
    try {
      const result = await patchSettings({ autoReplyEnabled: nextValue });
      dispatch({ type: 'SET_SETTINGS', settings: result });
      toast(
        nextValue ? 'AI 自动回复已开启' : 'AI 自动回复已关闭，当前由人工接管',
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
      <span>{enabled ? 'AI 回复开启' : 'AI 回复关闭'}</span>
    </button>
  );
}
