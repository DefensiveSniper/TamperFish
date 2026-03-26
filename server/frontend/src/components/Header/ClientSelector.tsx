import { useAppState, useAppDispatch } from '../../context/AppContext';
import { setActiveClientId } from '../../services/api';

export default function ClientSelector() {
  const { clients, activeClientId } = useAppState();
  const dispatch = useAppDispatch();

  if (clients.length <= 1) {
    // Single client — no need for selector
    return null;
  }

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const clientId = e.target.value;
    dispatch({ type: 'SET_ACTIVE_CLIENT', clientId });
    setActiveClientId(clientId);
  };

  return (
    <select
      className="client-selector"
      value={activeClientId}
      onChange={handleChange}
      title="选择客户端"
      style={{
        padding: '2px 8px',
        borderRadius: '4px',
        border: '1px solid #555',
        background: '#2a2a2a',
        color: '#eee',
        fontSize: '12px',
        cursor: 'pointer',
      }}
    >
      {clients.map((c) => (
        <option key={c.client_id} value={c.client_id}>
          {c.client_name || c.client_id}
          {c.isOnline ? ' ●' : ' ○'}
        </option>
      ))}
    </select>
  );
}
