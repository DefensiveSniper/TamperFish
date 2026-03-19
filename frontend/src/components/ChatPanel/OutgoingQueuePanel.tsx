import type { OutgoingMessage } from '../../types/api';
import OutgoingQueueItem from './OutgoingQueueItem';

interface OutgoingQueuePanelProps {
  outgoing: OutgoingMessage[];
  isOpen: boolean;
  onClose: () => void;
}

export default function OutgoingQueuePanel({
  outgoing,
  isOpen,
  onClose,
}: OutgoingQueuePanelProps) {
  if (outgoing.length === 0) return null;

  return (
    <div id="outgoing-panel" className={isOpen ? 'show' : ''}>
      <div className="outgoing-header">
        <span>📤 发送队列 ({outgoing.length})</span>
        <button className="close-btn" onClick={onClose}>
          ✕
        </button>
      </div>
      {outgoing.map((item) => (
        <OutgoingQueueItem key={item.id} item={item} />
      ))}
    </div>
  );
}
