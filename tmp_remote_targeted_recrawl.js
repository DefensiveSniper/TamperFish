const http = require('http');
const WebSocket = require('ws');

const TARGETS = [
  'tbNick_gj6d9',
  '0累珠0',
  'x***2',
  '码匠铺子',
  '孔明科技'
];

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`parse json failed: ${error.message}\n${data}`));
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  const tabs = await getJson('http://127.0.0.1:18800/json/list');
  const tab = tabs.find((item) => typeof item.url === 'string' && item.url.includes('goofish.com/im'));
  if (!tab || !tab.webSocketDebuggerUrl) {
    throw new Error('goofish tab not found');
  }

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();

  function send(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (!msg.id) {
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) {
      return;
    }
    pending.delete(msg.id);
    if (msg.error) {
      entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      return;
    }
    entry.resolve(msg.result);
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  await send('Runtime.enable', {});
  const expression = `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const targets = ${JSON.stringify(TARGETS)};
      const clicked = [];
      const textOf = (node) => (node && node.textContent ? node.textContent.replace(/\s+/g, ' ').trim() : '');
      const candidates = Array.from(document.querySelectorAll('aside *, [class*="sidebar"] *, [class*="session"] *, [data-testid*="session"] *'));
      for (const keyword of targets) {
        const node = candidates.find((item) => textOf(item).includes(keyword));
        if (!node) {
          clicked.push({ keyword, found: false });
          continue;
        }
        const clickable = node.closest('button, a, li, [role="button"], [class*="item"], [class*="session"]') || node;
        clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        clicked.push({ keyword, found: true, text: textOf(clickable).slice(0, 120) });
        await wait(2500);
        window.scrollTo(0, document.body.scrollHeight);
        await wait(1200);
      }
      const runner = window.__tamperfishRunInitialConversationSync;
      if (typeof runner !== 'function') {
        return { ok: false, reason: 'runner-missing', clicked };
      }
      await runner('manual-targeted-recrawl-' + Date.now(), 80);
      return { ok: true, clicked, href: location.href, title: document.title };
    })()
  `;

  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  console.log(JSON.stringify(result.result && result.result.value ? result.result.value : result, null, 2));
  ws.close();
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
