import json
import urllib.request
import websocket

LIST_URL = 'http://127.0.0.1:18800/json/list'
TARGET_PREFIX = 'https://www.goofish.com/im'

with urllib.request.urlopen(LIST_URL, timeout=5) as resp:
    targets = json.load(resp)

page = next((t for t in targets if t.get('url', '').startswith(TARGET_PREFIX)), None)
if not page:
    raise SystemExit('goofish tab not found')

ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=5)
expression = r'''(() => {
  try {
    const raw = localStorage.getItem('xm_chat_history');
    const data = raw ? JSON.parse(raw) : {};
    return {
      hasLuzhou: Object.prototype.hasOwnProperty.call(data, '庐州美美椰子_910817683819'),
      hasNizai: Object.prototype.hasOwnProperty.call(data, '在吗_1030658100776'),
      hasNick1: Object.prototype.hasOwnProperty.call(data, '你的头真 大_1030658100776'),
      hasNick2: Object.prototype.hasOwnProperty.call(data, '你的头真大_1030658100776'),
      keys: Object.keys(data)
    };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
})()'''
ws.send(json.dumps({
    'id': 1,
    'method': 'Runtime.evaluate',
    'params': {
        'expression': expression,
        'returnByValue': True,
        'awaitPromise': True,
    },
}))
while True:
    message = json.loads(ws.recv())
    if message.get('id') == 1:
        print(json.dumps(message, ensure_ascii=False))
        break
ws.close()
