const WebSocket = require('ws');

async function evalInTab(expression) {
  const tabs = await fetch('http://127.0.0.1:18800/json').then((response) => response.json());
  const tab = tabs.find((item) => item.url && item.url.includes('goofish.com/im') && item.type === 'page');
  if (!tab) {
    throw new Error('goofish.com/im tab not found');
  }

  const socket = new WebSocket(tab.webSocketDebuggerUrl || `ws://127.0.0.1:18800/devtools/page/${tab.id}`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  const result = await new Promise((resolve, reject) => {
    const requestId = 1;
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== requestId) {
        return;
      }
      socket.off('message', onMessage);
      if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.text || 'eval error'));
        return;
      }
      resolve(message.result?.result?.value);
    };

    socket.on('message', onMessage);
    socket.send(JSON.stringify({
      id: requestId,
      method: 'Runtime.evaluate',
      params: {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
    }));
  });

  socket.close();
  return result;
}

(async () => {
  const result = await evalInTab(`(() => ({
    href: location.href,
    ready: document.readyState,
    hasRunner: typeof window.__tamperfishRunInitialConversationSync,
    hasPanelRoot: !!document.querySelector('#tamperfish-panel-root'),
    bodyText: document.body ? document.body.innerText.slice(0, 200) : ''
  }))()`);
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
