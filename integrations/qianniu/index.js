'use strict';

/**
 * integrations/qianniu/index.js
 * ─────────────────────────────
 * 千牛 / 淘宝开放平台 集成预留模块。
 *
 * 计划能力（TODO）：
 *   - fetchOrders()       拉取待发货订单，写入 orders 表
 *   - shipOrder(orderId)  通知千牛发货，更新 shipments 表
 *   - syncTracking()      同步快递单号到 shipments 表
 *
 * 数据库表（已建，见 server/db.js）：
 *   - orders     : 订单信息（order_id, chat_key, status, raw_json…）
 *   - shipments  : 发货信息（order_id, tracking_no, carrier, status…）
 *
 * 接入方式（待定）：
 *   方案 A — 千牛开放 API（OAuth + REST）
 *   方案 B — OpenClaw browser 操控千牛网页读取订单信息
 */

// async function fetchOrders() {
//   throw new Error('Not implemented — awaiting 千牛 API credentials');
// }

// async function shipOrder(orderId, trackingNo, carrier) {
//   throw new Error('Not implemented');
// }

module.exports = {};
