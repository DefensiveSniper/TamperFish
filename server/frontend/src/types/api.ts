// Session from GET /api/sessions - the API returns sessions with computed fields
export interface Session {
  chat_key: string;
  account_id: string;
  customer_name: string;
  product_id: string | null;
  product_json: string; // JSON string
  session_id: string | null;
  session_info_json: string; // JSON string
  buyer_user_id: string | null;
  last_seen_client_id: string | null;
  created_at: number;
  updated_at: number;
  // Computed by db.listSessions():
  message_count: number;
  unread_count: number;
  last_message: string | null;
  last_is_me: number | null; // 0 or 1
  last_time: number | null;
  pending_count: number;
}

export interface ProductInfo {
  price?: string;
  location?: string;
  url?: string;
  id?: string;
  userId?: string;
}

export interface Message {
  id: number;
  account_id: string;
  chat_key: string;
  msg_hash: string;
  seq: number;
  content: string;
  is_me: number; // 0 or 1
  type: 'text' | 'image';
  ingested_at: number;
  external_message_id: string | null;
  reply_to_message_id: string | null;
}

export interface OutgoingMessage {
  id: number;
  account_id: string;
  chat_key: string;
  customer_name: string;
  product_id: string | null;
  session_id: string | null;
  content: string;
  message_type: 'text' | 'image';
  media_name: string | null;
  reply_to_external_message_id: string | null;
  reply_to_preview: string | null;
  reply_to_type: 'text' | 'image' | null;
  target_client_id: string | null;
  claimed_by_client_id: string | null;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  source: 'manual' | 'ai';
  created_at: number;
  sent_at: number | null;
  claimed_at: number | null;
  error: string | null;
  retries: number;
}

export interface PostOutgoingMessageBody {
  chatKey: string;
  sessionId?: string;
  content?: string;
  messageType?: 'text' | 'image';
  mediaData?: string;
  mediaName?: string;
  replyToExternalMessageId?: string;
  replyToPreview?: string;
  replyToType?: 'text' | 'image';
  source?: 'manual' | 'ai';
  customerName?: string;
  productId?: string;
}

export interface Order {
  id: number;
  account_id: string;
  order_id: string;
  chat_key: string | null;
  buyer_name: string | null;
  buyer_user_id: string | null;
  product_id: string | null;
  product_title: string | null;
  product_price: string | null;
  purchase_quantity: number | null;
  receiver_name: string | null;
  receiver_phone: string | null;
  receiver_address: string | null;
  order_status_text: string | null;
  paid_at: number | null;
  latest_ship_at: number | null;
  last_seen_at: number | null;
  status: string;
  raw_json: string;
  created_at: number;
  updated_at: number;
}

export interface AppSettings {
  autoReplyEnabled: boolean;
  crawlerDesiredEnabled: boolean;
  crawlerReportedEnabled: boolean | null;
  crawlerLastHeartbeatAt: number | null;
  initialCrawlSessionCount: number;
  initialCrawlNonce: string | null;
}

export interface QianniuRuntime {
  isOnline: boolean;
  pageUrl: string;
  visibleOrderCount: number;
  scanState: 'idle' | 'scanning';
  lastHeartbeatAt: number | null;
  lastSyncAt: number | null;
  lastSyncStats: {
    inserted: number;
    updated: number;
    matched: number;
    unmatched: number;
  } | null;
  syncNowNonce: string | null;
  fullScanNonce: string | null;
}

export interface ChatSnapshot {
  session: Session;
  messages: Message[];
  outgoing: OutgoingMessage[];
  linkedOrders: Order[];
}

// Query params for orders
export interface OrderQueryParams {
  linked?: 'all' | 'linked' | 'unlinked';
  q?: string;
  limit?: number;
  chatKey?: string;
}

// Client info from GET /api/clients
export interface Client {
  client_id: string;
  account_id: string;
  client_name: string;
  capabilities_json: string;
  last_seen_at: number | null;
  status: 'active' | 'disabled';
  created_at: number;
  updated_at: number;
  isOnline: boolean;
  lastHeartbeatAt: number;
}
