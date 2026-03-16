#!/usr/bin/env node
/**
 * script_updater.js — 通过 CDP 触发 Tampermonkey 更新本地油猴脚本。
 *
 * 主路径：打开 Tampermonkey 工具页，点击"检查用户脚本更新"按钮。
 * 回退路径：逐脚本打开 Tampermonkey 编辑器页面，通过 CodeMirror 写入内容并保存。
 *
 * 依赖环境变量：
 *   CDP_PORT                   — Chrome 调试端口（默认 18800）
 *   TAMPERMONKEY_EXTENSION_ID  — Tampermonkey 扩展 ID
 */

'use strict';

const { WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');

const USERSCRIPT_MANIFEST = [
  {
    name: 'xianyu_monitor',
    filePath: path.join(__dirname, '..', 'xianyu_capture', 'xianyu_monitor.js'),
  },
  {
    name: 'qianniu_batch_consign',
    filePath: path.join(__dirname, '..', 'qianniu_capture', 'qianniu_batch_consign.js'),
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

// ── 主路径：触发 Tampermonkey 内置"检查更新" ─────────────────────────────────

/**
 * 打开 Tampermonkey 工具页并点击"检查用户脚本更新"。
 * @param {{cdpPort: number, tampermonkeyExtensionId: string}} config
 * @returns {Promise<{success: boolean, method: string, detail: string}>}
 */
async function triggerTampermonkeyUpdate({ cdpPort, tampermonkeyExtensionId }) {
  if (!tampermonkeyExtensionId) {
    throw new Error('Tampermonkey extension ID not available');
  }

  const optionsUrl = `chrome-extension://${tampermonkeyExtensionId}/options.html#nav=utils`;

  // 复用已打开的 Tampermonkey 选项页，或者新开一个
  const targets = await listCdpTargets(cdpPort);
  let target = targets.find(
    (t) => t.url && t.url.includes(`${tampermonkeyExtensionId}/options.html`) && t.type === 'page'
  );

  const needClose = !target;
  if (!target) {
    target = await openNewTab(cdpPort, optionsUrl);
    await sleep(2500);
  }

  const { ws, sendCommand, targetId } = await connectToTarget(target, cdpPort);

  try {
    // 确保在 utils 面板
    await sendCommand('Runtime.evaluate', {
      expression: `window.location.hash = '#nav=utils'`,
      awaitPromise: false,
    });
    await sleep(1500);

    // 查找并点击"检查用户脚本更新"按钮。
    // Tampermonkey 的 UI 由 JS 动态生成，元素类型不固定（可能是 div/span/a/button），
    // 因此遍历所有可见的可点击元素，按文本内容匹配。
    const clickResult = await sendCommand('Runtime.evaluate', {
      expression: `
        (function () {
          var keywords = [
            'check for userscript updates',
            '检查用户脚本更新',
            'check for script updates',
          ];
          var all = document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.children.length > 0) continue;          // 只匹配叶子节点
            var text = (el.textContent || '').trim().toLowerCase();
            if (!text) continue;
            for (var k = 0; k < keywords.length; k++) {
              if (text.includes(keywords[k])) {
                // 点击自身，若无效则冒泡到最近的可点击祖先
                el.click();
                if (el.parentElement && el.parentElement !== document.body) {
                  el.parentElement.click();
                }
                return 'clicked: ' + text.substring(0, 60);
              }
            }
          }
          // 调试：收集页面所有可见文本片段便于排查
          var texts = [];
          var leaves = document.querySelectorAll('*');
          for (var j = 0; j < leaves.length; j++) {
            if (leaves[j].children.length === 0 && leaves[j].textContent.trim()) {
              texts.push(leaves[j].textContent.trim().substring(0, 80));
            }
          }
          return 'button-not-found|page-texts:' + texts.join(' /// ').substring(0, 2000);
        })()
      `,
      returnByValue: true,
      awaitPromise: false,
    });

    const detail = clickResult?.result?.value || 'no-result';
    if (detail.startsWith('button-not-found')) {
      throw new Error('Could not find update button on Tampermonkey utilities page. Debug: ' + detail.substring(0, 500));
    }

    // 等待 Tampermonkey 完成更新检查
    await sleep(4000);

    return { success: true, method: 'tampermonkey-utils', detail };
  } finally {
    ws.close();
    if (needClose) {
      await closeTab(cdpPort, targetId);
    }
  }
}

// ── 回退路径：通过 Tampermonkey 编辑器直接写入脚本 ───────────────────────────

/**
 * 通过 CDP 打开 Tampermonkey 编辑器页面，将本地脚本内容写入 CodeMirror 并保存。
 * @param {{cdpPort: number, tampermonkeyExtensionId: string, scriptFilePath: string}} config
 * @returns {Promise<{success: boolean, method: string, detail: string}>}
 */
async function fallbackEditorUpdate({ cdpPort, tampermonkeyExtensionId, scriptFilePath }) {
  if (!tampermonkeyExtensionId) {
    throw new Error('Tampermonkey extension ID not available');
  }
  if (!fs.existsSync(scriptFilePath)) {
    throw new Error(`Script file not found: ${scriptFilePath}`);
  }

  const scriptContent = fs.readFileSync(scriptFilePath, 'utf8');
  const editorUrl = `chrome-extension://${tampermonkeyExtensionId}/options.html#nav=new-user-script`;

  const target = await openNewTab(cdpPort, editorUrl);
  await sleep(3500); // CodeMirror 需要更多初始化时间

  const { ws, sendCommand, targetId } = await connectToTarget(target, cdpPort);

  try {
    const escaped = JSON.stringify(scriptContent);

    // 写入 CodeMirror（Tampermonkey 目前使用 CM5）
    const setResult = await sendCommand('Runtime.evaluate', {
      expression: `
        (function () {
          var cmEl = document.querySelector('.CodeMirror');
          if (cmEl && cmEl.CodeMirror) {
            cmEl.CodeMirror.setValue(${escaped});
            return 'value-set-cm5';
          }
          // CM6 fallback
          var cm6 = document.querySelector('.cm-editor');
          if (cm6 && cm6.cmView && cm6.cmView.view) {
            var view = cm6.cmView.view;
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: ${escaped} },
            });
            return 'value-set-cm6';
          }
          return 'codemirror-not-found';
        })()
      `,
      returnByValue: true,
      awaitPromise: false,
    });

    const setDetail = setResult?.result?.value;
    if (setDetail === 'codemirror-not-found') {
      throw new Error('CodeMirror editor not found on Tampermonkey new-script page');
    }

    await sleep(500);

    // 触发保存：依次尝试多种方式
    const saveResult = await sendCommand('Runtime.evaluate', {
      expression: `
        (function () {
          // 方式 1：点击保存按钮（遍历所有叶子节点匹配文本）
          var saveKeywords = ['save', '保存'];
          var all = document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var text = (el.textContent || el.value || '').trim().toLowerCase();
            // 精确匹配短文本避免误触（如匹配到 "save as" 之类的长文本也可以）
            if (text && text.length < 30) {
              for (var k = 0; k < saveKeywords.length; k++) {
                if (text === saveKeywords[k] || text === saveKeywords[k] + '...') {
                  el.click();
                  if (el.parentElement) el.parentElement.click();
                  return 'clicked-save: ' + text;
                }
              }
            }
          }

          // 方式 2：通过 CodeMirror API 触发保存
          var cmEl = document.querySelector('.CodeMirror');
          var cm = cmEl && cmEl.CodeMirror;
          if (cm) {
            // CM5 的 save() 方法（Tampermonkey 可能通过 extraKeys 注册了 Ctrl-S）
            if (typeof cm.save === 'function') {
              cm.save();
              return 'cm-save';
            }

            // 在 CM 的 input 元素上模拟 Ctrl+S（CM 监听自己的 textarea）
            var inputField = cm.getInputField();
            if (inputField) {
              var evt = new KeyboardEvent('keydown', {
                key: 's', code: 'KeyS', keyCode: 83,
                ctrlKey: true, metaKey: false,
                bubbles: true, cancelable: true,
              });
              inputField.dispatchEvent(evt);
              return 'cm-input-ctrl-s';
            }
          }

          // 方式 3：在 document 上兜底（最后手段）
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 's', code: 'KeyS', keyCode: 83,
            ctrlKey: true, bubbles: true, cancelable: true,
          }));
          return 'document-ctrl-s';
        })()
      `,
      returnByValue: true,
      awaitPromise: false,
    });

    await sleep(2000);

    return {
      success: true,
      method: 'editor-fallback',
      detail: `${setDetail} → ${saveResult?.result?.value}`,
    };
  } finally {
    ws.close();
    await closeTab(cdpPort, targetId);
  }
}

// ── 统一入口 ─────────────────────────────────────────────────────────────────

/**
 * 尝试更新 Tampermonkey 中的油猴脚本。
 * 主路径：触发"检查更新"按钮；失败则回退到逐脚本编辑器自动化。
 *
 * @param {{cdpPort: number, tampermonkeyExtensionId: string}} config
 * @returns {Promise<{ok: boolean, results: Array}>}
 */
async function updateScripts(config) {
  const { cdpPort, tampermonkeyExtensionId } = config;
  const results = [];

  // 主路径
  try {
    const result = await triggerTampermonkeyUpdate({ cdpPort, tampermonkeyExtensionId });
    results.push(result);
    console.log(`[script-updater] 主路径成功: ${result.detail}`);
    return { ok: true, results };
  } catch (primaryError) {
    console.error(`[script-updater] 主路径失败: ${primaryError.message}`);
    console.log('[script-updater] 回退到编辑器自动化...');
  }

  // 回退路径：逐脚本写入
  for (const entry of USERSCRIPT_MANIFEST) {
    try {
      const result = await fallbackEditorUpdate({
        cdpPort,
        tampermonkeyExtensionId,
        scriptFilePath: entry.filePath,
      });
      results.push({ ...result, script: entry.name });
      console.log(`[script-updater] 回退成功 (${entry.name}): ${result.detail}`);
    } catch (fallbackError) {
      console.error(`[script-updater] 回退失败 (${entry.name}): ${fallbackError.message}`);
      results.push({ success: false, method: 'editor-fallback', script: entry.name, error: fallbackError.message });
    }
  }

  return { ok: results.some((r) => r.success), results };
}

module.exports = { updateScripts, triggerTampermonkeyUpdate, fallbackEditorUpdate, USERSCRIPT_MANIFEST };
