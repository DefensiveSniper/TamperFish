import { useAppState, useAppDispatch } from '../../context/AppContext';
import { setActiveClientId, setActiveAccountId } from '../../services/api';

export default function ClientSelector() {
  const { clients, activeClientId } = useAppState();
  const dispatch = useAppDispatch();

  if (clients.length === 0) return null;

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const clientId = e.target.value;
    const client = clients.find((c) => c.client_id === clientId);
    if (!client) return;

    dispatch({ type: 'SET_ACTIVE_CLIENT', clientId });
    setActiveClientId(clientId);

    // Switch account context along with client
    dispatch({ type: 'SET_ACTIVE_ACCOUNT', accountId: client.account_id });
    setActiveAccountId(client.account_id);
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
          {c.account_id !== clients[0]?.account_id ? ` (${c.account_id})` : ''}
          {c.isOnline ? ' ●' : ' ○'}
        </option>
      ))}
    </select>
  );
}
