// @ts-nocheck
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Configuration ───────────────────────────────────────────────────────────

const AUTH_USERNAME = 'ail504';
const AUTH_PASSWORD_HASH = crypto.createHash('sha256').update('QWERqwer12!').digest('hex');
const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = 'tf_auth';
const MAX_CAPTCHA_ATTEMPTS = 3;
const CAPTCHA_TTL_MS = 5 * 60 * 1000; // 5 min

// ── Persistent signing secret ───────────────────────────────────────────────
// Stored in a file so tokens survive server restarts (7-day sessions).

const SECRET_PATH = path.join(__dirname, '.auth_secret');
let AUTH_SECRET;
try {
  AUTH_SECRET = fs.readFileSync(SECRET_PATH, 'utf-8').trim();
} catch {
  AUTH_SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_PATH, AUTH_SECRET, { mode: 0o600 });
}

// ── Captcha Store ───────────────────────────────────────────────────────────

const captchaStore = new Map();

function cleanupCaptchas() {
  const now = Date.now();
  for (const [key, val] of captchaStore) {
    if (val.expiresAt < now) captchaStore.delete(key);
  }
}

function generateCaptcha() {
  cleanupCaptchas();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let text = '';
  for (let i = 0; i < 4; i++) {
    text += chars[Math.floor(Math.random() * chars.length)];
  }
  const id = crypto.randomBytes(16).toString('hex');
  captchaStore.set(id, {
    answer: text.toLowerCase(),
    attempts: 0,
    expiresAt: Date.now() + CAPTCHA_TTL_MS,
  });
  return { id, svg: renderCaptchaSvg(text) };
}

function verifyCaptcha(id, answer) {
  const entry = captchaStore.get(id);
  if (!entry || entry.expiresAt < Date.now()) {
    captchaStore.delete(id);
    return { valid: false, expired: true, attemptsLeft: 0 };
  }
  entry.attempts++;
  if (entry.answer === (answer || '').toLowerCase().trim()) {
    captchaStore.delete(id);
    return { valid: true, expired: false, attemptsLeft: MAX_CAPTCHA_ATTEMPTS - entry.attempts };
  }
  const left = MAX_CAPTCHA_ATTEMPTS - entry.attempts;
  if (left <= 0) captchaStore.delete(id);
  return { valid: false, expired: false, attemptsLeft: Math.max(0, left) };
}

// ── Captcha SVG ─────────────────────────────────────────────────────────────

function renderCaptchaSvg(text) {
  const W = 150, H = 50;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`];
  parts.push(`<rect width="100%" height="100%" fill="#1a1a2e"/>`);

  // Noise lines
  for (let i = 0; i < 6; i++) {
    const x1 = Math.random() * W, y1 = Math.random() * H;
    const x2 = Math.random() * W, y2 = Math.random() * H;
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(255,255,255,0.08)" stroke-width="${1 + Math.random()}"/>`);
  }

  // Characters
  const cw = W / (text.length + 1);
  const colors = ['#f0c020', '#ffdd57', '#e8b800', '#ffd700'];
  for (let i = 0; i < text.length; i++) {
    const x = cw * (i + 0.7) + Math.random() * 8 - 4;
    const y = H / 2 + 7 + Math.random() * 8 - 4;
    const rot = Math.random() * 30 - 15;
    const size = 22 + Math.random() * 6;
    parts.push(
      `<text x="${x}" y="${y}" font-size="${size}" font-family="monospace" font-weight="bold" ` +
      `fill="${colors[i % colors.length]}" transform="rotate(${rot},${x},${y})">${text[i]}</text>`
    );
  }

  // Noise dots
  for (let i = 0; i < 40; i++) {
    parts.push(`<circle cx="${Math.random() * W}" cy="${Math.random() * H}" r="${Math.random() * 1.5 + 0.3}" fill="rgba(255,255,255,0.1)"/>`);
  }

  // Noise curves
  for (let i = 0; i < 3; i++) {
    const [x0, y0] = [Math.random() * W, Math.random() * H];
    const [cx, cy] = [Math.random() * W, Math.random() * H];
    const [x1, y1] = [Math.random() * W, Math.random() * H];
    parts.push(`<path d="M${x0},${y0} Q${cx},${cy} ${x1},${y1}" fill="none" stroke="rgba(240,192,32,0.12)" stroke-width="1"/>`);
  }

  parts.push('</svg>');
  return parts.join('');
}

// ── Token Management ────────────────────────────────────────────────────────

function signToken(payload) {
  const data = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ d: data, s: sig })).toString('base64url');
}

function verifyToken(token) {
  try {
    const { d, s } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const expected = crypto.createHmac('sha256', AUTH_SECRET).update(d).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(s, 'hex'), Buffer.from(expected, 'hex'))) return null;
    const payload = JSON.parse(d);
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Cookie Helpers ──────────────────────────────────────────────────────────

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    try { cookies[name] = decodeURIComponent(value); } catch { cookies[name] = value; }
  });
  return cookies;
}

function buildCookieString(token, maxAgeSec) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

// ── Middleware ───────────────────────────────────────────────────────────────

function requireBrowserAuth(req, res, next) {
  // Public auth routes
  if (req.path === '/login' || req.path.startsWith('/auth/')) return next();

  // Real client processes include X-Client-Secret (even if empty); browsers never do.
  if (req.headers['x-client-id'] && 'x-client-secret' in req.headers) return next();

  // Check auth cookie
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (token) {
    // Bind to device: validate User-Agent fingerprint
    const payload = verifyToken(token);
    if (payload) {
      const ua = req.headers['user-agent'] || '';
      const uaHash = crypto.createHash('md5').update(ua).digest('hex').slice(0, 12);
      if (payload.ua === uaHash) return next();
    }
  }

  // Not authenticated
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return res.redirect('/login');
}

// ── Security Headers ────────────────────────────────────────────────────────

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

// ── Route Setup ─────────────────────────────────────────────────────────────

function setupAuthRoutes(app) {
  // GET /auth/captcha
  app.get('/auth/captcha', (_req, res) => {
    const { id, svg } = generateCaptcha();
    res.json({ captchaId: id, svg });
  });

  // POST /auth/login
  app.post('/auth/login', (req, res) => {
    const { username, password, captchaId, captchaAnswer } = req.body || {};

    if (!username || !password || !captchaId || !captchaAnswer) {
      return res.status(400).json({ error: '请填写所有字段' });
    }

    // Verify captcha first
    const cr = verifyCaptcha(captchaId, captchaAnswer);
    if (cr.expired) {
      return res.status(400).json({ error: '验证码已过期，请刷新', needNewCaptcha: true });
    }
    if (!cr.valid) {
      if (cr.attemptsLeft <= 0) {
        return res.status(400).json({ error: '验证码错误次数过多，请刷新', needNewCaptcha: true });
      }
      return res.status(400).json({
        error: `验证码错误，剩余 ${cr.attemptsLeft} 次机会`,
        attemptsLeft: cr.attemptsLeft,
      });
    }

    // Verify credentials
    const pwHash = crypto.createHash('sha256').update(password).digest('hex');
    if (
      username !== AUTH_USERNAME ||
      !crypto.timingSafeEqual(Buffer.from(pwHash, 'hex'), Buffer.from(AUTH_PASSWORD_HASH, 'hex'))
    ) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // Issue token bound to this device (User-Agent fingerprint)
    const ua = req.headers['user-agent'] || '';
    const uaHash = crypto.createHash('md5').update(ua).digest('hex').slice(0, 12);
    const token = signToken({
      user: username,
      ua: uaHash,
      exp: Date.now() + TOKEN_MAX_AGE_MS,
    });

    res.setHeader('Set-Cookie', buildCookieString(token, Math.floor(TOKEN_MAX_AGE_MS / 1000)));
    res.json({ ok: true });
  });

  // POST /auth/logout
  app.post('/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', buildCookieString('', 0));
    res.json({ ok: true });
  });

  // GET /login — serve login page
  app.get('/login', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(LOGIN_PAGE_HTML);
  });
}

// ── Login Page ──────────────────────────────────────────────────────────────

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 - 租赁聚合</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#0d1420;font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#eee}
.box{width:360px;background:linear-gradient(180deg,rgba(20,30,46,.95),rgba(13,20,32,.98));
  border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:40px 32px;
  box-shadow:0 20px 60px rgba(0,0,0,.5)}
.logo{text-align:center;margin-bottom:32px}
.logo-icon{display:inline-flex;width:48px;height:48px;border-radius:14px;
  background:linear-gradient(135deg,#f0c020,#ffdd57);align-items:center;justify-content:center;
  font-size:24px;font-weight:700;color:#111;margin-bottom:12px}
.logo h1{font-size:20px;font-weight:700;background:linear-gradient(135deg,#f0c020,#ffdd57);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.f{margin-bottom:16px}
.f label{display:block;font-size:12px;color:#8098bf;margin-bottom:6px;font-weight:500}
.f input{width:100%;padding:10px 14px;background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.1);border-radius:8px;color:#eee;
  font-size:14px;font-family:inherit;transition:border-color .2s}
.f input:focus{outline:none;border-color:#f0c020}
.cap-row{display:flex;gap:10px;align-items:center}
.cap-row input{flex:1}
.cap-img{cursor:pointer;border-radius:6px;overflow:hidden;flex-shrink:0;height:40px;
  display:flex;align-items:center}
.cap-img svg{height:40px;width:auto}
.cap-hint{font-size:11px;color:#5c7296;margin-top:4px}
.err{background:rgba(220,50,50,.15);border:1px solid rgba(220,50,50,.3);color:#ff6b6b;
  font-size:13px;padding:10px 14px;border-radius:8px;margin-bottom:16px;display:none}
.err.show{display:block}
.btn{width:100%;padding:12px;background:linear-gradient(135deg,#f0c020,#ffdd57);border:none;
  border-radius:8px;color:#111;font-size:15px;font-weight:700;cursor:pointer;
  transition:opacity .2s;font-family:inherit;margin-top:4px}
.btn:hover{opacity:.9}
.btn:disabled{opacity:.5;cursor:not-allowed}
</style>
</head>
<body>
<div class="box">
  <div class="logo"><div class="logo-icon">租</div><h1>租赁聚合</h1></div>
  <div class="err" id="err"></div>
  <div class="f"><label>用户名</label><input id="u" type="text" autocomplete="username" autofocus/></div>
  <div class="f"><label>密码</label><input id="p" type="password" autocomplete="current-password"/></div>
  <div class="f">
    <label>验证码 <span class="cap-hint">(点击图片刷新，共 3 次机会)</span></label>
    <div class="cap-row">
      <input id="c" type="text" maxlength="4" autocomplete="off" placeholder="不区分大小写"/>
      <div class="cap-img" id="ci" title="点击刷新验证码"></div>
    </div>
  </div>
  <button class="btn" id="b">登 录</button>
</div>
<script>
var cid='';
var $e=document.getElementById('err'),
    $ci=document.getElementById('ci'),
    $c=document.getElementById('c'),
    $b=document.getElementById('b');

function lc(){
  fetch('/auth/captcha').then(function(r){return r.json()}).then(function(d){
    cid=d.captchaId; $ci.innerHTML=d.svg; $c.value=''; $c.focus();
  }).catch(function(){show('加载验证码失败')});
}

function show(m){$e.textContent=m;$e.classList.add('show')}
function hide(){$e.classList.remove('show')}

$ci.onclick=lc;

$b.onclick=function(){
  hide(); $b.disabled=true;
  fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:document.getElementById('u').value,
      password:document.getElementById('p').value,captchaId:cid,captchaAnswer:$c.value})
  }).then(function(r){return r.json().then(function(d){return{s:r.status,d:d}})})
  .then(function(r){
    if(r.d.ok){location.href='/';return}
    show(r.d.error||'登录失败');
    if(r.d.needNewCaptcha)lc();
  }).catch(function(){show('网络错误')})
  .finally(function(){$b.disabled=false});
};

document.onkeydown=function(e){if(e.key==='Enter')$b.click()};
lc();
</script>
</body>
</html>`;

module.exports = {
  securityHeaders,
  requireBrowserAuth,
  setupAuthRoutes,
};
