import { copyToClipboard } from '../../hooks/useCopyToClipboard';
import { useToast } from '../../hooks/useToast';

interface OrderMetaRowProps {
  label: string;
  value: string;
  copyable?: boolean;
  copyLabel?: string;
}

export default function OrderMetaRow({
  label,
  value,
  copyable = false,
  copyLabel,
}: OrderMetaRowProps) {
  const toast = useToast();
  const normalizedValue = (value || '').trim();

  const handleCopy = async () => {
    if (!normalizedValue) {
      toast(`${label || '内容'}为空`, 'error');
      return;
    }
    const ok = await copyToClipboard(normalizedValue);
    if (ok) {
      toast(`已复制${copyLabel || label}`, 'success');
    } else {
      toast(`${copyLabel || label}复制失败`, 'error');
    }
  };

  return (
    <div className="order-meta-row">
      <div className="order-meta-row-main">
        <strong>{label}</strong>
        <span>{normalizedValue || '未识别'}</span>
      </div>
      {copyable && normalizedValue && (
        <button className="order-copy-btn" onClick={handleCopy}>
          复制
        </button>
      )}
    </div>
  );
}
