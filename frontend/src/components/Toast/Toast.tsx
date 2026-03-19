import { useAppState } from '../../context/AppContext';
import './Toast.css';

export default function Toast() {
  const { toast } = useAppState();

  const classNames = ['toast'];
  if (toast) {
    classNames.push('show');
    if (toast.type) classNames.push(toast.type);
  }

  return (
    <div id="toast" className={classNames.join(' ')}>
      {toast?.message ?? ''}
    </div>
  );
}
