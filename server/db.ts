// @ts-nocheck
'use strict';

const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const crypto = require('crypto');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const OUTGOING_CLAIM_STALE_SECONDS = 45;

let _db = null;
let _dbInitPromise = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeMessageContentForMatching(content, type = 'text') {
  const normalizedContent = typeof content === 'string' ? content.trim() : '';
  if (type !== 'image' || !normalizedContent) {
    return normalizedContent;
  }

  const cachedUrlMatch = normalizedContent.match(/\/media-cache\/([a-f0-9]{24})(?:\.[a-z0-9]+)?(?:[?#].*)?$/i);
  if (cachedUrlMatch) {
    return `image:${cachedUrlMatch[1].toLowerCase()}`;
  }

  if (/^https?:\/\/img\.alicdn\.com\//i.test(normalizedContent)) {
    return `image:${crypto.createHash('sha256').update(normalizedContent).digest('hex').slice(0, 24)}`;
  }

  return normalizedContent;
}

function areMessagesEquivalent(dbMessage, incomingMessage) {
  const dbType = dbMessage?.type || 'text';
  const incomingType = incomingMessage?.type || 'text';
  if (dbType !== incomingType) {
    return false;
  }

  if (dbMessage?.is_me !== (incomingMessage?.isMe ? 1 : 0)) {
    return false;
  }

  return normalizeMessageContentForMatching(dbMessage?.content, dbType)
    === normalizeMessageContentForMatching(incomingMessage?.content, incomingType);
}

// ── DB init ─────────────────────────────────────────────────────────────────

async function getDb() {
  if (_db) return _db;
  if (_dbInitPromise) return _dbInitPromise;

  _dbInitPromise = (async () => {
    const openedDb = await open({ filename: DB_PATH, driver: sqlite3.Database });
    try {
      await openedDb.exec('PRAGMA journal_mode = WAL');
      await openedDb.exec('PRAGMA foreign_keys = ON');
      await runMigration(openedDb);
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

// ── Schema v2: multi-account / multi-client ─────────────────────────────────

const SCHEMA_V2_DDL = `
  -- Registered client instances (one per browser/machine combo)
  CREATE TABLE IF NOT EXISTS clients (
    client_id       TEXT PRIMARY KEY,
    account_id      TEXT NOT NULL,
    client_name     TEXT NOT NULL DEFAULT '',
    client_secret_hash TEXT NOT NULL DEFAULT '',
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    last_seen_at    INTEGER,
    status          TEXT NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active','disabled')),
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_clients_account ON clients(account_id);

  -- Per-account settings (auto_reply_enabled, etc.)
  CREATE TABLE IF NOT EXISTS account_settings (
    account_id      TEXT NOT NULL,
    key             TEXT NOT NULL,
    value           TEXT NOT NULL,
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (account_id, key)
  );

  -- Per-client runtime state (heartbeat, crawler, qianniu state)
  CREATE TABLE IF NOT EXISTS client_runtime (
    client_id       TEXT NOT NULL REFERENCES clients(client_id),
    key             TEXT NOT NULL,
    value           TEXT NOT NULL,
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (client_id, key)
  );

  -- Per-client commands (initial_crawl, orders_sync_now, orders_full_scan)
  CREATE TABLE IF NOT EXISTS client_commands (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id       TEXT NOT NULL REFERENCES clients(client_id),
    command_type    TEXT NOT NULL,
    requested_nonce TEXT NOT NULL,
    handled_nonce   TEXT,
    payload_json    TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    handled_at      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_client_commands_pending
    ON client_commands(client_id, command_type)
    WHERE handled_nonce IS NULL;

  -- Chat sessions: scoped to account_id
  CREATE TABLE IF NOT EXISTS sessions (
    chat_key        TEXT NOT NULL,
    account_id      TEXT NOT NULL,
    customer_name   TEXT NOT NULL,
    product_id      TEXT,
    product_json    TEXT NOT NULL DEFAULT '{}',
    session_id      TEXT,
    session_info_json TEXT NOT NULL DEFAULT '{}',
    buyer_user_id   TEXT,
    last_seen_client_id TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (account_id, chat_key)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_id_unique
    ON sessions(account_id, session_id)
    WHERE session_id IS NOT NULL AND session_id != '';
  CREATE INDEX IF NOT EXISTS idx_sessions_buyer_product
    ON sessions(account_id, buyer_user_id, product_id)
    WHERE buyer_user_id IS NOT NULL
      AND TRIM(buyer_user_id) != ''
      AND product_id IS NOT NULL
      AND TRIM(product_id) != '';

  -- Chat messages: scoped to account_id
  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT NOT NULL,
    chat_key        TEXT NOT NULL,
    msg_hash        TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    content         TEXT NOT NULL,
    is_me           INTEGER NOT NULL CHECK(is_me IN (0,1)),
    type            TEXT NOT NULL DEFAULT 'text',
    external_message_id TEXT,
    reply_to_message_id TEXT,
    ingested_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(account_id, chat_key, msg_hash),
    FOREIGN KEY (account_id, chat_key) REFERENCES sessions(account_id, chat_key)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat_seq
    ON messages(account_id, chat_key, seq);

  -- Internal event log for auto-reply worker
  CREATE TABLE IF NOT EXISTS outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    chat_key        TEXT NOT NULL,
    payload         TEXT NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    processed_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_pending
    ON outbox(account_id, chat_key, created_at)
    WHERE processed_at IS NULL;

  -- Outgoing messages queue
  CREATE TABLE IF NOT EXISTS outgoing_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT NOT NULL,
    chat_key        TEXT NOT NULL,
    customer_name   TEXT NOT NULL,
    product_id      TEXT,
    session_id      TEXT,
    content         TEXT NOT NULL,
    message_type    TEXT NOT NULL DEFAULT 'text',
    media_data      TEXT,
    media_name      TEXT,
    reply_to_external_message_id TEXT,
    reply_to_preview TEXT,
    reply_to_type   TEXT,
    target_client_id TEXT,
    claimed_by_client_id TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','sending','sent','failed')),
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    sent_at         INTEGER,
    claimed_at      INTEGER,
    error           TEXT,
    retries         INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,
    source          TEXT NOT NULL DEFAULT 'ai',
    FOREIGN KEY (account_id, chat_key) REFERENCES sessions(account_id, chat_key)
  );
  CREATE INDEX IF NOT EXISTS idx_outgoing_pending
    ON outgoing_messages(status, id)
    WHERE status IN ('pending','sending');
  CREATE INDEX IF NOT EXISTS idx_outgoing_route
    ON outgoing_messages(account_id, customer_name, product_id, status)
    WHERE status IN ('pending','sending');
  CREATE INDEX IF NOT EXISTS idx_outgoing_chat_status
    ON outgoing_messages(account_id, chat_key, status, id);
  CREATE INDEX IF NOT EXISTS idx_outgoing_target_client
    ON outgoing_messages(target_client_id, status, id)
    WHERE status IN ('pending','sending');

  -- Orders: scoped to account_id
  CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT NOT NULL,
    order_id        TEXT NOT NULL,
    chat_key        TEXT,
    buyer_name      TEXT,
    buyer_user_id   TEXT,
    product_id      TEXT,
    product_title   TEXT,
    product_price   TEXT,
    purchase_quantity INTEGER,
    receiver_name   TEXT,
    receiver_phone  TEXT,
    receiver_address TEXT,
    order_status_text TEXT,
    paid_at         INTEGER,
    latest_ship_at  INTEGER,
    last_seen_at    INTEGER,
    status          TEXT NOT NULL DEFAULT 'pending',
    raw_json        TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(account_id, order_id)
  );
  CREATE INDEX IF NOT EXISTS idx_orders_recent
    ON orders(account_id, last_seen_at DESC, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_chat_key
    ON orders(account_id, chat_key, last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_buyer_product
    ON orders(account_id, buyer_user_id, product_id);

  -- Shipments (unchanged, just add account_id constraint)
  CREATE TABLE IF NOT EXISTS shipments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT NOT NULL,
    order_id        TEXT NOT NULL,
    tracking_no     TEXT,
    carrier         TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    shipped_at      INTEGER,
    raw_json        TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- Legacy app_settings table kept for schema version tracking
  CREATE TABLE IF NOT EXISTS app_settings (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

// ── Migration ────────────────────────────────────────────────────────────────

const SCHEMA_VERSION_KEY = 'schema_version';
const CURRENT_SCHEMA_VERSION = '2';
const DEFAULT_ACCOUNT_ID = 'default';
const LEGACY_CLIENT_ID = 'legacy-client-1';

async function runMigration(db) {
  // Check if app_settings exists (old schema)
  const hasAppSettings = await db.get(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'`
  );

  if (!hasAppSettings) {
    // Fresh install — create v2 schema directly
    await db.exec(SCHEMA_V2_DDL);
    await db.run(
      `INSERT INTO app_settings(key, value, updated_at) VALUES(?, ?, unixepoch())`,
      SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION
    );
    return;
  }

  // Check current schema version
  const versionRow = await db.get(
    `SELECT value FROM app_settings WHERE key = ?`,
    SCHEMA_VERSION_KEY
  );
  const currentVersion = versionRow?.value || '1';

  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return; // Already up to date
  }

  // v1 → v2: full table rebuild migration
  console.log('[migration] Upgrading schema from v1 to v2 (multi-account/multi-client)...');
  await migrateV1ToV2(db);
  console.log('[migration] Schema upgrade complete.');
}

async function migrateV1ToV2(db) {
  await db.exec('BEGIN');
  try {
    // ── 1. Create new tables ──
    await db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        client_id       TEXT PRIMARY KEY,
        account_id      TEXT NOT NULL,
        client_name     TEXT NOT NULL DEFAULT '',
        client_secret_hash TEXT NOT NULL DEFAULT '',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        last_seen_at    INTEGER,
        status          TEXT NOT NULL DEFAULT 'active'
                          CHECK(status IN ('active','disabled')),
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS account_settings (
        account_id      TEXT NOT NULL,
        key             TEXT NOT NULL,
        value           TEXT NOT NULL,
        updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, key)
      );

      CREATE TABLE IF NOT EXISTS client_runtime (
        client_id       TEXT NOT NULL,
        key             TEXT NOT NULL,
        value           TEXT NOT NULL,
        updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (client_id, key)
      );

      CREATE TABLE IF NOT EXISTS client_commands (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id       TEXT NOT NULL,
        command_type    TEXT NOT NULL,
        requested_nonce TEXT NOT NULL,
        handled_nonce   TEXT,
        payload_json    TEXT NOT NULL DEFAULT '{}',
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        handled_at      INTEGER
      );
    `);

    // ── 2. Create default account + legacy client ──
    await db.run(
      `INSERT OR IGNORE INTO clients(client_id, account_id, client_name, capabilities_json, status)
       VALUES(?, ?, 'Legacy Client', '["crawler","qianniu"]', 'active')`,
      LEGACY_CLIENT_ID, DEFAULT_ACCOUNT_ID
    );

    // ── 3. Migrate app_settings → account_settings + client_runtime ──
    const accountSettingKeys = ['auto_reply_enabled'];
    const clientRuntimeKeys = [
      'crawler_desired_enabled', 'crawler_reported_enabled',
      'crawler_last_heartbeat_at', 'initial_crawl_session_count',
      'qianniu_page_url', 'qianniu_visible_order_count',
      'qianniu_scan_state', 'qianniu_last_heartbeat_at',
      'qianniu_last_sync_at', 'qianniu_last_sync_stats',
    ];
    const clientCommandNonces = [
      { type: 'initial_crawl', requestedKey: 'initial_crawl_requested_nonce', handledKey: 'initial_crawl_handled_nonce' },
      { type: 'orders_sync_now', requestedKey: 'qianniu_sync_now_requested_nonce', handledKey: 'qianniu_sync_now_handled_nonce' },
      { type: 'orders_full_scan', requestedKey: 'qianniu_full_scan_requested_nonce', handledKey: 'qianniu_full_scan_handled_nonce' },
    ];

    for (const key of accountSettingKeys) {
      const row = await db.get(`SELECT value FROM app_settings WHERE key = ?`, key);
      if (row) {
        await db.run(
          `INSERT OR REPLACE INTO account_settings(account_id, key, value, updated_at) VALUES(?, ?, ?, unixepoch())`,
          DEFAULT_ACCOUNT_ID, key, row.value
        );
      }
    }

    for (const key of clientRuntimeKeys) {
      const row = await db.get(`SELECT value FROM app_settings WHERE key = ?`, key);
      if (row) {
        await db.run(
          `INSERT OR REPLACE INTO client_runtime(client_id, key, value, updated_at) VALUES(?, ?, ?, unixepoch())`,
          LEGACY_CLIENT_ID, key, row.value
        );
      }
    }

    for (const { type, requestedKey, handledKey } of clientCommandNonces) {
      const requested = await db.get(`SELECT value FROM app_settings WHERE key = ?`, requestedKey);
      const handled = await db.get(`SELECT value FROM app_settings WHERE key = ?`, handledKey);
      if (requested?.value) {
        await db.run(
          `INSERT INTO client_commands(client_id, command_type, requested_nonce, handled_nonce, created_at, handled_at)
           VALUES(?, ?, ?, ?, unixepoch(), CASE WHEN ? IS NOT NULL AND ? != '' THEN unixepoch() ELSE NULL END)`,
          LEGACY_CLIENT_ID, type, requested.value,
          (handled?.value || null),
          handled?.value, handled?.value
        );
      }
    }

    // ── 4. Rebuild sessions table ──
    // First, add migrations for old schema columns that might be missing
    const sessionAdditions = [
      `ALTER TABLE sessions ADD COLUMN session_id TEXT`,
      `ALTER TABLE sessions ADD COLUMN session_info_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE sessions ADD COLUMN buyer_user_id TEXT`,
    ];
    for (const sql of sessionAdditions) {
      try { await db.run(sql); } catch (_) { /* column exists */ }
    }

    await db.exec(`
      CREATE TABLE sessions_v2 (
        chat_key        TEXT NOT NULL,
        account_id      TEXT NOT NULL,
        customer_name   TEXT NOT NULL,
        product_id      TEXT,
        product_json    TEXT NOT NULL DEFAULT '{}',
        session_id      TEXT,
        session_info_json TEXT NOT NULL DEFAULT '{}',
        buyer_user_id   TEXT,
        last_seen_client_id TEXT,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, chat_key)
      );

      INSERT INTO sessions_v2(
        chat_key, account_id, customer_name, product_id, product_json,
        session_id, session_info_json, buyer_user_id, last_seen_client_id,
        created_at, updated_at
      )
      SELECT
        chat_key, '${DEFAULT_ACCOUNT_ID}', customer_name, product_id,
        COALESCE(product_json, '{}'),
        session_id,
        COALESCE(session_info_json, '{}'),
        buyer_user_id,
        '${LEGACY_CLIENT_ID}',
        created_at, updated_at
      FROM sessions;
    `);

    // ── 5. Rebuild messages table ──
    const messageAdditions = [
      `ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'`,
      `ALTER TABLE messages ADD COLUMN external_message_id TEXT`,
      `ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`,
    ];
    for (const sql of messageAdditions) {
      try { await db.run(sql); } catch (_) { /* column exists */ }
    }

    await db.exec(`
      CREATE TABLE messages_v2 (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id      TEXT NOT NULL,
        chat_key        TEXT NOT NULL,
        msg_hash        TEXT NOT NULL,
        seq             INTEGER NOT NULL,
        content         TEXT NOT NULL,
        is_me           INTEGER NOT NULL CHECK(is_me IN (0,1)),
        type            TEXT NOT NULL DEFAULT 'text',
        external_message_id TEXT,
        reply_to_message_id TEXT,
        ingested_at     INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(account_id, chat_key, msg_hash)
      );

      INSERT INTO messages_v2(
        id, account_id, chat_key, msg_hash, seq, content, is_me, type,
        external_message_id, reply_to_message_id, ingested_at
      )
      SELECT
        id, '${DEFAULT_ACCOUNT_ID}', chat_key, msg_hash, seq, content, is_me,
        COALESCE(type, 'text'),
        external_message_id, reply_to_message_id, ingested_at
      FROM messages;
    `);

    // ── 6. Rebuild outbox table ──
    await db.exec(`
      CREATE TABLE outbox_v2 (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id      TEXT NOT NULL,
        event_type      TEXT NOT NULL,
        chat_key        TEXT NOT NULL,
        payload         TEXT NOT NULL,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        processed_at    INTEGER
      );

      INSERT INTO outbox_v2(id, account_id, event_type, chat_key, payload, created_at, processed_at)
      SELECT id, '${DEFAULT_ACCOUNT_ID}', event_type, chat_key, payload, created_at, processed_at
      FROM outbox;
    `);

    // ── 7. Rebuild outgoing_messages table ──
    // Ensure old columns exist before migration
    const outgoingAdditions = [
      `ALTER TABLE outgoing_messages ADD COLUMN error TEXT`,
      `ALTER TABLE outgoing_messages ADD COLUMN retries INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE outgoing_messages ADD COLUMN last_attempt_at INTEGER`,
      `ALTER TABLE outgoing_messages ADD COLUMN customer_name TEXT`,
      `ALTER TABLE outgoing_messages ADD COLUMN product_id TEXT`,
      `ALTER TABLE outgoing_messages ADD COLUMN session_id TEXT`,
      `ALTER TABLE outgoing_messages ADD COLUMN claimed_at INTEGER`,
      `ALTER TABLE outgoing_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'ai'`,
      `ALTER TABLE outgoing_messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text'`,
      `ALTER TABLE outgoing_messages ADD COLUMN media_data TEXT`,
      `ALTER TABLE outgoing_messages ADD COLUMN media_name TEXT`,
      `ALTER TABLE outgoing_messages ADD COLUMN reply_to_external_message_id TEXT`,
      `ALTER TABLE outgoing_messages ADD COLUMN reply_to_preview TEXT`,
      `ALTER TABLE outgoing_messages ADD COLUMN reply_to_type TEXT`,
    ];
    for (const sql of outgoingAdditions) {
      try { await db.run(sql); } catch (_) { /* column exists */ }
    }

    await db.exec(`
      CREATE TABLE outgoing_messages_v2 (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id      TEXT NOT NULL,
        chat_key        TEXT NOT NULL,
        customer_name   TEXT NOT NULL,
        product_id      TEXT,
        session_id      TEXT,
        content         TEXT NOT NULL,
        message_type    TEXT NOT NULL DEFAULT 'text',
        media_data      TEXT,
        media_name      TEXT,
        reply_to_external_message_id TEXT,
        reply_to_preview TEXT,
        reply_to_type   TEXT,
        target_client_id TEXT,
        claimed_by_client_id TEXT,
        status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','sending','sent','failed')),
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        sent_at         INTEGER,
        claimed_at      INTEGER,
        error           TEXT,
        retries         INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        source          TEXT NOT NULL DEFAULT 'ai'
      );

      INSERT INTO outgoing_messages_v2(
        id, account_id, chat_key, customer_name, product_id, session_id,
        content, message_type, media_data, media_name,
        reply_to_external_message_id, reply_to_preview, reply_to_type,
        target_client_id, claimed_by_client_id,
        status, created_at, sent_at, claimed_at, error, retries, last_attempt_at, source
      )
      SELECT
        om.id,
        '${DEFAULT_ACCOUNT_ID}',
        om.chat_key,
        COALESCE(om.customer_name, s.customer_name, om.chat_key),
        COALESCE(om.product_id, s.product_id),
        COALESCE(om.session_id, s.session_id),
        om.content,
        COALESCE(om.message_type, 'text'),
        om.media_data,
        om.media_name,
        om.reply_to_external_message_id,
        om.reply_to_preview,
        om.reply_to_type,
        '${LEGACY_CLIENT_ID}',
        CASE WHEN om.status = 'sending' THEN '${LEGACY_CLIENT_ID}' ELSE NULL END,
        CASE
          WHEN om.status IN ('pending','sending','sent','failed') THEN om.status
          ELSE 'pending'
        END,
        om.created_at,
        om.sent_at,
        om.claimed_at,
        om.error,
        COALESCE(om.retries, 0),
        om.last_attempt_at,
        COALESCE(om.source, 'ai')
      FROM outgoing_messages om
      LEFT JOIN sessions s ON s.chat_key = om.chat_key;
    `);

    // ── 8. Rebuild orders table ──
    const orderAdditions = [
      `ALTER TABLE orders ADD COLUMN buyer_user_id TEXT`,
      `ALTER TABLE orders ADD COLUMN product_title TEXT`,
      `ALTER TABLE orders ADD COLUMN product_price TEXT`,
      `ALTER TABLE orders ADD COLUMN purchase_quantity INTEGER`,
      `ALTER TABLE orders ADD COLUMN receiver_name TEXT`,
      `ALTER TABLE orders ADD COLUMN receiver_phone TEXT`,
      `ALTER TABLE orders ADD COLUMN receiver_address TEXT`,
      `ALTER TABLE orders ADD COLUMN order_status_text TEXT`,
      `ALTER TABLE orders ADD COLUMN paid_at INTEGER`,
      `ALTER TABLE orders ADD COLUMN latest_ship_at INTEGER`,
      `ALTER TABLE orders ADD COLUMN last_seen_at INTEGER`,
    ];
    for (const sql of orderAdditions) {
      try { await db.run(sql); } catch (_) { /* column exists */ }
    }

    await db.exec(`
      CREATE TABLE orders_v2 (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id      TEXT NOT NULL,
        order_id        TEXT NOT NULL,
        chat_key        TEXT,
        buyer_name      TEXT,
        buyer_user_id   TEXT,
        product_id      TEXT,
        product_title   TEXT,
        product_price   TEXT,
        purchase_quantity INTEGER,
        receiver_name   TEXT,
        receiver_phone  TEXT,
        receiver_address TEXT,
        order_status_text TEXT,
        paid_at         INTEGER,
        latest_ship_at  INTEGER,
        last_seen_at    INTEGER,
        status          TEXT NOT NULL DEFAULT 'pending',
        raw_json        TEXT NOT NULL DEFAULT '{}',
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(account_id, order_id)
      );

      INSERT INTO orders_v2(
        id, account_id, order_id, chat_key,
        buyer_name, buyer_user_id, product_id, product_title, product_price,
        purchase_quantity, receiver_name, receiver_phone, receiver_address,
        order_status_text, paid_at, latest_ship_at, last_seen_at,
        status, raw_json, created_at, updated_at
      )
      SELECT
        id, '${DEFAULT_ACCOUNT_ID}', order_id, chat_key,
        buyer_name, buyer_user_id, product_id, product_title, product_price,
        purchase_quantity, receiver_name, receiver_phone, receiver_address,
        order_status_text, paid_at, latest_ship_at, last_seen_at,
        status, COALESCE(raw_json, '{}'), created_at, updated_at
      FROM orders;
    `);

    // ── 9. Rebuild shipments table ──
    await db.exec(`
      CREATE TABLE shipments_v2 (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id      TEXT NOT NULL,
        order_id        TEXT NOT NULL,
        tracking_no     TEXT,
        carrier         TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        shipped_at      INTEGER,
        raw_json        TEXT NOT NULL DEFAULT '{}',
        created_at      INTEGER NOT NULL DEFAULT (unixepoch())
      );

      INSERT INTO shipments_v2(id, account_id, order_id, tracking_no, carrier, status, shipped_at, raw_json, created_at)
      SELECT id, '${DEFAULT_ACCOUNT_ID}', order_id, tracking_no, carrier, status, shipped_at, COALESCE(raw_json, '{}'), created_at
      FROM shipments;
    `);

    // ── 10. Swap tables ──
    await db.exec(`
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS outgoing_messages;
      DROP TABLE IF EXISTS outbox;
      DROP TABLE IF EXISTS orders;
      DROP TABLE IF EXISTS shipments;
      DROP TABLE IF EXISTS sessions;

      ALTER TABLE sessions_v2 RENAME TO sessions;
      ALTER TABLE messages_v2 RENAME TO messages;
      ALTER TABLE outbox_v2 RENAME TO outbox;
      ALTER TABLE outgoing_messages_v2 RENAME TO outgoing_messages;
      ALTER TABLE orders_v2 RENAME TO orders;
      ALTER TABLE shipments_v2 RENAME TO shipments;
    `);

    // ── 11. Recreate indexes on renamed tables ──
    await db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_id_unique
        ON sessions(account_id, session_id)
        WHERE session_id IS NOT NULL AND session_id != '';
      CREATE INDEX IF NOT EXISTS idx_sessions_buyer_product
        ON sessions(account_id, buyer_user_id, product_id)
        WHERE buyer_user_id IS NOT NULL
          AND TRIM(buyer_user_id) != ''
          AND product_id IS NOT NULL
          AND TRIM(product_id) != '';
      CREATE INDEX IF NOT EXISTS idx_clients_account ON clients(account_id);

      CREATE INDEX IF NOT EXISTS idx_messages_chat_seq
        ON messages(account_id, chat_key, seq);

      CREATE INDEX IF NOT EXISTS idx_outbox_pending
        ON outbox(account_id, chat_key, created_at)
        WHERE processed_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_outgoing_pending
        ON outgoing_messages(status, id)
        WHERE status IN ('pending','sending');
      CREATE INDEX IF NOT EXISTS idx_outgoing_route
        ON outgoing_messages(account_id, customer_name, product_id, status)
        WHERE status IN ('pending','sending');
      CREATE INDEX IF NOT EXISTS idx_outgoing_chat_status
        ON outgoing_messages(account_id, chat_key, status, id);
      CREATE INDEX IF NOT EXISTS idx_outgoing_target_client
        ON outgoing_messages(target_client_id, status, id)
        WHERE status IN ('pending','sending');

      CREATE INDEX IF NOT EXISTS idx_orders_recent
        ON orders(account_id, last_seen_at DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orders_chat_key
        ON orders(account_id, chat_key, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orders_buyer_product
        ON orders(account_id, buyer_user_id, product_id);

      CREATE INDEX IF NOT EXISTS idx_client_commands_pending
        ON client_commands(client_id, command_type)
        WHERE handled_nonce IS NULL;
    `);

    // ── 12. Update schema version ──
    await db.run(
      `INSERT INTO app_settings(key, value, updated_at) VALUES(?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
      SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION
    );

    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}

// ── Utility helpers ──────────────────────────────────────────────────────────

function normalizeOptionalText(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function msgHash(seq, content, isMe) {
  return crypto
    .createHash('sha256')
    .update(`${seq}|${content}|${isMe ? 1 : 0}`)
    .digest('hex')
    .slice(0, 16);
}

function areMessageSnapshotsEquivalent(dbMessages = [], incomingMessages = []) {
  if (dbMessages.length !== incomingMessages.length) return false;
  for (let i = 0; i < dbMessages.length; i++) {
    if ((dbMessages[i]?.content || '') !== (incomingMessages[i]?.content || '')) return false;
    if (!!dbMessages[i]?.is_me !== !!incomingMessages[i]?.isMe) return false;
  }
  return true;
}

function extractBuyerUserIdFromSessionPayload(session = {}) {
  const candidates = [
    session.buyerUserId,
    session.product?.userId,
    session.sessionInfo?.userInfo?.userId,
  ];

  for (const candidate of candidates) {
    const normalized = candidate == null ? '' : String(candidate).trim();
    if (normalized) return normalized;
  }

  return null;
}

function parseQianniuDateTimeToUnix(text) {
  const normalized = normalizeOptionalText(text);
  if (!normalized) return null;

  const match = normalized.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second = '00'] = match;
  const parsed = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (Number.isNaN(parsed.getTime())) return null;

  return Math.floor(parsed.getTime() / 1000);
}

function normalizeQianniuPriceText(text) {
  const normalized = normalizeOptionalText(text);
  if (!normalized) return null;
  const match = normalized.match(/([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!match) return null;
  return `￥${match[1]}`;
}

function parseQianniuQuantity(value) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return null;
  const match = normalized.match(/(\d+)/);
  if (!match) return null;
  const quantity = Number(match[1]);
  if (!Number.isInteger(quantity) || quantity <= 0) return null;
  return quantity;
}

function stringifyJsonSafely(payload) {
  try { return JSON.stringify(payload || {}); } catch (_) { return '{}'; }
}

// ── Client management ────────────────────────────────────────────────────────

async function registerClient(clientId, accountId, clientName = '', secretHash = '', capabilities = []) {
  const db = await getDb();
  await db.run(
    `INSERT INTO clients(client_id, account_id, client_name, client_secret_hash, capabilities_json, last_seen_at, status)
     VALUES(?, ?, ?, ?, ?, unixepoch(), 'active')
     ON CONFLICT(client_id) DO UPDATE SET
       account_id = excluded.account_id,
       client_name = excluded.client_name,
       client_secret_hash = CASE
         WHEN excluded.client_secret_hash != '' THEN excluded.client_secret_hash
         ELSE clients.client_secret_hash
       END,
       capabilities_json = excluded.capabilities_json,
       last_seen_at = unixepoch(),
       status = 'active',
       updated_at = unixepoch()`,
    clientId, accountId, clientName, secretHash, JSON.stringify(capabilities)
  );
}

async function getClient(clientId) {
  const db = await getDb();
  return db.get(`SELECT * FROM clients WHERE client_id = ?`, clientId);
}

async function listClients(accountId = null) {
  const db = await getDb();
  if (accountId) {
    return db.all(`SELECT * FROM clients WHERE account_id = ? ORDER BY created_at ASC`, accountId);
  }
  return db.all(`SELECT * FROM clients ORDER BY account_id, created_at ASC`);
}

async function updateClientLastSeen(clientId) {
  const db = await getDb();
  await db.run(
    `UPDATE clients SET last_seen_at = unixepoch(), updated_at = unixepoch() WHERE client_id = ?`,
    clientId
  );
}

// ── Account settings ─────────────────────────────────────────────────────────

async function getAccountSetting(accountId, key, fallbackValue = null) {
  const db = await getDb();
  const row = await db.get(
    `SELECT value FROM account_settings WHERE account_id = ? AND key = ?`,
    accountId, key
  );
  return row ? row.value : fallbackValue;
}

async function setAccountSetting(accountId, key, value) {
  const db = await getDb();
  await db.run(
    `INSERT INTO account_settings(account_id, key, value, updated_at)
     VALUES(?, ?, ?, unixepoch())
     ON CONFLICT(account_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = unixepoch()`,
    accountId, key, value
  );
}

async function isAutoReplyEnabled(accountId) {
  const value = await getAccountSetting(accountId, 'auto_reply_enabled', '1');
  return value === '1';
}

async function setAutoReplyEnabled(accountId, enabled) {
  await setAccountSetting(accountId, 'auto_reply_enabled', enabled ? '1' : '0');
}

// ── Client runtime ───────────────────────────────────────────────────────────

async function getClientRuntime(clientId, key, fallbackValue = null) {
  const db = await getDb();
  const row = await db.get(
    `SELECT value FROM client_runtime WHERE client_id = ? AND key = ?`,
    clientId, key
  );
  return row ? row.value : fallbackValue;
}

async function setClientRuntime(clientId, key, value) {
  const db = await getDb();
  await db.run(
    `INSERT INTO client_runtime(client_id, key, value, updated_at)
     VALUES(?, ?, ?, unixepoch())
     ON CONFLICT(client_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = unixepoch()`,
    clientId, key, value
  );
}

async function isCrawlerDesiredEnabled(clientId) {
  const value = await getClientRuntime(clientId, 'crawler_desired_enabled', '1');
  return value === '1';
}

async function setCrawlerDesiredEnabled(clientId, enabled) {
  await setClientRuntime(clientId, 'crawler_desired_enabled', enabled ? '1' : '0');
}

async function updateCrawlerHeartbeat(clientId, runtimeState) {
  await setClientRuntime(clientId, 'crawler_reported_enabled', runtimeState.crawlerEnabled ? '1' : '0');
  await setClientRuntime(clientId, 'crawler_last_heartbeat_at', String(Math.floor(Date.now() / 1000)));
  await updateClientLastSeen(clientId);
}

async function getRuntimeSettings(accountId, clientId) {
  const [
    autoReplyEnabled,
    crawlerDesiredEnabled,
    crawlerReportedValue,
    crawlerLastHeartbeatValue,
    initialCrawlSessionCountValue,
  ] = await Promise.all([
    isAutoReplyEnabled(accountId),
    isCrawlerDesiredEnabled(clientId),
    getClientRuntime(clientId, 'crawler_reported_enabled', ''),
    getClientRuntime(clientId, 'crawler_last_heartbeat_at', '0'),
    getClientRuntime(clientId, 'initial_crawl_session_count', '30'),
  ]);

  // Get pending initial_crawl command for this client
  const db = await getDb();
  const pendingCrawl = await db.get(
    `SELECT requested_nonce FROM client_commands
     WHERE client_id = ? AND command_type = 'initial_crawl' AND handled_nonce IS NULL
     ORDER BY id DESC LIMIT 1`,
    clientId
  );

  return {
    autoReplyEnabled,
    crawlerDesiredEnabled,
    crawlerReportedEnabled:
      crawlerReportedValue === '' ? null : crawlerReportedValue === '1',
    crawlerLastHeartbeatAt: Number(crawlerLastHeartbeatValue || 0),
    initialCrawlSessionCount: Number(initialCrawlSessionCountValue) || 30,
    initialCrawlNonce: pendingCrawl?.requested_nonce || null,
  };
}

async function ensureRuntimeSettings(accountId, clientId, defaults = {}) {
  const autoReplyValue = defaults.autoReplyEnabled ? '1' : '0';
  const crawlerDesiredValue = defaults.crawlerDesiredEnabled === false ? '0' : '1';

  // Account-level settings
  const db = await getDb();
  await db.run(
    `INSERT INTO account_settings(account_id, key, value, updated_at)
     VALUES(?, 'auto_reply_enabled', ?, unixepoch())
     ON CONFLICT(account_id, key) DO NOTHING`,
    accountId, autoReplyValue
  );

  // Client-level runtime defaults
  const clientDefaults = {
    'crawler_desired_enabled': crawlerDesiredValue,
    'crawler_reported_enabled': '',
    'crawler_last_heartbeat_at': '0',
    'initial_crawl_session_count': '30',
    'qianniu_last_heartbeat_at': '0',
    'qianniu_page_url': '',
    'qianniu_visible_order_count': '0',
    'qianniu_scan_state': 'idle',
    'qianniu_last_sync_at': '0',
    'qianniu_last_sync_stats': '{}',
  };

  for (const [key, value] of Object.entries(clientDefaults)) {
    await db.run(
      `INSERT INTO client_runtime(client_id, key, value, updated_at)
       VALUES(?, ?, ?, unixepoch())
       ON CONFLICT(client_id, key) DO NOTHING`,
      clientId, key, value
    );
  }
}

async function setInitialCrawlSessionCount(clientId, n) {
  await setClientRuntime(clientId, 'initial_crawl_session_count', String(Math.max(1, Math.min(100, n))));
}

// ── Client commands ──────────────────────────────────────────────────────────

async function requestCommand(clientId, commandType, payloadJson = '{}') {
  const db = await getDb();
  const requestedNonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await db.run(
    `INSERT INTO client_commands(client_id, command_type, requested_nonce, payload_json)
     VALUES(?, ?, ?, ?)`,
    clientId, commandType, requestedNonce, payloadJson
  );
  return { requestedNonce };
}

async function handleCommandNonce(clientId, commandType, handledNonce) {
  const db = await getDb();
  await db.run(
    `UPDATE client_commands
     SET handled_nonce = ?,
         handled_at = unixepoch()
     WHERE client_id = ? AND command_type = ? AND requested_nonce = ? AND handled_nonce IS NULL`,
    handledNonce, clientId, commandType, handledNonce
  );
}

async function getPendingCommand(clientId, commandType) {
  const db = await getDb();
  return db.get(
    `SELECT * FROM client_commands
     WHERE client_id = ? AND command_type = ? AND handled_nonce IS NULL
     ORDER BY id DESC LIMIT 1`,
    clientId, commandType
  );
}

async function requestInitialCrawl(clientId) {
  return requestCommand(clientId, 'initial_crawl');
}

async function requestQianniuSyncNow(clientId) {
  return requestCommand(clientId, 'orders_sync_now');
}

async function requestQianniuFullScan(clientId) {
  return requestCommand(clientId, 'orders_full_scan');
}

// ── Qianniu runtime ──────────────────────────────────────────────────────────

function parseSettingsJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

async function updateQianniuHeartbeat(clientId, runtimeState = {}) {
  const pageUrl = normalizeOptionalText(runtimeState.pageUrl) || '';
  const visibleOrderCount = Number.isFinite(Number(runtimeState.visibleOrderCount))
    ? String(Math.max(0, Number(runtimeState.visibleOrderCount)))
    : '0';
  const scanState = runtimeState.scanState === 'scanning' ? 'scanning' : 'idle';

  await setClientRuntime(clientId, 'qianniu_page_url', pageUrl);
  await setClientRuntime(clientId, 'qianniu_visible_order_count', visibleOrderCount);
  await setClientRuntime(clientId, 'qianniu_scan_state', scanState);
  await setClientRuntime(clientId, 'qianniu_last_heartbeat_at', String(Math.floor(Date.now() / 1000)));
  await updateClientLastSeen(clientId);

  if (runtimeState.scanNonceHandled) {
    await handleCommandNonce(clientId, 'orders_full_scan', runtimeState.scanNonceHandled);
  }
  if (runtimeState.syncNonceHandled) {
    await handleCommandNonce(clientId, 'orders_sync_now', runtimeState.syncNonceHandled);
  }

  return getQianniuRuntime(clientId);
}

async function getQianniuRuntime(clientId) {
  const [
    pageUrl,
    visibleOrderCount,
    scanState,
    lastHeartbeatAt,
    lastSyncAt,
    lastSyncStats,
  ] = await Promise.all([
    getClientRuntime(clientId, 'qianniu_page_url', ''),
    getClientRuntime(clientId, 'qianniu_visible_order_count', '0'),
    getClientRuntime(clientId, 'qianniu_scan_state', 'idle'),
    getClientRuntime(clientId, 'qianniu_last_heartbeat_at', '0'),
    getClientRuntime(clientId, 'qianniu_last_sync_at', '0'),
    getClientRuntime(clientId, 'qianniu_last_sync_stats', '{}'),
  ]);

  const pendingSyncNow = await getPendingCommand(clientId, 'orders_sync_now');
  const pendingFullScan = await getPendingCommand(clientId, 'orders_full_scan');

  const heartbeatTs = Number(lastHeartbeatAt || 0);

  return {
    isOnline: heartbeatTs > 0 && (Math.floor(Date.now() / 1000) - heartbeatTs) <= 12,
    pageUrl: pageUrl || '',
    visibleOrderCount: Number(visibleOrderCount || 0),
    scanState: scanState === 'scanning' ? 'scanning' : 'idle',
    lastHeartbeatAt: heartbeatTs,
    lastSyncAt: Number(lastSyncAt || 0),
    lastSyncStats: parseSettingsJson(lastSyncStats, {}),
    syncNowNonce: pendingSyncNow?.requested_nonce || null,
    fullScanNonce: pendingFullScan?.requested_nonce || null,
  };
}

// ── Session resolution ───────────────────────────────────────────────────────

async function resolveCanonicalSessionKey(db, accountId, chatKey, customerName, productId, messages = [], sessionId = null) {
  if (sessionId) {
    const existingBySessionId = await db.get(
      `SELECT chat_key FROM sessions WHERE account_id = ? AND session_id = ?`,
      accountId, sessionId
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
     WHERE account_id = ? AND customer_name = ?
       AND product_id IS NOT NULL AND product_id != ''`,
    accountId, customerName
  );

  for (const candidate of candidates) {
    const dbMessages = await db.all(
      'SELECT content, is_me FROM messages WHERE account_id = ? AND chat_key = ? ORDER BY seq ASC',
      accountId, candidate.chat_key
    );
    if (areMessageSnapshotsEquivalent(dbMessages, messages)) {
      return candidate.chat_key;
    }
  }

  return chatKey;
}

async function cleanupDuplicateSessionKey(db, accountId, sourceChatKey, targetChatKey, customerName, productId, sessionId) {
  if (!sourceChatKey || sourceChatKey === targetChatKey) return;

  await db.run(
    `UPDATE orders SET chat_key = ?, updated_at = unixepoch()
     WHERE account_id = ? AND chat_key = ?`,
    targetChatKey, accountId, sourceChatKey
  );
  await db.run(
    `UPDATE outgoing_messages
     SET chat_key = ?,
         customer_name = COALESCE(customer_name, ?),
         product_id = COALESCE(product_id, ?),
         session_id = COALESCE(session_id, ?)
     WHERE account_id = ? AND chat_key = ?`,
    targetChatKey, customerName, productId, sessionId,
    accountId, sourceChatKey
  );
  await db.run(`DELETE FROM messages WHERE account_id = ? AND chat_key = ?`, accountId, sourceChatKey);
  await db.run(`DELETE FROM outbox WHERE account_id = ? AND chat_key = ?`, accountId, sourceChatKey);
  await db.run(`DELETE FROM sessions WHERE account_id = ? AND chat_key = ?`, accountId, sourceChatKey);
}

async function cleanupEmptySessionShell(db, accountId, chatKey) {
  if (!chatKey) return false;

  const stats = await db.get(
    `SELECT
       EXISTS(SELECT 1 FROM sessions WHERE account_id = ? AND chat_key = ?) AS has_session,
       EXISTS(SELECT 1 FROM messages WHERE account_id = ? AND chat_key = ?) AS has_messages,
       EXISTS(SELECT 1 FROM outgoing_messages WHERE account_id = ? AND chat_key = ?) AS has_outgoing,
       EXISTS(SELECT 1 FROM orders WHERE account_id = ? AND chat_key = ?) AS has_orders`,
    accountId, chatKey, accountId, chatKey, accountId, chatKey, accountId, chatKey
  );

  if (!stats?.has_session || stats.has_messages || stats.has_outgoing || stats.has_orders) {
    return false;
  }

  await db.run(`DELETE FROM outbox WHERE account_id = ? AND chat_key = ?`, accountId, chatKey);
  await db.run(`DELETE FROM sessions WHERE account_id = ? AND chat_key = ?`, accountId, chatKey);
  return true;
}

async function reconcileOrdersForSession(db, accountId, chatKey, buyerUserId, productId) {
  if (!chatKey || !buyerUserId || !productId) return;

  const matches = await db.get(
    `SELECT COUNT(*) AS cnt FROM sessions
     WHERE account_id = ? AND buyer_user_id = ? AND product_id = ?`,
    accountId, buyerUserId, productId
  );
  if ((matches?.cnt || 0) !== 1) return;

  await db.run(
    `UPDATE orders SET chat_key = ?, updated_at = unixepoch()
     WHERE account_id = ? AND buyer_user_id = ? AND product_id = ?
       AND (chat_key IS NULL OR chat_key != ?)`,
    chatKey, accountId, buyerUserId, productId, chatKey
  );
}

async function backfillMessageTransportMetadata(db, accountId, chatKey, seq, message = {}) {
  const externalMessageId = normalizeOptionalText(message.messageId);
  const replyToMessageId = normalizeOptionalText(message.replyMessageId);
  if (!externalMessageId && !replyToMessageId) return;

  await db.run(
    `UPDATE messages
     SET external_message_id = COALESCE(NULLIF(external_message_id, ''), ?),
         reply_to_message_id = COALESCE(NULLIF(reply_to_message_id, ''), ?)
     WHERE account_id = ? AND chat_key = ? AND seq = ?`,
    externalMessageId, replyToMessageId, accountId, chatKey, seq
  );
}

// ── Ingest ───────────────────────────────────────────────────────────────────

async function ingest(accountId, clientId, sessions) {
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
      const buyerUserId = extractBuyerUserIdFromSessionPayload(session);
      const sessionInfoJson =
        sessionInfo && typeof sessionInfo === 'object'
          ? JSON.stringify(sessionInfo)
          : '{}';

      if (!messages.length) {
        const cleanedUpEmptyShell = await cleanupEmptySessionShell(db, accountId, chatKey);
        results[chatKey] = {
          isNewSession: false,
          newMsgCount: 0,
          totalMessages: 0,
          canonicalChatKey: chatKey,
          skipped: true,
          reason: 'empty_session',
          cleanedUpEmptyShell,
        };
        continue;
      }

      const canonicalChatKey = await resolveCanonicalSessionKey(
        db, accountId, chatKey, effectiveCustomerName, productId, messages, normalizedSessionId
      );
      const productJson = JSON.stringify(product);

      const existing = await db.get(
        'SELECT chat_key FROM sessions WHERE account_id = ? AND chat_key = ?',
        accountId, canonicalChatKey
      );

      // Upsert session
      await db.run(`
        INSERT INTO sessions(account_id, chat_key, customer_name, product_id, product_json, session_id, session_info_json, buyer_user_id, last_seen_client_id)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, chat_key) DO UPDATE SET
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
          buyer_user_id = CASE
            WHEN excluded.buyer_user_id IS NOT NULL AND excluded.buyer_user_id != '' THEN excluded.buyer_user_id
            ELSE sessions.buyer_user_id
          END,
          last_seen_client_id = excluded.last_seen_client_id,
          updated_at = unixepoch()
      `, accountId, canonicalChatKey, effectiveCustomerName, productId, productJson, normalizedSessionId, sessionInfoJson, buyerUserId, clientId);

      await reconcileOrdersForSession(db, accountId, canonicalChatKey, buyerUserId, productId);

      await cleanupDuplicateSessionKey(
        db, accountId, chatKey, canonicalChatKey, effectiveCustomerName, productId, normalizedSessionId
      );

      if (!existing) {
        await db.run(
          `INSERT INTO outbox(account_id, event_type, chat_key, payload)
           VALUES(?, 'new_session', ?, ?)`,
          accountId, canonicalChatKey,
          JSON.stringify({
            chatKey: canonicalChatKey,
            customerName: effectiveCustomerName,
            productId,
            product,
            sessionId: normalizedSessionId,
          })
        );
      }

      const dbMsgs = await db.all(
        'SELECT id, content, is_me, seq, type FROM messages WHERE account_id = ? AND chat_key = ? ORDER BY seq ASC',
        accountId, canonicalChatKey
      );

      let newMsgCount = 0;
      const newMessages = [];
      let currentSeq = dbMsgs.length > 0 ? dbMsgs[dbMsgs.length - 1].seq + 1 : 0;

      if (messages && messages.length > 0) {
        let isSubstring = false;
        let substringStart = -1;
        if (dbMsgs.length >= messages.length) {
          for (let start = 0; start <= dbMsgs.length - messages.length; start++) {
            let match = true;
            for (let j = 0; j < messages.length; j++) {
              if (!areMessagesEquivalent(dbMsgs[start + j], messages[j])) {
                match = false;
                break;
              }
            }
            if (match) {
              isSubstring = true;
              substringStart = start;
              break;
            }
          }
        }

        if (!isSubstring) {
          let overlapLen = 0;
          const maxOverlap = Math.min(dbMsgs.length, messages.length);

          for (let i = maxOverlap; i >= 0; i--) {
            let match = true;
            for (let j = 0; j < i; j++) {
              const dbMsg = dbMsgs[dbMsgs.length - i + j];
              const inMsg = messages[j];
              if (!areMessagesEquivalent(dbMsg, inMsg)) {
                match = false;
                break;
              }
            }
            if (match) {
              overlapLen = i;
              break;
            }
          }

          for (let i = 0; i < overlapLen; i++) {
            await backfillMessageTransportMetadata(
              db, accountId, canonicalChatKey, dbMsgs[dbMsgs.length - overlapLen + i].seq, messages[i]
            );
          }

          for (let i = overlapLen; i < messages.length; i++) {
            const {
              content,
              isMe,
              type = 'text',
              messageId = null,
              replyMessageId = null,
            } = messages[i];
            if (!content) continue;

            const comparableContent = normalizeMessageContentForMatching(content, type);
            const hash = crypto.createHash('md5').update(`v4:${chatKey}:${isMe ? 1 : 0}:${type}:${comparableContent}:${currentSeq}`).digest('hex');

            const result = await db.run(
              `INSERT OR IGNORE INTO messages(
                 account_id, chat_key, msg_hash, seq, content, is_me, type,
                 external_message_id, reply_to_message_id
               )
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              accountId, canonicalChatKey, hash, currentSeq, content, isMe ? 1 : 0, type,
              normalizeOptionalText(messageId), normalizeOptionalText(replyMessageId)
            );

            await backfillMessageTransportMetadata(db, accountId, canonicalChatKey, currentSeq, messages[i]);

            if (result.changes > 0) {
              newMsgCount++;
              newMessages.push({ seq: currentSeq, content, isMe, type });
              currentSeq++;
            }
          }
        } else if (substringStart >= 0) {
          for (let i = 0; i < messages.length; i++) {
            await backfillMessageTransportMetadata(
              db, accountId, canonicalChatKey, dbMsgs[substringStart + i].seq, messages[i]
            );
          }
        }
      }

      if (newMsgCount > 0) {
        await db.run(
          `INSERT INTO outbox(account_id, event_type, chat_key, payload)
           VALUES(?, 'new_messages', ?, ?)`,
          accountId, canonicalChatKey,
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
        canonicalChatKey,
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

async function listSessions(accountId) {
  const db = await getDb();
  return db.all(`
    SELECT
      s.chat_key, s.account_id, s.customer_name, s.product_id, s.product_json,
      s.session_id, s.session_info_json, s.buyer_user_id, s.last_seen_client_id,
      s.created_at, s.updated_at,
      COUNT(m.id) AS message_count,
      (SELECT content FROM messages WHERE account_id = s.account_id AND chat_key = s.chat_key ORDER BY seq DESC LIMIT 1) AS last_message,
      (SELECT is_me   FROM messages WHERE account_id = s.account_id AND chat_key = s.chat_key ORDER BY seq DESC LIMIT 1) AS last_is_me,
      (
        SELECT MAX(t) FROM (
          SELECT * FROM (SELECT ingested_at as t FROM messages WHERE account_id = s.account_id AND chat_key = s.chat_key ORDER BY seq DESC LIMIT 1)
          UNION ALL
          SELECT * FROM (SELECT created_at as t FROM outgoing_messages WHERE account_id = s.account_id AND chat_key = s.chat_key ORDER BY id DESC LIMIT 1)
        )
      ) AS last_time
    FROM sessions s
    LEFT JOIN messages m ON m.account_id = s.account_id AND m.chat_key = s.chat_key
    WHERE s.account_id = ?
    GROUP BY s.account_id, s.chat_key
    ORDER BY COALESCE(last_time, s.updated_at) DESC
  `, accountId);
}

async function getSession(accountId, chatKey) {
  const db = await getDb();
  return db.get('SELECT * FROM sessions WHERE account_id = ? AND chat_key = ?', accountId, chatKey);
}

async function getSessionBySessionId(accountId, sessionId) {
  const db = await getDb();
  return db.get(
    `SELECT * FROM sessions WHERE account_id = ? AND session_id = ?`,
    accountId, sessionId
  );
}

async function getMessages(accountId, chatKey) {
  const db = await getDb();
  return db.all(
    `SELECT
       id, account_id, chat_key, msg_hash, seq, content, is_me, type,
       ingested_at, external_message_id, reply_to_message_id
     FROM messages
     WHERE account_id = ? AND chat_key = ?
     ORDER BY seq ASC`,
    accountId, chatKey
  );
}

// ── Order ingestion ──────────────────────────────────────────────────────────

async function resolveOrderChatKey(db, accountId, buyerUserId, productId) {
  if (!buyerUserId || !productId) return null;

  const matches = await db.all(
    `SELECT chat_key FROM sessions
     WHERE account_id = ? AND buyer_user_id = ? AND product_id = ?
     ORDER BY updated_at DESC, chat_key ASC
     LIMIT 2`,
    accountId, buyerUserId, productId
  );
  return matches.length === 1 ? matches[0].chat_key : null;
}

async function ingestOrders(accountId, clientId, orders = [], pageContext = {}) {
  const db = await getDb();
  const safeOrders = Array.isArray(orders) ? orders : [];
  const stats = {
    inserted: 0,
    updated: 0,
    matched: 0,
    unmatched: 0,
    skipped: 0,
    total: safeOrders.length,
  };
  const nowTs = Math.floor(Date.now() / 1000);

  await db.exec('BEGIN');
  try {
    for (const order of safeOrders) {
      const orderId = normalizeOptionalText(order?.orderId);
      if (!orderId) {
        stats.skipped++;
        continue;
      }

      const buyerName = normalizeOptionalText(order?.buyerName);
      const buyerUserId = normalizeOptionalText(order?.buyerUserId);
      const productId = normalizeOptionalText(order?.productId);
      const productTitle = normalizeOptionalText(order?.productTitle);
      const productPrice = normalizeQianniuPriceText(order?.productPrice);
      const purchaseQuantity = parseQianniuQuantity(order?.purchaseQuantity);
      const receiverName = normalizeOptionalText(order?.receiverName);
      const receiverPhone = normalizeOptionalText(order?.receiverPhone);
      const receiverAddress = normalizeOptionalText(order?.receiverAddress);
      const orderStatusText = normalizeOptionalText(order?.orderStatusText);
      const paidAt = parseQianniuDateTimeToUnix(order?.paidAtText);
      const latestShipAt = parseQianniuDateTimeToUnix(order?.latestShipAtText);
      const chatKey = await resolveOrderChatKey(db, accountId, buyerUserId, productId);
      const rawJson = stringifyJsonSafely({
        raw: order?.raw || null,
        extracted: {
          orderId, buyerName, buyerUserId, productId, productTitle, productPrice,
          purchaseQuantity, receiverName, receiverPhone, receiverAddress,
          orderStatusText,
          paidAtText: normalizeOptionalText(order?.paidAtText),
          latestShipAtText: normalizeOptionalText(order?.latestShipAtText),
        },
        pageContext: {
          mode: normalizeOptionalText(pageContext?.mode) || 'current-page',
          pageNo: pageContext?.pageNo ?? null,
          scanNonce: normalizeOptionalText(pageContext?.scanNonce),
          collectedAt: pageContext?.collectedAt ?? null,
        },
      });

      const existing = await db.get(
        `SELECT id FROM orders WHERE account_id = ? AND order_id = ?`,
        accountId, orderId
      );

      await db.run(
        `INSERT INTO orders(
           account_id, order_id, chat_key,
           buyer_name, buyer_user_id, product_id, product_title, product_price,
           purchase_quantity, receiver_name, receiver_phone, receiver_address,
           order_status_text, paid_at, latest_ship_at, last_seen_at, raw_json, updated_at
         )
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
         ON CONFLICT(account_id, order_id) DO UPDATE SET
           chat_key = excluded.chat_key,
           buyer_name = excluded.buyer_name,
           buyer_user_id = excluded.buyer_user_id,
           product_id = excluded.product_id,
           product_title = excluded.product_title,
           product_price = excluded.product_price,
           purchase_quantity = excluded.purchase_quantity,
           receiver_name = excluded.receiver_name,
           receiver_phone = excluded.receiver_phone,
           receiver_address = excluded.receiver_address,
           order_status_text = excluded.order_status_text,
           paid_at = excluded.paid_at,
           latest_ship_at = excluded.latest_ship_at,
           last_seen_at = excluded.last_seen_at,
           raw_json = excluded.raw_json,
           updated_at = unixepoch()`,
        accountId, orderId, chatKey,
        buyerName, buyerUserId, productId, productTitle, productPrice,
        purchaseQuantity, receiverName, receiverPhone, receiverAddress,
        orderStatusText, paidAt, latestShipAt, nowTs, rawJson
      );

      if (existing) { stats.updated++; } else { stats.inserted++; }
      if (chatKey) { stats.matched++; } else { stats.unmatched++; }
    }

    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }

  await setClientRuntime(clientId, 'qianniu_last_sync_at', String(nowTs));
  await setClientRuntime(clientId, 'qianniu_last_sync_stats', stringifyJsonSafely({
    ...stats,
    pageContext: {
      mode: normalizeOptionalText(pageContext?.mode) || 'current-page',
      pageNo: pageContext?.pageNo ?? null,
      scanNonce: normalizeOptionalText(pageContext?.scanNonce),
      collectedAt: pageContext?.collectedAt ?? null,
    },
  }));

  return stats;
}

async function listOrders(accountId, { linked = 'all', q = '', limit = 200, chatKey = null } = {}) {
  const db = await getDb();
  const filters = ['o.account_id = ?'];
  const params = [accountId];
  const normalizedLinked = ['all', 'linked', 'unlinked'].includes(linked) ? linked : 'all';
  const normalizedQuery = normalizeOptionalText(q);
  const normalizedChatKey = normalizeOptionalText(chatKey);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));

  if (normalizedLinked === 'linked') {
    filters.push(`o.chat_key IS NOT NULL AND TRIM(o.chat_key) != ''`);
  } else if (normalizedLinked === 'unlinked') {
    filters.push(`o.chat_key IS NULL OR TRIM(o.chat_key) = ''`);
  }

  if (normalizedChatKey) {
    filters.push(`o.chat_key = ?`);
    params.push(normalizedChatKey);
  }

  if (normalizedQuery) {
    const likeQuery = `%${normalizedQuery}%`;
    filters.push(`(
      o.order_id LIKE ?
      OR COALESCE(o.buyer_name, '') LIKE ?
      OR COALESCE(o.buyer_user_id, '') LIKE ?
      OR COALESCE(o.product_id, '') LIKE ?
      OR COALESCE(o.product_title, '') LIKE ?
      OR COALESCE(o.product_price, '') LIKE ?
      OR COALESCE(o.receiver_name, '') LIKE ?
      OR COALESCE(o.receiver_phone, '') LIKE ?
      OR COALESCE(o.receiver_address, '') LIKE ?
    )`);
    params.push(likeQuery, likeQuery, likeQuery, likeQuery, likeQuery, likeQuery, likeQuery, likeQuery, likeQuery);
  }

  const whereSql = `WHERE ${filters.join(' AND ')}`;
  return db.all(
    `SELECT o.*
     FROM orders o
     ${whereSql}
     ORDER BY COALESCE(o.last_seen_at, o.updated_at) DESC, o.order_id DESC
     LIMIT ?`,
    ...params,
    safeLimit
  );
}

async function listOrdersByChatKey(accountId, chatKey, limit = 20) {
  return listOrders(accountId, { chatKey, limit, linked: 'linked' });
}

// ── Outgoing messages ────────────────────────────────────────────────────────

const OUTGOING_LIST_COLUMNS = [
  'id', 'account_id', 'chat_key', 'customer_name', 'product_id', 'session_id',
  'content', 'message_type', 'media_name',
  'reply_to_external_message_id', 'reply_to_preview', 'reply_to_type',
  'target_client_id', 'claimed_by_client_id',
  'status', 'created_at', 'sent_at', 'claimed_at', 'error', 'retries', 'source',
].join(', ');

async function addOutgoingMessage(accountId, chatKey, contentOrPayload, customerName = null, productId = null, source = 'ai', sessionId = null, targetClientId = null) {
  const db = await getDb();
  let payload = null;

  if (contentOrPayload && typeof contentOrPayload === 'object' && !Array.isArray(contentOrPayload)) {
    payload = contentOrPayload;
    customerName = payload.customerName ?? customerName;
    productId = payload.productId ?? productId;
    source = payload.source ?? source;
    sessionId = payload.sessionId ?? sessionId;
    targetClientId = payload.targetClientId ?? targetClientId;
  }

  const content = normalizeOptionalText(payload?.content ?? contentOrPayload) || '';
  const messageType = payload?.messageType === 'image' ? 'image' : 'text';
  const mediaData = normalizeOptionalText(payload?.mediaData);
  const mediaName = normalizeOptionalText(payload?.mediaName);
  const replyToExternalMessageId = normalizeOptionalText(payload?.replyToExternalMessageId);
  const replyToPreview = normalizeOptionalText(payload?.replyToPreview);
  const replyToType = payload?.replyToType === 'image'
    ? 'image'
    : (payload?.replyToType === 'text' ? 'text' : null);

  // If not provided, look up from session
  if (!customerName || !productId || !sessionId || !targetClientId) {
    const session = await db.get(
      'SELECT customer_name, product_id, session_id, last_seen_client_id FROM sessions WHERE account_id = ? AND chat_key = ?',
      accountId, chatKey
    );
    if (session) {
      customerName = customerName || session.customer_name;
      productId = productId || session.product_id;
      sessionId = sessionId || session.session_id || null;
      targetClientId = targetClientId || session.last_seen_client_id || null;
    }
  }

  const result = await db.run(
    `INSERT INTO outgoing_messages(
       account_id, chat_key, customer_name, product_id, session_id,
       content, source, message_type, media_data, media_name,
       reply_to_external_message_id, reply_to_preview, reply_to_type,
       target_client_id
     )
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    accountId, chatKey, customerName, productId, sessionId,
    content, source, messageType, mediaData, mediaName,
    replyToExternalMessageId, replyToPreview, replyToType,
    targetClientId
  );
  return { id: result.lastID };
}

async function listOutgoingMessages(accountId, chatKey, status) {
  const db = await getDb();
  if (chatKey && status) {
    return db.all(
      `SELECT ${OUTGOING_LIST_COLUMNS} FROM outgoing_messages
       WHERE account_id = ? AND chat_key = ? AND status = ?
       ORDER BY id ASC`,
      accountId, chatKey, status
    );
  }
  if (chatKey) {
    return db.all(
      `SELECT ${OUTGOING_LIST_COLUMNS} FROM outgoing_messages
       WHERE account_id = ? AND chat_key = ?
       ORDER BY id DESC LIMIT 100`,
      accountId, chatKey
    );
  }
  if (status) {
    return db.all(
      `SELECT ${OUTGOING_LIST_COLUMNS} FROM outgoing_messages
       WHERE account_id = ? AND status = ?
       ORDER BY id ASC LIMIT 100`,
      accountId, status
    );
  }
  return db.all(
    `SELECT ${OUTGOING_LIST_COLUMNS} FROM outgoing_messages
     WHERE account_id = ?
     ORDER BY id DESC LIMIT 100`,
    accountId
  );
}

async function updateOutgoingStatus(id, clientId, status, error = null) {
  const db = await getDb();
  await db.run(
    `UPDATE outgoing_messages
     SET status = ?,
         sent_at = CASE WHEN ? = 'sent' THEN unixepoch() ELSE sent_at END,
         claimed_at = NULL,
         error = ?,
         retries = CASE WHEN ? = 'failed' THEN retries + 1 ELSE retries END,
         last_attempt_at = unixepoch()
     WHERE id = ?
       AND claimed_by_client_id = ?`,
    status, status, error, status, id, clientId
  );
}

async function claimOutgoingMessage(clientId) {
  const db = await getDb();
  const staleBefore = Math.floor(Date.now() / 1000) - OUTGOING_CLAIM_STALE_SECONDS;

  await db.exec('BEGIN IMMEDIATE');
  try {
    // Only claim messages targeted at this client (or with null target)
    const row = await db.get(
      `SELECT
         om.*,
         s.session_id AS session_row_id,
         s.session_info_json AS session_row_info_json
       FROM outgoing_messages om
       LEFT JOIN sessions s ON s.account_id = om.account_id AND s.chat_key = om.chat_key
       WHERE (om.target_client_id = ? OR om.target_client_id IS NULL)
         AND (
           om.status = 'pending'
           OR (om.status = 'sending' AND COALESCE(om.claimed_at, 0) <= ?)
         )
       ORDER BY
         CASE WHEN om.target_client_id = ? THEN 0 ELSE 1 END,
         CASE WHEN om.status = 'pending' THEN 0 ELSE 1 END,
         om.id ASC
       LIMIT 1`,
      clientId, staleBefore, clientId
    );

    if (!row) {
      await db.exec('COMMIT');
      return null;
    }

    const result = await db.run(
      `UPDATE outgoing_messages
       SET status = 'sending',
           claimed_at = unixepoch(),
           claimed_by_client_id = ?,
           last_attempt_at = unixepoch(),
           session_id = COALESCE(session_id, ?)
       WHERE id = ?
         AND (
           status = 'pending'
           OR (status = 'sending' AND COALESCE(claimed_at, 0) <= ?)
         )`,
      clientId,
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
      claimed_by_client_id: clientId,
      session_id: row.session_id || row.session_row_id || null,
      session_info_json: row.session_row_info_json || '{}',
    };
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}

// ── Outbox events (for auto-reply worker) ────────────────────────────────────

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

async function getLastMessageDirection(accountId, chatKey) {
  const db = await getDb();
  const row = await db.get(
    `SELECT is_me FROM messages WHERE account_id = ? AND chat_key = ? ORDER BY seq DESC LIMIT 1`,
    accountId, chatKey
  );
  return row ? row.is_me : null;
}

async function hasPendingOutgoing(accountId, chatKey) {
  const db = await getDb();
  const row = await db.get(
    `SELECT COUNT(*) as cnt FROM outgoing_messages
     WHERE account_id = ? AND chat_key = ?
       AND status IN ('pending', 'sending')`,
    accountId, chatKey
  );
  return (row?.cnt || 0) > 0;
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Client management
  registerClient,
  getClient,
  listClients,
  updateClientLastSeen,

  // Account settings
  getAccountSetting,
  setAccountSetting,
  isAutoReplyEnabled,
  setAutoReplyEnabled,

  // Client runtime
  getClientRuntime,
  setClientRuntime,
  isCrawlerDesiredEnabled,
  setCrawlerDesiredEnabled,
  updateCrawlerHeartbeat,
  getRuntimeSettings,
  ensureRuntimeSettings,
  setInitialCrawlSessionCount,

  // Client commands
  requestCommand,
  handleCommandNonce,
  getPendingCommand,
  requestInitialCrawl,
  requestQianniuSyncNow,
  requestQianniuFullScan,

  // Qianniu runtime
  updateQianniuHeartbeat,
  getQianniuRuntime,

  // Core data
  ingest,
  listSessions,
  getSession,
  getSessionBySessionId,
  getMessages,
  ingestOrders,
  listOrders,
  listOrdersByChatKey,

  // Outgoing messages
  addOutgoingMessage,
  listOutgoingMessages,
  updateOutgoingStatus,
  claimOutgoingMessage,

  // Outbox
  getUnprocessedOutbox,
  markOutboxProcessed,
  getLastMessageDirection,
  hasPendingOutgoing,

  // Constants
  DEFAULT_ACCOUNT_ID,
  LEGACY_CLIENT_ID,
};
