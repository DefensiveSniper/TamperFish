'use strict';

const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const crypto = require('crypto');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');

let _db = null;

async function getDb() {
  if (_db) return _db;
  _db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await _db.exec('PRAGMA journal_mode = WAL');
  await _db.exec('PRAGMA foreign_keys = ON');
  await initSchema(_db);
  await migrateSchema(_db);
  return _db;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_key      TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      product_id    TEXT,
      product_json  TEXT NOT NULL DEFAULT '{}',
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- UNIQUE(chat_key, msg_hash) is the dedup key
    -- msg_hash = sha256(seq|content|isMe)[:16]
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_key    TEXT    NOT NULL REFERENCES sessions(chat_key),
      msg_hash    TEXT    NOT NULL,
      seq         INTEGER NOT NULL,
      content     TEXT    NOT NULL,
      is_me       INTEGER NOT NULL CHECK(is_me IN (0,1)),
      ingested_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(chat_key, msg_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages(chat_key, seq);

    -- Internal event log written by ingest (new_session / new_messages events).
    -- NOT for outgoing messages — use outgoing_messages table instead.
    CREATE TABLE IF NOT EXISTS outbox (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type   TEXT    NOT NULL,
      chat_key     TEXT    NOT NULL,
      payload      TEXT    NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      processed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_pending
      ON outbox(chat_key, created_at)
      WHERE processed_at IS NULL;

    -- Outgoing messages: messages queued to be sent by OpenClaw browser automation.
    -- status: pending → sent | failed
    -- 新增 customer_name, product_id 用于精确路由（避免同一买家多商品会话发错）
    CREATE TABLE IF NOT EXISTS outgoing_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_key     TEXT    NOT NULL REFERENCES sessions(chat_key),
      customer_name TEXT   NOT NULL,
      product_id   TEXT,
      content      TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending'
                         CHECK(status IN ('pending','sent','failed')),
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      sent_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_outgoing_pending
      ON outgoing_messages(chat_key, status)
      WHERE status = 'pending';
    -- 精确匹配索引
    CREATE INDEX IF NOT EXISTS idx_outgoing_route
      ON outgoing_messages(customer_name, product_id, status)
      WHERE status = 'pending';

    -- 应用运行时设置，供 UI 与 worker 共享。
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ── 千牛/发货预留表 (Reserved — not yet populated) ────────────────────────
    -- orders: synced from 千牛; linked to a session via chat_key
    CREATE TABLE IF NOT EXISTS orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id    TEXT UNIQUE,
      chat_key    TEXT REFERENCES sessions(chat_key),
      buyer_name  TEXT,
      product_id  TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      raw_json    TEXT NOT NULL DEFAULT '{}',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- shipments: one per order; tracking info from 千牛
    CREATE TABLE IF NOT EXISTS shipments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id    TEXT REFERENCES orders(order_id),
      tracking_no TEXT,
      carrier     TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      shipped_at  INTEGER,
      raw_json    TEXT NOT NULL DEFAULT '{}',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}

// ── Migration: add columns that may not exist yet ────────────────────────────

async function migrateSchema(db) {
  const additions = [
    `ALTER TABLE outgoing_messages ADD COLUMN error TEXT`,
    `ALTER TABLE outgoing_messages ADD COLUMN retries INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE outgoing_messages ADD COLUMN last_attempt_at INTEGER`,
    `ALTER TABLE outgoing_messages ADD COLUMN customer_name TEXT`,
    `ALTER TABLE outgoing_messages ADD COLUMN product_id TEXT`,
    `ALTER TABLE outgoing_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'ai'`,
  ];
  for (const sql of additions) {
    try { await db.run(sql); } catch (_) { /* column already exists */ }
  }
}

// ── Hash helper ──────────────────────────────────────────────────────────────

function msgHash(seq, content, isMe) {
  return crypto
    .createHash('sha256')
    .update(`${seq}|${content}|${isMe ? 1 : 0}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * 判断数据库中的消息序列与传入快照是否逐条一致。
 * @param {{content: string, is_me: number}[]} dbMessages - 数据库中的消息序列。
 * @param {{content: string, isMe: boolean}[]} incomingMessages - 本轮采集到的消息序列。
 * @returns {boolean} 是否是同一会话快照。
 */
function areMessageSnapshotsEquivalent(dbMessages = [], incomingMessages = []) {
  if (dbMessages.length !== incomingMessages.length) return false;
  for (let i = 0; i < dbMessages.length; i++) {
    if ((dbMessages[i]?.content || '') !== (incomingMessages[i]?.content || '')) return false;
    if (!!dbMessages[i]?.is_me !== !!incomingMessages[i]?.isMe) return false;
  }
  return true;
}

/**
 * 当采集结果缺少商品 ID 时，尝试把它映射到库里已有的完整会话键。
 * @param {import('sqlite').Database} db - SQLite 连接。
 * @param {string} chatKey - 当前采集到的会话键。
 * @param {string} customerName - 当前买家名。
 * @param {string|null} productId - 当前商品 ID。
 * @param {{content: string, isMe: boolean}[]} messages - 当前消息快照。
 * @returns {Promise<string>} 应该落库的规范会话键。
 */
async function resolveCanonicalSessionKey(db, chatKey, customerName, productId, messages = []) {
  if (productId || !messages.length || chatKey.includes('_')) {
    return chatKey;
  }

  const candidates = await db.all(
    `SELECT chat_key
     FROM sessions
     WHERE customer_name = ?
       AND product_id IS NOT NULL
       AND product_id != ''`,
    customerName
  );

  for (const candidate of candidates) {
    const dbMessages = await db.all(
      'SELECT content, is_me FROM messages WHERE chat_key = ? ORDER BY seq ASC',
      candidate.chat_key
    );
    if (areMessageSnapshotsEquivalent(dbMessages, messages)) {
      return candidate.chat_key;
    }
  }

  return chatKey;
}

/**
 * 将历史上的无 ID 副本会话合并到真实会话键，并清理旧键残留。
 * @param {import('sqlite').Database} db - SQLite 连接。
 * @param {string} sourceChatKey - 旧的副本会话键。
 * @param {string} targetChatKey - 真实会话键。
 * @param {string} customerName - 当前买家名。
 * @param {string|null} productId - 当前商品 ID。
 * @returns {Promise<void>}
 */
async function cleanupDuplicateSessionKey(db, sourceChatKey, targetChatKey, customerName, productId) {
  if (!sourceChatKey || sourceChatKey === targetChatKey) {
    return;
  }

  await db.run(
    `UPDATE outgoing_messages
     SET chat_key = ?,
         customer_name = COALESCE(customer_name, ?),
         product_id = COALESCE(product_id, ?)
     WHERE chat_key = ?`,
    targetChatKey,
    customerName,
    productId,
    sourceChatKey
  );
  await db.run(`DELETE FROM messages WHERE chat_key = ?`, sourceChatKey);
  await db.run(`DELETE FROM outbox WHERE chat_key = ?`, sourceChatKey);
  await db.run(`DELETE FROM sessions WHERE chat_key = ?`, sourceChatKey);
}

/**
 * 清理没有任何聊天内容、也没有待发消息的空壳会话。
 * @param {import('sqlite').Database} db - SQLite 连接。
 * @param {string} chatKey - 需要检查的会话键。
 * @returns {Promise<boolean>} 是否实际删除了空壳会话。
 */
async function cleanupEmptySessionShell(db, chatKey) {
  if (!chatKey) {
    return false;
  }

  const stats = await db.get(
    `SELECT
       EXISTS(SELECT 1 FROM sessions WHERE chat_key = ?) AS has_session,
       EXISTS(SELECT 1 FROM messages WHERE chat_key = ?) AS has_messages,
       EXISTS(SELECT 1 FROM outgoing_messages WHERE chat_key = ?) AS has_outgoing`,
    chatKey,
    chatKey,
    chatKey
  );

  if (!stats?.has_session || stats.has_messages || stats.has_outgoing) {
    return false;
  }

  await db.run(`DELETE FROM outbox WHERE chat_key = ?`, chatKey);
  await db.run(`DELETE FROM sessions WHERE chat_key = ?`, chatKey);
  return true;
}

// ── Ingest ───────────────────────────────────────────────────────────────────
// sessions = { [chatKey]: { customerName, productId, product, messages[] } }
// Fully idempotent — safe to POST the same snapshot repeatedly.

async function ingest(sessions) {
  const db = await getDb();
  const results = {};

  await db.exec('BEGIN');
  try {
    for (const [chatKey, session] of Object.entries(sessions)) {
      const { customerName, productId = null, product = {}, messages = [] } = session;
      const effectiveCustomerName = customerName || chatKey.split('_')[0];

      if (!messages.length) {
        const cleanedUpEmptyShell = await cleanupEmptySessionShell(db, chatKey);
        results[chatKey] = {
          isNewSession: false,
          newMsgCount: 0,
          totalMessages: 0,
          canonicalChatKey: chatKey,
          skipped: true,
          reason: 'empty_session',
          cleanedUpEmptyShell
        };
        continue;
      }

      const canonicalChatKey = await resolveCanonicalSessionKey(
        db,
        chatKey,
        effectiveCustomerName,
        productId,
        messages
      );
      const productJson = JSON.stringify(product);

      const existing = await db.get(
        'SELECT chat_key FROM sessions WHERE chat_key = ?', canonicalChatKey
      );

      // Upsert session; only overwrite product_json when new value is non-empty
      await db.run(`
        INSERT INTO sessions(chat_key, customer_name, product_id, product_json)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(chat_key) DO UPDATE SET
          customer_name = excluded.customer_name,
          product_id    = CASE
            WHEN excluded.product_id IS NOT NULL THEN excluded.product_id
            ELSE sessions.product_id
          END,
          product_json  = CASE
            WHEN excluded.product_json != '{}' THEN excluded.product_json
            ELSE sessions.product_json
          END,
          updated_at = unixepoch()
      `, canonicalChatKey, effectiveCustomerName, productId, productJson);

      await cleanupDuplicateSessionKey(
        db,
        chatKey,
        canonicalChatKey,
        effectiveCustomerName,
        productId
      );

      if (!existing) {
        await db.run(
          `INSERT INTO outbox(event_type, chat_key, payload)
           VALUES('new_session', ?, ?)`,
          canonicalChatKey,
          JSON.stringify({ chatKey: canonicalChatKey, customerName: effectiveCustomerName, productId, product })
        );
      }

      const dbMsgs = await db.all('SELECT content, is_me, seq FROM messages WHERE chat_key = ? ORDER BY seq ASC', canonicalChatKey);

      let newMsgCount = 0;
      const newMessages = [];
      let currentSeq = dbMsgs.length > 0 ? dbMsgs[dbMsgs.length - 1].seq + 1 : 0;

      if (messages && messages.length > 0) {
        // 1. Check if the entire incoming array is already a contiguous sub-array in DB
        let isSubstring = false;
        if (dbMsgs.length >= messages.length) {
          for (let start = 0; start <= dbMsgs.length - messages.length; start++) {
            let match = true;
            for (let j = 0; j < messages.length; j++) {
              if (dbMsgs[start + j].content !== messages[j].content ||
                dbMsgs[start + j].is_me !== (messages[j].isMe ? 1 : 0)) {
                match = false;
                break;
              }
            }
            if (match) {
              isSubstring = true;
              break;
            }
          }
        }

        if (!isSubstring) {
          // 2. Find the maximum overlap between a suffix of DB and a prefix of Incoming
          let overlapLen = 0;
          const maxOverlap = Math.min(dbMsgs.length, messages.length);

          for (let i = maxOverlap; i >= 0; i--) {
            let match = true;
            for (let j = 0; j < i; j++) {
              const dbMsg = dbMsgs[dbMsgs.length - i + j];
              const inMsg = messages[j];
              if (dbMsg.content !== inMsg.content || dbMsg.is_me !== (inMsg.isMe ? 1 : 0)) {
                match = false;
                break;
              }
            }
            if (match) {
              overlapLen = i;
              break;
            }
          }

          // 3. Append the remaining incoming messages
          const crypto = require('crypto');
          for (let i = overlapLen; i < messages.length; i++) {
            const { content, isMe } = messages[i];
            if (!content) continue;

            const hash = crypto.createHash('md5').update(`v3:${chatKey}:${isMe ? 1 : 0}:${content}:${currentSeq}`).digest('hex');

            const result = await db.run(
              `INSERT OR IGNORE INTO messages(chat_key, msg_hash, seq, content, is_me)
               VALUES(?, ?, ?, ?, ?)`,
              canonicalChatKey, hash, currentSeq, content, isMe ? 1 : 0
            );

            if (result.changes > 0) {
              newMsgCount++;
              newMessages.push({ seq: currentSeq, content, isMe });
              currentSeq++;
            }
          }
        }
      }

      if (newMsgCount > 0) {
        await db.run(
          `INSERT INTO outbox(event_type, chat_key, payload)
           VALUES('new_messages', ?, ?)`,
          canonicalChatKey,
          JSON.stringify({ chatKey: canonicalChatKey, newMessages })
        );
      }

      results[chatKey] = {
        isNewSession: !existing,
        newMsgCount,
        totalMessages: messages.length,
        canonicalChatKey
      };
    }
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }

  return results;
}

// ── Queries ──────────────────────────────────────────────────────────────────

async function listSessions() {
  const db = await getDb();
  return db.all(`
    SELECT
      s.chat_key, s.customer_name, s.product_id, s.product_json,
      s.created_at, s.updated_at,
      COUNT(m.id) AS message_count,
      (SELECT content FROM messages WHERE chat_key = s.chat_key ORDER BY seq DESC LIMIT 1) AS last_message,
      (SELECT is_me   FROM messages WHERE chat_key = s.chat_key ORDER BY seq DESC LIMIT 1) AS last_is_me,
      (
        SELECT MAX(t) FROM (
          SELECT * FROM (SELECT ingested_at as t FROM messages WHERE chat_key = s.chat_key ORDER BY seq DESC LIMIT 1)
          UNION ALL
          SELECT * FROM (SELECT created_at as t FROM outgoing_messages WHERE chat_key = s.chat_key ORDER BY id DESC LIMIT 1)
        )
      ) AS last_time
    FROM sessions s
    LEFT JOIN messages m ON m.chat_key = s.chat_key
    GROUP BY s.chat_key
    ORDER BY COALESCE(last_time, s.updated_at) DESC
  `);
}

async function getSession(chatKey) {
  const db = await getDb();
  return db.get('SELECT * FROM sessions WHERE chat_key = ?', chatKey);
}

async function getMessages(chatKey) {
  const db = await getDb();
  return db.all(
    'SELECT seq, content, is_me, ingested_at FROM messages WHERE chat_key = ? ORDER BY seq ASC',
    chatKey
  );
}

// ── Outgoing messages ─────────────────────────────────────────────────────────
// Messages queued to be sent by OpenClaw browser automation.

/**
 * 将待发送消息压入 outgoing_messages 队列，并补齐路由字段。
 * @param {string} chatKey - 会话唯一键。
 * @param {string} content - 待发送内容。
 * @param {string|null} customerName - 可选客户名，未传则从 session 回填。
 * @param {string|null} productId - 可选商品 ID，未传则从 session 回填。
 * @param {'ai'|'manual'} source - 消息来源，便于 UI 区分人工/AI。
 * @returns {Promise<{id: number}>} 新入队消息的主键。
 */
async function addOutgoingMessage(chatKey, content, customerName = null, productId = null, source = 'ai') {
  const db = await getDb();
  // 如果没传 customerName/productId，从 session 表查
  if (!customerName || !productId) {
    const session = await db.get('SELECT customer_name, product_id FROM sessions WHERE chat_key = ?', chatKey);
    if (session) {
      customerName = customerName || session.customer_name;
      productId = productId || session.product_id;
    }
  }
  const result = await db.run(
    `INSERT INTO outgoing_messages(chat_key, customer_name, product_id, content, source) VALUES(?, ?, ?, ?, ?)`,
    chatKey, customerName, productId, content, source
  );
  return { id: result.lastID };
}

async function listOutgoingMessages(chatKey, status) {
  const db = await getDb();
  if (chatKey && status) {
    return db.all(
      'SELECT * FROM outgoing_messages WHERE chat_key = ? AND status = ? ORDER BY id ASC',
      chatKey, status
    );
  }
  if (chatKey) {
    return db.all(
      'SELECT * FROM outgoing_messages WHERE chat_key = ? ORDER BY id DESC LIMIT 100',
      chatKey
    );
  }
  if (status) {
    return db.all(
      'SELECT * FROM outgoing_messages WHERE status = ? ORDER BY id ASC LIMIT 100',
      status
    );
  }
  return db.all(
    'SELECT * FROM outgoing_messages ORDER BY id DESC LIMIT 100'
  );
}

// Mark a message as sent or failed (called by OpenClaw after browser action)
async function updateOutgoingStatus(id, status, error = null) {
  const db = await getDb();
  await db.run(
    `UPDATE outgoing_messages
     SET status = ?,
         sent_at = CASE WHEN ? = 'sent' THEN unixepoch() ELSE sent_at END,
         error = ?,
         retries = retries + 1,
         last_attempt_at = unixepoch()
     WHERE id = ?`,
    status, status, error, id
  );
}


// ── Outbox events (for auto-reply worker) ─────────────────────────────────────

async function getUnprocessedOutbox(eventType = 'new_messages', limit = 20) {
  const db = await getDb();
  return db.all(
    `SELECT * FROM outbox
     WHERE event_type = ? AND processed_at IS NULL
     ORDER BY id ASC LIMIT ?`,
    eventType, limit
  );
}

async function markOutboxProcessed(id) {
  const db = await getDb();
  await db.run(
    `UPDATE outbox SET processed_at = unixepoch() WHERE id = ?`, id
  );
}

// Check last message direction for a chat_key (0=buyer, 1=seller)
async function getLastMessageDirection(chatKey) {
  const db = await getDb();
  const row = await db.get(
    `SELECT is_me FROM messages WHERE chat_key = ? ORDER BY seq DESC LIMIT 1`,
    chatKey
  );
  return row ? row.is_me : null;
}

// Check if there's already a pending outgoing message for this chat_key
async function hasPendingOutgoing(chatKey) {
  const db = await getDb();
  const row = await db.get(
    `SELECT COUNT(*) as cnt FROM outgoing_messages WHERE chat_key = ? AND status = 'pending'`,
    chatKey
  );
  return (row?.cnt || 0) > 0;
}

/**
 * 读取应用设置；如果未设置则返回默认值。
 * @param {string} key - 设置键名。
 * @param {string|null} fallbackValue - 缺省值。
 * @returns {Promise<string|null>} 当前值。
 */
async function getAppSetting(key, fallbackValue = null) {
  const db = await getDb();
  const row = await db.get('SELECT value FROM app_settings WHERE key = ?', key);
  return row ? row.value : fallbackValue;
}

/**
 * 写入应用设置，供 UI 与 worker 共享。
 * @param {string} key - 设置键名。
 * @param {string} value - 序列化后的设置值。
 * @returns {Promise<void>}
 */
async function setAppSetting(key, value) {
  const db = await getDb();
  await db.run(
    `INSERT INTO app_settings(key, value, updated_at)
     VALUES(?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = unixepoch()`,
    key,
    value
  );
}

/**
 * 初始化运行时设置，只在数据库缺省时写入默认值。
 * @param {{autoReplyEnabled: boolean}} defaults - 默认设置集合。
 * @returns {Promise<void>}
 */
async function ensureRuntimeSettings(defaults = {}) {
  const db = await getDb();
  const autoReplyValue = defaults.autoReplyEnabled ? '1' : '0';
  await db.run(
    `INSERT INTO app_settings(key, value, updated_at)
     VALUES('auto_reply_enabled', ?, unixepoch())
     ON CONFLICT(key) DO NOTHING`,
    autoReplyValue
  );
}

/**
 * 读取当前 AI 自动回复开关。
 * @returns {Promise<boolean>} 是否允许 AI 自动回复。
 */
async function isAutoReplyEnabled() {
  const value = await getAppSetting('auto_reply_enabled', '1');
  return value === '1';
}

/**
 * 更新当前 AI 自动回复开关。
 * @param {boolean} enabled - 新状态。
 * @returns {Promise<void>}
 */
async function setAutoReplyEnabled(enabled) {
  await setAppSetting('auto_reply_enabled', enabled ? '1' : '0');
}

module.exports = {
  ingest,
  listSessions,
  getSession,
  getMessages,
  addOutgoingMessage,
  listOutgoingMessages,
  updateOutgoingStatus,

  getUnprocessedOutbox,
  markOutboxProcessed,
  getLastMessageDirection,
  hasPendingOutgoing,
  ensureRuntimeSettings,
  isAutoReplyEnabled,
  setAutoReplyEnabled,

};
