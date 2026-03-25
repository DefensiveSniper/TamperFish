import type { OutgoingMessage } from '../../types/api';
import { timeAgo } from '../../utils';

interface OutgoingQueueItemProps {
  item: OutgoingMessage;
}

const statusLabelMap: Record<string, string> = {
  pending: '待发',
  sending: '发送中',
  sent: '已发',
  failed: '失败',
};

export default function OutgoingQueueItem({ item }: OutgoingQueueItemProps) {
  const time = item.sent_at ? timeAgo(item.sent_at) : timeAgo(item.created_at);
  const sourceClass = item.source === 'manual' ? 'manual' : 'ai';
  const sourceLabel = item.source === 'manual' ? '人工' : 'AI';
  const contentLabel = item.message_type === 'image'
    ? `[图片] ${item.media_name || '未命名图片'}`
    : item.content;
  const replyLabel = item.reply_to_preview
    ? `引用: ${item.reply_to_preview}`
    : null;

  return (
    <div className="oq-item">
      <div className={`oq-status ${item.status}`} />
      <span className={`oq-source ${sourceClass}`}>{sourceLabel}</span>
      <div className="oq-content">
        {replyLabel ? `${replyLabel} / ${contentLabel}` : contentLabel}
      </div>
      <span className={`oq-label ${item.status}`}>
        {statusLabelMap[item.status] || item.status}
      </span>
      <div className="oq-time">{time}</div>
    </div>
  );
}
