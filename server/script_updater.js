#!/usr/bin/env node
/**
 * script_updater.js — 通过 CDP 触发 Tampermonkey 更新本地油猴脚本。
 *
 * 主路径：打开 Tampermonkey Dashboard，通过批量操作"触发一次更新"让 Tampermonkey
 *         根据 @updateURL/@downloadURL 拉取最新脚本。
 * 回退路径：逐脚本在浏览器中导航到 .user.js URL，由 Tampermonkey 拦截后自动触发
 *           安装/重装流程，再通过 CDP 点击安装按钮完成更新。
 *
 * 依赖环境变量：
 *   CDP_PORT                   — Chrome 调试端口（默认 18800）
 *   TAMPERMONKEY_EXTENSION_ID  — Tampermonkey 扩展 ID
 */

'use strict';

const { WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');

const SERVER_PORT = process.env.PORT || 3210;

const USERSCRIPT_MANIFEST = [
  {
    name: 'xianyu_monitor',
    filePath: path.join(__dirname, '..', 'xianyu_capture', 'xianyu_monitor.js'),
    serveUrl: `http://localhost:${SERVER_PORT}/scripts/xianyu_monitor.user.js`,
  },
  {
    name: 'qianniu_batch_consign',
    filePath: path.join(__dirname, '..', 'qianniu_capture', 'qianniu_batch_consign.js'),
    serveUrl: `http://localhost:${SERVER_PORT}/scripts/qianniu_batch_consign.user.js`,
  },
];

// ── CDP 工具函数 ─────────────────────────────────────────────────────────────

/**
 * 列出所有 CDP 可见的 target（tab、service worker 等）。
 * @param {number} cdpPort
 * @returns {Promise<Array<{id: string, url: string, type: string, webSocketDebuggerUrl?: string}>>}
 */
async function listCdpTargets(cdpPort) {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
  if (!res.ok) throw new Error(`CDP not available at port ${cdpPort}`);
  return res.json();
}

/**
 * 通过 CDP 打开一个新 tab。
 * @param {number} cdpPort
 * @param {string} url
 * @returns {Promise<{id: string, webSocketDebuggerUrl?: string}>}
 */
async function openNewTab(cdpPort, url) {
  const endpoint = `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`;
  // 新版 Chrome 要求 PUT，旧版接受 GET；优先 PUT，失败后回退 GET
  let res = await fetch(endpoint, { method: 'PUT' });
  if (res.status === 405) {
    res = await fetch(endpoint);
  }
  if (!res.ok) throw new Error(`Failed to open new tab: HTTP ${res.status}`);
  return res.json();
}

/**
 * 通过 CDP 关闭指定 tab。
 * @param {number} cdpPort
 * @param {string} targetId
 */
async function closeTab(cdpPort, targetId) {
  try {
    const endpoint = `http://127.0.0.1:${cdpPort}/json/close/${targetId}`;
    let res = await fetch(endpoint, { method: 'PUT' });
    if (res.status === 405) {
      await fetch(endpoint);
    }
  } catch (_) { /* best effort */ }
}

/**
 * 建立到 CDP target 的 WebSocket 连接，返回命令发送器。
 * @param {{id: string, webSocketDebuggerUrl?: string}} target
 * @param {number} cdpPort
 * @returns {Promise<{ws: WebSocket, sendCommand: function, targetId: string}>}
 */
function connectToTarget(target, cdpPort) {
  const wsUrl = target.webSocketDebuggerUrl || `ws://127.0.0.1:${cdpPort}/devtools/page/${target.id}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 0;

    function sendCommand(method, params = {}) {
      return new Promise((res, rej) => {
        const id = ++msgId;
        let done = false;
        const onMessage = (data) => {
          if (done) return;
          const msg = JSON.parse(data.toString());
          if (msg.id === id) {
            done = true;
            ws.removeListener('message', onMessage);
            if (msg.error) rej(new Error(msg.error.message));
            else res(msg.result);
          }
        };
        ws.on('message', onMessage);
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (!done) {
            done = true;
            ws.removeListener('message', onMessage);
            rej(new Error(`CDP command timeout: ${method}`));
          }
        }, 15000);
      });
    }

    ws.on('open', () => resolve({ ws, sendCommand, targetId: target.id }));
    ws.on('error', reject);
    setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        try { ws.close(); } catch (_) { }
        reject(new Error('CDP WebSocket connect timeout'));
      }
    }, 10000);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 主路径：Dashboard 批量"触发一次更新" ─────────────────────────────────────

/**
 * 打开 Tampermonkey Dashboard，全选脚本并通过批量操作下拉框执行"触发一次更新"。
 * Tampermonkey v5.x 的 Dashboard 页面包含批量操作 <select>，其中有"触发一次更新"选项。
 *
 * @param {{cdpPort: number, tampermonkeyExtensionId: string}} config
 * @returns {Promise<{success: boolean, method: string, detail: string}>}
 */
async function triggerTampermonkeyUpdate({ cdpPort, tampermonkeyExtensionId }) {
  if (!tampermonkeyExtensionId) {
    throw new Error('Tampermonkey extension ID not available');
  }

  // Dashboard 是 options.html 的默认视图
  const dashboardUrl = `chrome-extension://${tampermonkeyExtensionId}/options.html`;

  // 复用已打开的 Tampermonkey 选项页，或者新开一个
  const targets = await listCdpTargets(cdpPort);
  let target = targets.find(
    (t) => t.url && t.url.includes(`${tampermonkeyExtensionId}/options.html`) && t.type === 'page'
  );

  const needClose = !target;
  if (!target) {
    target = await openNewTab(cdpPort, dashboardUrl);
    await sleep(3000);
  }

  const { ws, sendCommand, targetId } = await connectToTarget(target, cdpPort);

  try {
    // 在 Dashboard 页面：全选脚本 → 选择"触发一次更新"批量操作
    const result = await sendCommand('Runtime.evaluate', {
      expression: `
        (function () {
          // 步骤 1：找到全选 checkbox 并勾选
          var checkboxes = document.querySelectorAll('input[type="checkbox"]');
          var selectAllBox = null;
          // 全选框通常在表头（<th> 内），或者是第一个 checkbox
          for (var c = 0; c < checkboxes.length; c++) {
            var parent = checkboxes[c].parentElement;
            if (parent && parent.tagName === 'TH') {
              selectAllBox = checkboxes[c];
              break;
            }
          }
          if (!selectAllBox && checkboxes.length > 0) {
            selectAllBox = checkboxes[0];
          }
          if (!selectAllBox) {
            return 'error: no checkbox found on dashboard';
          }
          if (!selectAllBox.checked) {
            selectAllBox.click();
          }

          // 步骤 2：找到批量操作 <select> 并选择"触发一次更新"
          var selects = document.querySelectorAll('select');
          for (var s = 0; s < selects.length; s++) {
            var sel = selects[s];
            for (var o = 0; o < sel.options.length; o++) {
              var optText = sel.options[o].text || '';
              if (
                optText.includes('触发一次更新') ||
                optText.toLowerCase().includes('trigger an update')
              ) {
                sel.selectedIndex = o;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                return 'triggered: ' + optText.trim();
              }
            }
          }

          // 调试：收集 select option 文本
          var optTexts = [];
          for (var i = 0; i < selects.length; i++) {
            for (var j = 0; j < selects[i].options.length; j++) {
              optTexts.push(selects[i].options[j].text.trim());
            }
          }
          return 'error: trigger-option-not-found|options:' + optTexts.join(',').substring(0, 500);
        })()
      `,
      returnByValue: true,
      awaitPromise: false,
    });

    const detail = result?.result?.value || 'no-result';
    if (detail.startsWith('error:')) {
      throw new Error('Dashboard batch update failed: ' + detail);
    }

    // 等待 Tampermonkey 完成更新检查
    await sleep(5000);

    // 取消全选，恢复 Dashboard 状态
    await sendCommand('Runtime.evaluate', {
      expression: `
        (function () {
          var checkboxes = document.querySelectorAll('input[type="checkbox"]');
          for (var c = 0; c < checkboxes.length; c++) {
            if (checkboxes[c].checked) checkboxes[c].click();
          }
          // 重置 select 到默认
          var selects = document.querySelectorAll('select');
          for (var s = 0; s < selects.length; s++) {
            selects[s].selectedIndex = 0;
          }
        })()
      `,
      returnByValue: true,
      awaitPromise: false,
    }).catch(() => { /* best effort cleanup */ });

    return { success: true, method: 'dashboard-batch-update', detail };
  } finally {
    ws.close();
    if (needClose) {
      await closeTab(cdpPort, targetId);
    }
  }
}

// ── 回退路径：导航到 .user.js URL 触发 Tampermonkey 安装流程 ─────────────────

/**
 * 在浏览器中直接导航到脚本的 .user.js URL。
 * Tampermonkey 会拦截该导航并弹出安装/重装页面，然后通过 CDP 点击安装按钮。
 *
 * 这种方式不会创建重复脚本——Tampermonkey 根据 @name + @namespace 识别已有脚本，
 * 对已安装脚本显示"重新安装"而非"安装"。
 *
 * @param {{cdpPort: number, tampermonkeyExtensionId: string, scriptEntry: {name: string, serveUrl: string}}} config
 * @returns {Promise<{success: boolean, method: string, detail: string}>}
 */
async function fallbackInstallUpdate({ cdpPort, tampermonkeyExtensionId, scriptEntry }) {
  if (!tampermonkeyExtensionId) {
    throw new Error('Tampermonkey extension ID not available');
  }

  // 导航到 .user.js URL，Tampermonkey 会拦截并显示安装页面
  const target = await openNewTab(cdpPort, scriptEntry.serveUrl);
  // Tampermonkey 需要时间拦截请求并渲染安装页面
  await sleep(4000);

  // 拦截后，Tampermonkey 会把 tab 重定向到 chrome-extension://<id>/options.html#...
  // 重新查找该 tab（URL 可能已变）
  const targets = await listCdpTargets(cdpPort);
  const installTab = targets.find(
    (t) => t.id === target.id && t.type === 'page'
  ) || target;

  const { ws, sendCommand, targetId } = await connectToTarget(installTab, cdpPort);

  try {
    // 查找并点击"安装"/"重新安装"/"Reinstall"/"Install" 按钮
    const clickResult = await sendCommand('Runtime.evaluate', {
      expression: `
        (function () {
          var keywords = [
            '重新安装', '安装', 'reinstall', 'install', 'update', '更新'
          ];
          var all = document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var text = (el.textContent || el.value || '').trim().toLowerCase();
            if (!text || text.length > 30) continue;
            for (var k = 0; k < keywords.length; k++) {
              if (text === keywords[k] || text.includes(keywords[k])) {
                // 避免点击不相关的小元素；优先点击按钮或可交互元素
                var tagName = el.tagName.toLowerCase();
                if (tagName === 'button' || tagName === 'input' ||
                    el.getAttribute('role') === 'button' ||
                    el.classList.contains('btn') ||
                    el.style.cursor === 'pointer' ||
                    el.onclick) {
                  el.click();
                  return 'clicked: ' + text;
                }
              }
            }
          }
          // 如果精确匹配没找到，宽松查找
          for (var j = 0; j < all.length; j++) {
            var el2 = all[j];
            var text2 = (el2.textContent || el2.value || '').trim().toLowerCase();
            if (text2 && text2.length < 30 && (text2.includes('install') || text2.includes('安装'))) {
              el2.click();
              return 'clicked-loose: ' + text2;
            }
          }
          // 调试信息
          var texts = [];
          var leaves = document.querySelectorAll('*');
          for (var n = 0; n < leaves.length; n++) {
            if (leaves[n].children.length === 0 && leaves[n].textContent.trim()) {
              texts.push(leaves[n].textContent.trim().substring(0, 60));
            }
          }
          return 'install-button-not-found|page-texts:' + texts.join(' /// ').substring(0, 1500);
        })()
      `,
      returnByValue: true,
      awaitPromise: false,
    });

    const detail = clickResult?.result?.value || 'no-result';
    await sleep(2000);

    return {
      success: !detail.startsWith('install-button-not-found'),
      method: 'userjs-install',
      detail,
    };
  } finally {
    ws.close();
    await closeTab(cdpPort, targetId);
  }
}

// ── 统一入口 ─────────────────────────────────────────────────────────────────

/**
 * 尝试更新 Tampermonkey 中的油猴脚本。
 * 主路径：Dashboard 批量"触发一次更新"；失败则回退到逐脚本 .user.js 安装流程。
 *
 * @param {{cdpPort: number, tampermonkeyExtensionId: string}} config
 * @returns {Promise<{ok: boolean, results: Array}>}
 */
async function updateScripts(config) {
  const { cdpPort, tampermonkeyExtensionId } = config;
  const results = [];

  // 主路径：Dashboard 批量触发更新
  try {
    const result = await triggerTampermonkeyUpdate({ cdpPort, tampermonkeyExtensionId });
    results.push(result);
    console.log(`[script-updater] 主路径成功: ${result.detail}`);
    return { ok: true, results };
  } catch (primaryError) {
    console.error(`[script-updater] 主路径失败: ${primaryError.message}`);
    console.log('[script-updater] 回退到 .user.js 安装流程...');
  }

  // 回退路径：逐脚本通过 .user.js URL 触发安装/重装
  for (const entry of USERSCRIPT_MANIFEST) {
    try {
      const result = await fallbackInstallUpdate({
        cdpPort,
        tampermonkeyExtensionId,
        scriptEntry: entry,
      });
      results.push({ ...result, script: entry.name });
      console.log(`[script-updater] 回退${result.success ? '成功' : '失败'} (${entry.name}): ${result.detail}`);
    } catch (fallbackError) {
      console.error(`[script-updater] 回退失败 (${entry.name}): ${fallbackError.message}`);
      results.push({ success: false, method: 'userjs-install', script: entry.name, error: fallbackError.message });
    }
  }

  return { ok: results.some((r) => r.success), results };
}

module.exports = { updateScripts, triggerTampermonkeyUpdate, fallbackInstallUpdate, USERSCRIPT_MANIFEST };
