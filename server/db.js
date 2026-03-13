'use strict';

const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const crypto = require('crypto');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const OUTGOING_CLAIM_STALE_SECONDS = 45;

let _db = null;
let _dbInitPromise = null;

async function getDb() {
  if (_db) return _db;
  if (_dbInitPromise) return _dbInitPromise;

  _dbInitPromise = (async () => {
    const openedDb = await open({ filename: DB_PATH, driver: sqlite3.Database });
    try {
      await openedDb.exec('PRAGMA journal_mode = WAL');
      await openedDb.exec('PRAGMA foreign_keys = ON');
      await initSchema(openedDb);
      await migrateSchema(openedDb);
      _db = openedDb;
      return openedDb;
    } catch (error) {
      try { await openedDb.close(); } catch (_) { /* ignore close failure */ }
      throw error;
    } finally {
      _dbInitPromise = null;
    }
  })();

  return _dbInitPromise;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_key      TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      product_id    TEXT,
      product_json  TEXT NOT NULL DEFAULT '{}',
      session_id    TEXT,
      session_info_json TEXT NOT NULL DEFAULT '{}',
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
    -- status: pending → sending → sent | failed
    -- 新增 customer_name, product_id 用于精确路由（避免同一买家多商品会话发错）
    CREATE TABLE IF NOT EXISTS outgoing_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_key     TEXT    NOT NULL REFERENCES sessions(chat_key),
      customer_name TEXT   NOT NULL,
      product_id   TEXT,
      session_id   TEXT,
      content      TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending'
                         CHECK(status IN ('pending','sending','sent','failed')),
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      sent_at      INTEGER,
      claimed_at   INTEGER,
      error        TEXT,
      retries      INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      source       TEXT    NOT NULL DEFAULT 'ai'
    );
    CREATE INDEX IF NOT EXISTS idx_outgoing_pending
      ON outgoing_messages(status, id)
      WHERE status IN ('pending','sending');
    -- 精确匹配索引
    CREATE INDEX IF NOT EXISTS idx_outgoing_route
      ON outgoing_messages(customer_name, product_id, status)
      WHERE status IN ('pending','sending');
    CREATE INDEX IF NOT EXISTS idx_outgoing_chat_status
      ON outgoing_messages(chat_key, status, id);

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
    `ALTER TABLE sessions ADD COLUMN session_id TEXT`,
    `ALTER TABLE sessions ADD COLUMN session_info_json TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE outgoing_messages ADD COLUMN error TEXT`,
    `ALTER TABLE outgoing_messages ADD COLUMN retries INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE outgoing_messages ADD COLUMN last_attempt_at INTEGER`,
    `ALTER TABLE outgoing_messages ADD COLUMN customer_name TEXT`,
    `ALTER TABLE outgoing_messages ADD COLUMN product_id TEXT`,
    `ALTER TABLE outgoing_messages ADD COLUMN session_id TEXT`,
    `ALTER TABLE outgoing_messages ADD COLUMN claimed_at INTEGER`,
    `ALTER TABLE outgoing_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'ai'`,
  ];
  for (const sql of additions) {
    try { await db.run(sql); } catch (_) { /* column already exists */ }
  }

  await db.run(
    `UPDATE sessions
     SET session_info_json = '{}'
     WHERE session_info_json IS NULL OR TRIM(session_info_json) = ''`
  );
  await normalizeDuplicateSessionIds(db);
  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_id_unique
      ON sessions(session_id)
      WHERE session_id IS NOT NULL AND session_id != '';
    CREATE INDEX IF NOT EXISTS idx_outgoing_chat_status
      ON outgoing_messages(chat_key, status, id);
  `);
  await migrateOutgoingMessagesSchema(db);
}

/**
 * 清理历史库里重复的 session_id，避免唯一索引在升级时直接失败。
 * 保留更像“真实会话”的那一条记录，其余重复行清空 session_id，等待后续采集重新补齐。
 * @param {import('sqlite').Database} db - SQLite 连接。
 * @returns {Promise<void>}
 */
async function normalizeDuplicateSessionIds(db) {
  const duplicateRows = await db.all(
    `SELECT session_id
     FROM sessions
     WHERE session_id IS NOT NULL
       AND TRIM(session_id) != ''
     GROUP BY session_id
     HAVING COUNT(*) > 1`
  );

  for (const duplicateRow of duplicateRows) {
    const sessionId = duplicateRow.session_id;
    const candidates = await db.all(
      `SELECT
         s.chat_key,
         s.product_id,
         s.updated_at,
         s.created_at,
         (
           SELECT COUNT(*)
           FROM messages m
           WHERE m.chat_key = s.chat_key
         ) AS message_count,
         (
           SELECT COUNT(*)
           FROM outgoing_messages om
           WHERE om.chat_key = s.chat_key
             AND om.status IN ('pending', 'sending')
         ) AS active_outgoing_count
       FROM sessions s
       WHERE s.session_id = ?
       ORDER BY
         CASE
           WHEN s.product_id IS NOT NULL AND TRIM(s.product_id) != '' THEN 0
           ELSE 1
         END,
         active_outgoing_count DESC,
         message_count DESC,
         s.updated_at DESC,
         s.created_at DESC,
         s.chat_key ASC`,
      sessionId
    );

    const [, ...duplicatesToClear] = candidates;
    if (!duplicatesToClear.length) {
      continue;
    }

    const placeholders = duplicatesToClear.map(() => '?').join(', ');
    await db.run(
      `UPDATE sessions
       SET session_id = NULL,
           session_info_json = '{}',
           updated_at = unixepoch()
       WHERE chat_key IN (${placeholders})`,
      ...duplicatesToClear.map(row => row.chat_key)
    );
  }
}

/**
 * 将旧版 outgoing_messages 表迁移到支持 sending 状态的新结构。
 * @param {import('sqlite').Database} db - SQLite 连接。
 * @returns {Promise<void>}
 */
async function migrateOutgoingMessagesSchema(db) {
  const table = await db.get(
    `SELECT sql
     FROM sqlite_master
     WHERE type = 'table' AND name = 'outgoing_messages'`
  );

  if (!table?.sql || table.sql.includes(`'sending'`)) {
    return;
  }

  await db.exec('SAVEPOINT outgoing_messages_schema_migration');
  try {
    await db.exec(`DROP TABLE IF EXISTS outgoing_messages_v2`);
    await db.exec(`
      CREATE TABLE outgoing_messages_v2 (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key        TEXT    NOT NULL REFERENCES sessions(chat_key),
        customer_name   TEXT    NOT NULL,
        product_id      TEXT,
        session_id      TEXT,
        content         TEXT    NOT NULL,
        status          TEXT    NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending','sending','sent','failed')),
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        sent_at         INTEGER,
        claimed_at      INTEGER,
        error           TEXT,
        retries         INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        source          TEXT    NOT NULL DEFAULT 'ai'
      )
    `);
    await db.exec(`
      INSERT INTO outgoing_messages_v2(
        id,
        chat_key,
        customer_name,
        product_id,
        session_id,
        content,
        status,
        created_at,
        sent_at,
        claimed_at,
        error,
        retries,
        last_attempt_at,
        source
      )
      SELECT
        legacy.id,
        legacy.chat_key,
        COALESCE(legacy.customer_name, s.customer_name, legacy.chat_key),
        COALESCE(legacy.product_id, s.product_id),
        s.session_id,
        legacy.content,
        CASE
          WHEN legacy.status IN ('pending','sent','failed') THEN legacy.status
          ELSE 'pending'
        END,
        legacy.created_at,
        legacy.sent_at,
        NULL,
        legacy.error,
        COALESCE(legacy.retries, 0),
        legacy.last_attempt_at,
        COALESCE(legacy.source, 'ai')
      FROM outgoing_messages legacy
      LEFT JOIN sessions s ON s.chat_key = legacy.chat_key
    `);
    await db.exec(`DROP TABLE outgoing_messages`);
    await db.exec(`ALTER TABLE outgoing_messages_v2 RENAME TO outgoing_messages`);
    await db.exec(`
      CREATE INDEX idx_outgoing_pending
        ON outgoing_messages(status, id)
        WHERE status IN ('pending','sending')
    `);
    await db.exec(`
      CREATE INDEX idx_outgoing_route
        ON outgoing_messages(customer_name, product_id, status)
        WHERE status IN ('pending','sending')
    `);
    await db.exec(`
      CREATE INDEX idx_outgoing_chat_status
        ON outgoing_messages(chat_key, status, id)
    `);

    await db.exec('RELEASE SAVEPOINT outgoing_messages_schema_migration');
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT outgoing_messages_schema_migration');
    await db.exec('RELEASE SAVEPOINT outgoing_messages_schema_migration');
    throw error;
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
async function resolveCanonicalSessionKey(db, chatKey, customerName, productId, messages = [], sessionId = null) {
  if (sessionId) {
    const existingBySessionId = await db.get(
      `SELECT chat_key
       FROM sessions
       WHERE session_id = ?`,
      sessionId
    );
    if (existingBySessionId?.chat_key) {
      return existingBySessionId.chat_key;
    }
  }

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
async function cleanupDuplicateSessionKey(db, sourceChatKey, targetChatKey, customerName, productId, sessionId) {
  if (!sourceChatKey || sourceChatKey === targetChatKey) {
    return;
  }

  await db.run(
    `UPDATE outgoing_messages
     SET chat_key = ?,
         customer_name = COALESCE(customer_name, ?),
         product_id = COALESCE(product_id, ?),
         session_id = COALESCE(session_id, ?)
     WHERE chat_key = ?`,
    targetChatKey,
    customerName,
    productId,
    sessionId,
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
      const {
        customerName,
        productId = null,
        product = {},
        messages = [],
        sessionId = null,
        sessionInfo = null,
      } = session;
      const effectiveCustomerName = customerName || chatKey.split('_')[0];
      const normalizedSessionId = sessionId ? String(sessionId) : null;
      const sessionInfoJson =
        sessionInfo && typeof sessionInfo === 'object'
          ? JSON.stringify(sessionInfo)
          : '{}';

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
        messages,
        normalizedSessionId
      );
      const productJson = JSON.stringify(product);

      const existing = await db.get(
        'SELECT chat_key FROM sessions WHERE chat_key = ?', canonicalChatKey
      );

      // Upsert session; only overwrite product_json when new value is non-empty
      await db.run(`
        INSERT INTO sessions(chat_key, customer_name, product_id, product_json, session_id, session_info_json)
        VALUES(?, ?, ?, ?, ?, ?)
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
          session_id    = CASE
            WHEN excluded.session_id IS NOT NULL AND excluded.session_id != '' THEN excluded.session_id
            ELSE sessions.session_id
          END,
          session_info_json = CASE
            WHEN excluded.session_info_json != '{}' THEN excluded.session_info_json
            ELSE sessions.session_info_json
          END,
          updated_at = unixepoch()
      `, canonicalChatKey, effectiveCustomerName, productId, productJson, normalizedSessionId, sessionInfoJson);

      await cleanupDuplicateSessionKey(
        db,
        chatKey,
        canonicalChatKey,
        effectiveCustomerName,
        productId,
        normalizedSessionId
      );

      if (!existing) {
        await db.run(
          `INSERT INTO outbox(event_type, chat_key, payload)
           VALUES('new_session', ?, ?)`,
          canonicalChatKey,
          JSON.stringify({
            chatKey: canonicalChatKey,
            customerName: effectiveCustomerName,
            productId,
            product,
            sessionId: normalizedSessionId,
          })
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
          JSON.stringify({
            chatKey: canonicalChatKey,
            sessionId: normalizedSessionId,
            newMessages,
          })
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
      s.session_id, s.session_info_json,
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

/**
 * 根据 session_id 查询会话，供精准发送入队和迁移兼容使用。
 * @param {string} sessionId - 会话 ID。
 * @returns {Promise<any | undefined>} 命中的会话记录。
 */
async function getSessionBySessionId(sessionId) {
  const db = await getDb();
  return db.get(
    `SELECT *
     FROM sessions
     WHERE session_id = ?`,
    sessionId
  );
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
 * @param {string|null} sessionId - 可选会话 ID，未传则从 session 回填。
 * @returns {Promise<{id: number}>} 新入队消息的主键。
 */
async function addOutgoingMessage(chatKey, content, customerName = null, productId = null, source = 'ai', sessionId = null) {
  const db = await getDb();
  // 如果没传 customerName/productId/sessionId，从 session 表查
  if (!customerName || !productId || !sessionId) {
    const session = await db.get(
      'SELECT customer_name, product_id, session_id FROM sessions WHERE chat_key = ?',
      chatKey
    );
    if (session) {
      customerName = customerName || session.customer_name;
      productId = productId || session.product_id;
      sessionId = sessionId || session.session_id || null;
    }
  }
  const result = await db.run(
    `INSERT INTO outgoing_messages(chat_key, customer_name, product_id, session_id, content, source)
     VALUES(?, ?, ?, ?, ?, ?)`,
    chatKey, customerName, productId, sessionId, content, source
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
         claimed_at = NULL,
         error = ?,
         retries = CASE WHEN ? = 'failed' THEN retries + 1 ELSE retries END,
         last_attempt_at = unixepoch()
     WHERE id = ?`,
    status, status, error, status, id
  );
}

/**
 * 原子领取一条待发消息，避免浏览器端全量扫描 pending 队列。
 * @returns {Promise<any | null>} 领取成功的待发消息；没有可处理任务时返回 null。
 */
async function claimOutgoingMessage() {
  const db = await getDb();
  const staleBefore = Math.floor(Date.now() / 1000) - OUTGOING_CLAIM_STALE_SECONDS;

  await db.exec('BEGIN IMMEDIATE');
  try {
    const row = await db.get(
      `SELECT
         om.*,
         s.session_id AS session_row_id,
         s.session_info_json AS session_row_info_json
       FROM outgoing_messages om
       LEFT JOIN sessions s ON s.chat_key = om.chat_key
       WHERE om.status = 'pending'
          OR (om.status = 'sending' AND COALESCE(om.claimed_at, 0) <= ?)
       ORDER BY
         CASE WHEN om.status = 'pending' THEN 0 ELSE 1 END,
         om.id ASC
       LIMIT 1`,
      staleBefore
    );

    if (!row) {
      await db.exec('COMMIT');
      return null;
    }

    const result = await db.run(
      `UPDATE outgoing_messages
       SET status = 'sending',
           claimed_at = unixepoch(),
           last_attempt_at = unixepoch(),
           session_id = COALESCE(session_id, ?)
       WHERE id = ?
         AND (
           status = 'pending'
           OR (status = 'sending' AND COALESCE(claimed_at, 0) <= ?)
         )`,
      row.session_id || row.session_row_id || null,
      row.id,
      staleBefore
    );

    if (!result.changes) {
      await db.exec('ROLLBACK');
      return null;
    }

    await db.exec('COMMIT');
    return {
      ...row,
      status: 'sending',
      claimed_at: Math.floor(Date.now() / 1000),
      session_id: row.session_id || row.session_row_id || null,
      session_info_json: row.session_row_info_json || '{}',
    };
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
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
    `SELECT COUNT(*) as cnt
     FROM outgoing_messages
     WHERE chat_key = ?
       AND status IN ('pending', 'sending')`,
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
  const crawlerDesiredValue = defaults.crawlerDesiredEnabled === false ? '0' : '1';
  await db.run(
    `INSERT INTO app_settings(key, value, updated_at)
     VALUES('auto_reply_enabled', ?, unixepoch())
     ON CONFLICT(key) DO NOTHING`,
    autoReplyValue
  );
  await db.run(
    `INSERT INTO app_settings(key, value, updated_at)
     VALUES('crawler_desired_enabled', ?, unixepoch())
     ON CONFLICT(key) DO NOTHING`,
    crawlerDesiredValue
  );
  await db.run(
    `INSERT INTO app_settings(key, value, updated_at)
     VALUES('crawler_reported_enabled', '', unixepoch())
     ON CONFLICT(key) DO NOTHING`
  );
  await db.run(
    `INSERT INTO app_settings(key, value, updated_at)
     VALUES('crawler_last_heartbeat_at', '0', unixepoch())
     ON CONFLICT(key) DO NOTHING`
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

/**
 * 读取当前期望的巡逻开关状态。
 * @returns {Promise<boolean>} 是否允许后台巡逻。
 */
async function isCrawlerDesiredEnabled() {
  const value = await getAppSetting('crawler_desired_enabled', '1');
  return value === '1';
}

/**
 * 更新当前期望的巡逻开关状态。
 * @param {boolean} enabled - 新状态。
 * @returns {Promise<void>}
 */
async function setCrawlerDesiredEnabled(enabled) {
  await setAppSetting('crawler_desired_enabled', enabled ? '1' : '0');
}

/**
 * 记录浏览器脚本上报的当前巡逻状态与心跳时间。
 * @param {{crawlerEnabled: boolean}} runtimeState - 浏览器脚本当前状态。
 * @returns {Promise<void>}
 */
async function updateCrawlerHeartbeat(runtimeState) {
  await setAppSetting('crawler_reported_enabled', runtimeState.crawlerEnabled ? '1' : '0');
  await setAppSetting('crawler_last_heartbeat_at', String(Math.floor(Date.now() / 1000)));
}

/**
 * 读取 UI 与浏览器脚本共享的运行时设置快照。
 * @returns {Promise<{
 *   autoReplyEnabled: boolean,
 *   crawlerDesiredEnabled: boolean,
 *   crawlerReportedEnabled: boolean | null,
 *   crawlerLastHeartbeatAt: number
 * }>} 当前设置快照。
 */
async function getRuntimeSettings() {
  const [autoReplyEnabled, crawlerDesiredEnabled, crawlerReportedValue, crawlerLastHeartbeatValue] =
    await Promise.all([
      isAutoReplyEnabled(),
      isCrawlerDesiredEnabled(),
      getAppSetting('crawler_reported_enabled', ''),
      getAppSetting('crawler_last_heartbeat_at', '0'),
    ]);

  return {
    autoReplyEnabled,
    crawlerDesiredEnabled,
    crawlerReportedEnabled:
      crawlerReportedValue === ''
        ? null
        : crawlerReportedValue === '1',
    crawlerLastHeartbeatAt: Number(crawlerLastHeartbeatValue || 0),
  };
}

module.exports = {
  ingest,
  listSessions,
  getSession,
  getSessionBySessionId,
  getMessages,
  addOutgoingMessage,
  listOutgoingMessages,
  updateOutgoingStatus,
  claimOutgoingMessage,

  getUnprocessedOutbox,
  markOutboxProcessed,
  getLastMessageDirection,
  hasPendingOutgoing,
  ensureRuntimeSettings,
  getRuntimeSettings,
  isAutoReplyEnabled,
  setAutoReplyEnabled,
  isCrawlerDesiredEnabled,
  setCrawlerDesiredEnabled,
  updateCrawlerHeartbeat,

};
