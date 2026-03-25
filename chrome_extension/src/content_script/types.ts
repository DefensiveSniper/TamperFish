/**
 * types.ts — Content Script 所有接口与类型定义
 *
 * 本文件集中定义 chrome_extension content script 使用的全部 TypeScript 接口，
 * 从 content_script.js 源文件提取并补全类型信息。
 */

// ---------------------------------------------------------------------------
// 配置相关
// ---------------------------------------------------------------------------

/** CSS 选择器配置，用于在闲鱼聊天页面定位消息节点 */
export interface SelectorConfig {
  /** 自己发出的消息气泡容器 */
  myMessage: string;
  /** 对方发出的消息气泡容器 */
  theirMessage: string;
  /** 消息文本内容节点 */
  messageText: string;
  /** 消息行根节点（包含方向信息） */
  messageNode: string;
  /** 图片消息容器 */
  imageContainer: string;
}

/** 全局运行配置，对应源文件 CONFIG 常量 */
export interface Config {
  /** 从页面 header 提取的当前用户昵称（运行时填入） */
  userName: string;

  // --- 自动抓取配置 ---
  /** 是否启用自动抓取 */
  autoCrawl: boolean;
  /** 两次抓取之间的最小随机延迟（毫秒） */
  minDelay: number;
  /** 两次抓取之间的最大随机延迟（毫秒） */
  maxDelay: number;
  /** 单次抓取循环最大会话数上限 */
  maxCrawlLimit: number;
  /** 启动就绪等待超时（毫秒） */
  startupReadyTimeoutMs: number;
  /** 启动就绪后额外延迟（毫秒） */
  startupPostReadyDelayMs: number;
  /** 初始会话同步的最大条数 */
  initialConversationSyncLimit: number;
  /** 初始会话逐条点击延迟（毫秒） */
  initialConversationClickDelayMs: number;
  /** 初始会话逐条点击间隔（毫秒） */
  initialConversationBetweenDelayMs: number;
  /** 未读消息轮询间隔（毫秒） */
  unreadWatchIntervalMs: number;
  /** 未读消息处理冷却时间（毫秒） */
  unreadHandleCooldownMs: number;
  /** 历史记录加载每步延迟（毫秒） */
  historyLoadStepDelayMs: number;
  /** 历史记录加载最大滚动次数 */
  historyLoadMaxScrolls: number;
  /** 历史记录加载最大持续时间（毫秒） */
  historyLoadMaxDurationMs: number;
  /** 状态保存防抖延迟（毫秒） */
  stateSaveDebounceMs: number;
  /** 面板重绘防抖延迟（毫秒） */
  panelRenderDebounceMs: number;
  /** 外发消息发送轮询间隔（毫秒） */
  senderPollIntervalMs: number;
  /** WSS 心跳间隔（毫秒） */
  heartbeatIntervalMs: number;
  /** 活跃会话同步间隔（毫秒） */
  activeSyncIntervalMs: number;
  /** 定位目标会话每步延迟（毫秒） */
  targetLocateStepDelayMs: number;
  /** 定位目标会话最大滚动次数 */
  targetLocateMaxScrolls: number;
  /** 定位目标会话最大持续时间（毫秒） */
  targetLocateMaxDurationMs: number;
  /** 打开目标会话超时（毫秒） */
  targetOpenTimeoutMs: number;

  // --- 通用配置 ---
  /** 控制台面板 DOM ID */
  panelId: string;
  /** localStorage 存储键名 */
  storageKey: string;
  /** 本地 WSS 端点 URL */
  apiWebSocketUrl: string;
  /** RPC 请求超时（毫秒） */
  apiRequestTimeoutMs: number;
  /** WSS 重连延迟（毫秒） */
  apiReconnectDelayMs: number;

  /** DOM 选择器配置 */
  selectors: SelectorConfig;
}

// ---------------------------------------------------------------------------
// 消息与商品
// ---------------------------------------------------------------------------

/** 单条聊天消息 */
export interface Message {
  /** 消息文本内容或图片描述 */
  content: string;
  /** 是否为当前账号发出的消息 */
  isMe: boolean;
  /** 消息类型，默认为 'text' */
  type?: 'text' | 'image';
  /** 页面原生消息 ID，用于引用回复 */
  messageId?: string | null;
  /** 当前消息引用的原始消息 ID */
  replyMessageId?: string | null;
}

/** 商品信息快照 */
export interface ProductInfo {
  /** 商品价格文本 */
  price: string;
  /** 发货地 */
  location: string;
  /** 商品详情页 URL */
  url: string;
  /** 商品 ID */
  id: string | null;
  /** 卖家用户 ID */
  userId: string | null;
}

// ---------------------------------------------------------------------------
// 会话信息（从 React fiber 提取的精简结构）
// ---------------------------------------------------------------------------

/** 卖家信息 */
export interface SellerInfo {
  userId: string;
}

/** 商品摘要信息 */
export interface ItemInfo {
  itemId: string;
  title: string;
  sellerInfo: SellerInfo | null;
}

/** 账号 owner 信息 */
export interface OwnerInfo {
  userId: string;
}

/** 对方用户信息 */
export interface UserInfo {
  userId: string;
  nick: string;
  fishNick: string;
}

/** 最新一条消息摘要 */
export interface LatestMessageSummary {
  messageId: string;
  sessionId: string;
}

/** 会话消息摘要 */
export interface SessionSummary {
  latestMessage: LatestMessageSummary | null;
}

/**
 * 归一化后的会话信息，从 React fiber 提取并精简，避免把整棵 React 树写入缓存。
 */
export interface SessionInfo {
  sessionId: string;
  sessionType: string | null;
  targetUrlSessionInfo: unknown | null;
  itemInfo: ItemInfo | null;
  ownerInfo: OwnerInfo | null;
  userInfo: UserInfo | null;
  summary: SessionSummary | null;
}

// ---------------------------------------------------------------------------
// 聊天记录（state.chats 中每个 key 对应的值）
// ---------------------------------------------------------------------------

/** 单个会话的完整聊天记录 */
export interface ChatRecord {
  /** 买家昵称 */
  customerName: string;
  /** 商品 ID（可能为 null） */
  productId: string | null;
  /** 买家用户 ID */
  buyerUserId: string | null;
  /** 会话 ID */
  sessionId: string | null;
  /** 归一化后的会话信息 */
  sessionInfo: SessionInfo | null;
  /** 商品快照 */
  product: ProductInfo;
  /** 消息列表 */
  messages: Message[];
}

// ---------------------------------------------------------------------------
// 应用状态
// ---------------------------------------------------------------------------

/** 全局应用状态（对应 state 对象） */
export interface AppState {
  /** 所有会话聊天记录，key 为 chatKey */
  chats: Record<string, ChatRecord>;
  /** 当前打开的会话 key */
  currentKey: string | null;
  /** 当前会话 ID */
  currentSessionId: string | null;
  /** 当前会话归一化信息 */
  currentSessionInfo: SessionInfo | null;
  /** 各会话的滚动位置缓存 */
  scrollPositions: Record<string, number>;
  /** 各会话的折叠状态 */
  collapsed: Record<string, boolean>;
  /** 上一次 localStorage 保存时间戳 */
  lastSaveTime: number;
  /** 用户意图是否开启抓取（由心跳服务端控制） */
  crawlingDesiredEnabled: boolean;
  /** 当前是否正在抓取中 */
  isCrawling: boolean;
  /** 当前暂停抓取的原因集合 */
  crawlSuspendReasons: Set<string>;
  /** 本轮已访问的会话 key 集合（去重用） */
  visitedThisCycle: Set<string>;
  /** 连续无新消息的轮次计数 */
  noNewItemsStreak: number;
  /** 本次启动共抓取的会话总数 */
  crawledTotal: number;
  /** 控制台面板状态文本 */
  statusText: string;
  /** 面板是否最小化 */
  isMinimized: boolean;
  /** 会话索引，key 为 sessionId */
  sessionIndex: Record<string, SessionIndexEntry>;
  /** 外发消息发送任务是否繁忙 */
  senderBusy: boolean;
  /** 活跃会话同步是否繁忙 */
  activeSyncBusy: boolean;
  /** 初始化流程是否繁忙 */
  initializationBusy: boolean;
  /** 初始化流程是否已完成 */
  initializationCompleted: boolean;
  /** 当前正在执行的初始抓取 nonce */
  activeInitialCrawlNonce: string | null;
  /** 上一次已处理的初始抓取 nonce */
  lastHandledInitialCrawlNonce: string | null;
  /** 未读消息监听是否繁忙 */
  unreadWatchBusy: boolean;
  /** 各会话最后一次处理未读消息的时间戳 */
  unreadHandledAt: Record<string, number>;
}

// ---------------------------------------------------------------------------
// 会话索引
// ---------------------------------------------------------------------------

/** 会话索引条目（存于 state.sessionIndex） */
export interface SessionIndexEntry {
  /** 归一化会话信息 */
  sessionInfo: SessionInfo;
  /** 会话标题（买家昵称） */
  title: string;
  /** 关联商品 ID */
  productId: string;
  /** 最近一次看到该会话的时间戳 */
  seenAt: number;
}

/** 左侧会话列表中的单个条目 */
export interface ConversationEntry {
  /** 会话 DOM 元素 */
  itemEl: HTMLElement;
  /** 会话 ID */
  sessionId: string;
  /** 归一化会话信息 */
  sessionInfo: SessionInfo;
  /** 显示标题 */
  title: string;
  /** 关联商品 ID */
  productId: string;
  /** 是否为当前激活会话 */
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// 外发消息
// ---------------------------------------------------------------------------

/** 待发送的外发消息（从服务端 claim 取回） */
export interface OutgoingMessage {
  /** 消息数据库 ID */
  id: number;
  /** 消息正文 */
  content: string;
  /** 消息类型 */
  message_type?: 'text' | 'image';
  /** 图片 base64 数据 */
  media_data?: string | null;
  /** 图片文件名 */
  media_name?: string | null;
  /** 引用回复目标的页面原生消息 ID */
  reply_to_external_message_id?: string | null;
  /** 目标会话 chat_key */
  chat_key?: string;
  /** 目标会话 session_id */
  session_id?: string;
  /** 买家昵称 */
  customer_name?: string;
  /** 商品 ID */
  product_id?: string;
}

// ---------------------------------------------------------------------------
// Browser API（WSS RPC）
// ---------------------------------------------------------------------------

/** 单个挂起的 RPC 请求 */
export interface PendingRequest {
  /** resolve 回调 */
  resolve: (v: unknown) => void;
  /** reject 回调 */
  reject: (r?: unknown) => void;
  /** 超时定时器 ID */
  timerId: number;
}

/** WSS 连接状态（对应 browserApiState 对象） */
export interface BrowserApiState {
  /** 当前 WebSocket 实例 */
  socket: WebSocket | null;
  /** 正在进行中的连接 Promise（防止重复连接） */
  connectPromise: Promise<WebSocket> | null;
  /** 重连定时器 ID */
  reconnectTimer: number | null;
  /** 自增请求 ID 计数器 */
  nextRequestId: number;
  /** 所有挂起的 RPC 请求，key 为 requestId 字符串 */
  pendingRequests: Map<string, PendingRequest>;
  /** 是否为主动关闭（主动关闭不触发重连） */
  manualClose: boolean;
}

/** 心跳 RPC 响应 payload */
export interface HeartbeatResponse {
  /** 服务端期望的抓取启用状态 */
  crawlerDesiredEnabled: boolean;
  /** 初始抓取指令 nonce（有值时触发初始化抓取） */
  initialCrawlNonce?: string;
  /** 初始抓取指定的会话数量上限 */
  initialCrawlSessionCount?: number;
}

/** RPC 请求消息结构 */
export interface RpcRequest {
  type: 'rpc-request';
  id: string;
  action: string;
  payload: Record<string, unknown>;
}

/** RPC 响应消息结构 */
export interface RpcResponse {
  type: 'rpc-response';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

/** claim 外发消息的响应 payload */
export interface OutgoingClaimResponse {
  message: OutgoingMessage | null;
}

/** patch 外发消息状态的请求 payload */
export interface OutgoingPatchPayload {
  id: number;
  status: 'sent' | 'failed';
  error?: string | null;
}

/** patch 应用设置的请求 payload */
export interface SettingsPatchPayload {
  crawlerDesiredEnabled?: boolean;
  autoReplyEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// 面板模式
// ---------------------------------------------------------------------------

/** 监控面板的显示模式 */
export type PanelMode = 'sidepanel' | 'embedded';
