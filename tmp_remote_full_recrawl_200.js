const http = require('http');
const WebSocket = require('ws');

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
  const result = await send('Runtime.evaluate', {
    expression: `(async () => {
      const runner = window.__tamperfishRunInitialConversationSync;
      if (typeof runner !== 'function') {
        return { ok: false, reason: 'runner-missing', href: location.href };
      }
      try {
        await runner('manual-full-recrawl-200-' + Date.now(), 200);
        return { ok: true, href: location.href, title: document.title };
      } catch (error) {
        return {
          ok: false,
          href: location.href,
          title: document.title,
          message: error && error.message ? error.message : String(error),
          stack: error && error.stack ? error.stack : null,
        };
      }
    })()`,
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
