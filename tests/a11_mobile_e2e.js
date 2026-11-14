/**
 * tests/a11_mobile_e2e.js
 * Zero-dependency E2E suite for A11 countdown, device routing, auth, outbox sync,
 * iframe teardown, and standalone full-screen mobile math games (328/2/4-mobile.html).
 *
 * Uses Node 24 built-in WebSocket + /usr/bin/chromium CDP directly.
 * Usage:
 *   CHROME=/usr/bin/chromium node tests/a11_mobile_e2e.js
 *   CHROME=/usr/bin/chromium A11_SCREENSHOT_DIR=/tmp/a11_screenshots node tests/a11_mobile_e2e.js
 *   node tests/a11_mobile_e2e.js --screenshots /tmp/a11_screenshots
 */
'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ui = require('../core/ui.js');

const ROOT = path.resolve(__dirname, '..');
const CHROME_BIN = process.env.CHROME || '/usr/bin/chromium';

function resolveScreenshotDir() {
  let dir = process.env.A11_SCREENSHOT_DIR || '';
  const idx = process.argv.indexOf('--screenshots');
  if (idx !== -1 && process.argv[idx + 1]) dir = process.argv[idx + 1];
  if (dir) {
    dir = path.resolve(dir);
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

const SCREENSHOT_DIR = resolveScreenshotDir();

const STUDENT_4C7 = {
  classID: '4C',
  studentID: '7',
  name: '測試同學',
  role: 'student',
  token: 'tok-e2e-4c7',
  signingKey: 'key-e2e-4c7',
};

const STUDENT_SEAT98 = {
  classID: '4D',
  studentID: '98',
  name: '教師測試員',
  role: 'teacher_test',
  directToBank: true,
  token: 'tok-e2e-98',
  signingKey: 'key-e2e-98',
};

const CLASS_REP_4C1 = {
  classID: '4C',
  studentID: '1',
  name: '科代表',
  role: 'class_rep',
  token: 'tok-e2e-rep',
  signingKey: 'key-e2e-rep',
};

const DEVICE_PROFILES = [
  // Phones (9 profiles -> isPhoneDevice === true + top-level mobile port)
  {
    label: 'iPhone SE1 (320x568)',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
    width: 320, height: 568, screenW: 320, screenH: 568, dpr: 2, mobile: true, maxTouch: 5, coarse: true, wantPhone: true,
  },
  {
    label: 'iPhone SE2 (375x667)',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    width: 375, height: 667, screenW: 375, screenH: 667, dpr: 2, mobile: true, maxTouch: 5, coarse: true, wantPhone: true,
  },
  {
    label: 'iPhone 14 (390x844)',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    width: 390, height: 844, screenW: 390, screenH: 844, dpr: 3, mobile: true, maxTouch: 5, coarse: true, wantPhone: true,
  },
  {
    label: 'iPhone Request Desktop Website',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    width: 390, height: 844, screenW: 390, screenH: 844, dpr: 3, mobile: true, maxTouch: 5, coarse: true, wantPhone: true,
  },
  {
    label: 'iPod touch',
    ua: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
    width: 320, height: 568, screenW: 320, screenH: 568, dpr: 2, mobile: true, maxTouch: 5, coarse: true, wantPhone: true,
  },
  {
    label: 'Android Mobile (Pixel 8)',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    width: 412, height: 915, screenW: 412, screenH: 915, dpr: 2.625, mobile: true, maxTouch: 5, coarse: true, wantPhone: true,
  },
  {
    label: 'Android Desktop site',
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    width: 412, height: 915, screenW: 412, screenH: 915, dpr: 2.625, mobile: true, maxTouch: 5, coarse: true, wantPhone: true,
  },
  {
    label: 'HarmonyOS Phone',
    ua: 'Mozilla/5.0 (HarmonyOS 4.0; Phone; ALN-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    width: 384, height: 854, screenW: 384, screenH: 854, dpr: 2, mobile: true, maxTouch: 5, coarse: true, wantPhone: true,
  },
  {
    label: 'Windows Phone',
    ua: 'Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; Lumia 950) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.116 Mobile Safari/537.36 Edge/15.15254',
    width: 360, height: 640, screenW: 360, screenH: 640, dpr: 2, mobile: true, maxTouch: 5, coarse: true, wantPhone: true,
  },
  // Non-phones (6 profiles -> isPhoneDevice === false + #gameIframe retained)
  {
    label: 'iPad Safari',
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    width: 820, height: 1180, screenW: 820, screenH: 1180, dpr: 2, mobile: true, maxTouch: 5, coarse: true, wantPhone: false,
  },
  {
    label: 'iPadOS Desktop-mode',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    width: 820, height: 1180, screenW: 820, screenH: 1180, dpr: 2, mobile: true, maxTouch: 5, coarse: true, wantPhone: false,
  },
  {
    label: 'iPad mini',
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    width: 744, height: 1133, screenW: 744, screenH: 1133, dpr: 2, mobile: true, maxTouch: 5, coarse: true, wantPhone: false,
  },
  {
    label: 'Android Tablet (SM-X710)',
    ua: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    width: 800, height: 1280, screenW: 800, screenH: 1280, dpr: 2, mobile: false, maxTouch: 5, coarse: true, wantPhone: false,
  },
  {
    label: 'macOS Desktop',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    width: 1440, height: 900, screenW: 1440, screenH: 900, dpr: 1, mobile: false, maxTouch: 0, coarse: false, wantPhone: false,
  },
  {
    label: 'Narrow touch laptop',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    width: 480, height: 800, screenW: 1920, screenH: 1080, dpr: 1, mobile: false, maxTouch: 10, coarse: false, wantPhone: false,
  },
];

const PHONE_VIEWPORTS = [
  { label: '320x568', width: 320, height: 568, dpr: 2 },
  { label: '375x667', width: 375, height: 667, dpr: 2 },
  { label: '390x844', width: 390, height: 844, dpr: 3 },
  { label: '844x390', width: 844, height: 390, dpr: 3 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serveStatic() {
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };
  const srv = http.createServer((req, res) => {
    const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = rawPath === '/' ? 'app.html' : rawPath.replace(/^\/+/, '');
    const full = path.resolve(ROOT, rel);
    if (!full.startsWith(ROOT + path.sep) && full !== ROOT) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

class CdpBrowser {
  constructor(proc, ws, userDataDir) {
    this.proc = proc;
    this.ws = ws;
    this.userDataDir = userDataDir;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.contexts = new Set();

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
          else entry.resolve(msg.result || {});
        }
        return;
      }
      const key = `${msg.sessionId || ''}:${msg.method}`;
      const list = this.eventHandlers.get(key);
      if (list) {
        for (const fn of list) {
          try { fn(msg.params || {}); } catch (e) {}
        }
      }
    });

    ws.addEventListener('close', () => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error('CDP WebSocket closed'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(sessionId, method, fn) {
    const key = `${sessionId || ''}:${method}`;
    if (!this.eventHandlers.has(key)) this.eventHandlers.set(key, new Set());
    this.eventHandlers.get(key).add(fn);
    return () => {
      const set = this.eventHandlers.get(key);
      if (set) set.delete(fn);
    };
  }

  async newPage(baseUrl, dev) {
    const { browserContextId } = await this.send('Target.createBrowserContext');
    this.contexts.add(browserContextId);
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new CdpPage(this, baseUrl, browserContextId, targetId, sessionId);
    await page._init(dev);
    return page;
  }

  async close() {
    for (const ctxId of this.contexts) {
      try { await this.send('Target.disposeBrowserContext', { browserContextId: ctxId }); } catch (e) {}
    }
    this.contexts.clear();
    try { this.ws.close(); } catch (e) {}
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      await Promise.race([
        new Promise((r) => this.proc.once('exit', r)),
        sleep(1500).then(() => { try { this.proc.kill('SIGKILL'); } catch (e) {} }),
      ]);
    }
    try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch (e) {}
  }
}

class CdpPage {
  constructor(browser, baseUrl, browserContextId, targetId, sessionId) {
    this.browser = browser;
    this.baseUrl = baseUrl;
    this.browserContextId = browserContextId;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this._errors = [];
    this._dialogs = [];
    this._blockedUrls = [];
    this._envScriptId = null;
  }

  send(method, params = {}) {
    return this.browser.send(method, params, this.sessionId);
  }

  on(method, fn) {
    return this.browser.on(this.sessionId, method, fn);
  }

  async _init(dev) {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('DOM.enable');
    await this.send('Fetch.enable', {
      patterns: [{ urlPattern: 'http*' }, { urlPattern: 'https*' }],
    });

    this.on('Fetch.requestPaused', (p) => {
      const url = (p.request && p.request.url) || '';
      if (url.startsWith(this.baseUrl)) {
        this.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      } else {
        this._blockedUrls.push(url);
        this.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      }
    });

    this.on('Page.javascriptDialogOpening', (p) => {
      this._dialogs.push(p.message || '');
      this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });

    this.on('Runtime.exceptionThrown', (p) => {
      const det = p.exceptionDetails || {};
      const msg = (det.exception && det.exception.description) || det.text || 'Runtime exception';
      this._errors.push(String(msg));
    });

    if (dev) await this.setDevice(dev);
  }

  async setDevice(dev) {
    if (this._envScriptId) {
      try { await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this._envScriptId }); } catch (e) {}
      this._envScriptId = null;
    }
    await this.send('Emulation.setUserAgentOverride', { userAgent: dev.ua });
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: dev.width,
      height: dev.height,
      deviceScaleFactor: dev.dpr || 1,
      mobile: !!dev.mobile,
      screenWidth: dev.screenW || dev.width,
      screenHeight: dev.screenH || dev.height,
    });
    await this.send('Emulation.setTouchEmulationEnabled', (dev.maxTouch || 0) > 0
      ? { enabled: true, maxTouchPoints: dev.maxTouch }
      : { enabled: false });
    // Hardware properties (maxTouchPoints & pointer:coarse) are not set by Linux headless without a physical touchscreen.
    const maxTouch = Number(dev.maxTouch || 0);
    const coarse = !!dev.coarse;
    const { identifier } = await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        try { Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => ${maxTouch} }); } catch (e) {}
        try {
          const origMM = window.matchMedia ? window.matchMedia.bind(window) : null;
          window.matchMedia = function (q) {
            if (typeof q === 'string' && /pointer\\s*:\\s*coarse/i.test(q)) {
              return { matches: ${coarse}, media: q, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){ return false; } };
            }
            return origMM ? origMM(q) : { matches: false, media: q, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){ return false; } };
          };
        } catch (e) {}
      })();`,
    });
    this._envScriptId = identifier;
  }

  async goto(url, timeoutMs = 15000) {
    let loaded = false;
    const off = this.on('Page.loadEventFired', () => { loaded = true; });
    try {
      const nav = await this.send('Page.navigate', { url });
      if (nav.errorText) throw new Error(`Navigation failed (${url}): ${nav.errorText}`);
      const deadline = Date.now() + timeoutMs;
      while (!loaded && Date.now() < deadline) {
        await sleep(30);
      }
      await this.waitFor(() => document.readyState === 'interactive' || document.readyState === 'complete', 5000);
    } finally {
      off();
    }
  }

  async eval(fn, ...args) {
    const argList = args.map((a) => JSON.stringify(a)).join(', ');
    const expression = `(${fn.toString()})(${argList})`;
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const desc = (res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text || 'Eval error';
      throw new Error(desc);
    }
    return res.result ? res.result.value : undefined;
  }

  async waitFor(fn, timeoutMs = 10000, ...args) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        const val = await this.eval(fn, ...args);
        if (val) return val;
      } catch (e) {
        lastErr = e;
      }
      await sleep(60);
    }
    throw new Error(`waitFor timeout (${timeoutMs}ms): ${fn.toString().slice(0, 120)}${lastErr ? ' | ' + lastErr.message : ''}`);
  }

  async waitForUrl(predicate, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await this.eval(() => ({ href: location.href, rs: document.readyState }));
        if (state && (state.rs === 'interactive' || state.rs === 'complete') && predicate(state.href)) {
          return state.href;
        }
      } catch (e) {}
      await sleep(60);
    }
    const cur = await this.eval(() => location.href).catch(() => '<unknown>');
    throw new Error(`waitForUrl timeout (${timeoutMs}ms), current url=${cur}`);
  }

  async mouseClickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(30);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async clickSelector(sel) {
    const pt = await this.eval((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }, sel);
    assert.ok(pt && pt.w > 0 && pt.h > 0, `Selector not clickable/visible: ${sel}`);
    await this.mouseClickAt(pt.x, pt.y);
  }

  async drag(x1, y1, x2, y2, steps = 8) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = x1 + ((x2 - x1) * i) / steps;
      const y = y1 + ((y2 - y1) * i) / steps;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' });
      await sleep(15);
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
  }

  async url() {
    return this.eval(() => location.href);
  }

  async screenshot(name) {
    if (!SCREENSHOT_DIR) return;
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const outPath = path.join(SCREENSHOT_DIR, `${name}.png`);
    fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
  }

  async close() {
    try { await this.send('Target.closeTarget', { targetId: this.targetId }); } catch (e) {}
    try { await this.browser.send('Target.disposeBrowserContext', { browserContextId: this.browserContextId }); } catch (e) {}
    this.browser.contexts.delete(this.browserContextId);
  }
}

async function launchChrome() {
  if (!fs.existsSync(CHROME_BIN)) {
    throw new Error(`Chromium binary not found at ${CHROME_BIN}`);
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11-e2e-'));
  const proc = spawn(CHROME_BIN, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + userDataDir,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`Chromium DevTools timeout; stderr=${buf}`)), 15000);
    proc.stderr.on('data', (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited early (${code}): ${buf}`));
    });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (e) => reject(new Error('WebSocket error: ' + (e.message || 'unknown'))), { once: true });
  });
  return new CdpBrowser(proc, ws, userDataDir);
}

async function seedStorage(page, base, { session = STUDENT_4C7, usedMs = null, clearAll = true } = {}) {
  await page.goto(`${base}/games/mobile-shell.css`);
  await page.eval((stu, used, clear) => {
    if (clear) localStorage.clear();
    if (stu) localStorage.setItem('MP_V2_SESSION', JSON.stringify(stu));
    else localStorage.removeItem('MP_V2_SESSION');
    if (used != null && stu) {
      const sid = stu.classID + '_' + stu.studentID;
      // Match MathCoreBonus.GameBridge._timeKey(sid) Macau date key format
      const d = new Date(Date.now() + 8 * 3600 * 1000);
      const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      const key = `MP_V2_GAME_TIME_${sid.toUpperCase()}_${dateStr}`;
      localStorage.setItem(key, JSON.stringify({ usedMs: used, redeemedExtraMs: 0 }));
    }
  }, session, usedMs, clearAll);
}

// =========================================================================
// Test Group 1: Device detection (15 profiles unit + live app.html routing)
// =========================================================================
function testUnitDeviceMatrix() {
  for (const d of DEVICE_PROFILES) {
    const minScreen = Math.min(d.screenW, d.screenH);
    const got = ui.isPhoneDevice({
      ua: d.ua,
      maxTouch: d.maxTouch,
      minScreen,
      coarsePointer: d.coarse,
    });
    assert.strictEqual(got, d.wantPhone, `unit isPhoneDevice mismatch for ${d.label}`);
  }
  console.log(`[PASS] Unit isPhoneDevice matrix (${DEVICE_PROFILES.length}/15 profiles)`);
}

async function testLiveDeviceRouting(browser, base) {
  for (const d of DEVICE_PROFILES) {
    const page = await browser.newPage(base, d);
    try {
      await seedStorage(page, base, { session: STUDENT_4C7 });
      await page.goto(`${base}/app.html?screen=games`);
      await page.waitFor(() => window.AppUI && document.querySelector('#gameCardsRow button[data-gid="bash-nim"]'), 12000);

      const detected = await page.eval(() => window.MathCoreUI.isPhoneDevice());
      assert.strictEqual(detected, d.wantPhone, `live isPhoneDevice mismatch on ${d.label}`);

      await page.clickSelector('#gameCardsRow button[data-gid="bash-nim"]');
      if (d.wantPhone) {
        const targetUrl = await page.waitForUrl((u) => u.includes('/games/2-mobile.html') && u.includes('gameId=bash-nim'), 10000);
        assert.ok(targetUrl.includes('/games/2-mobile.html'), `${d.label} should navigate top-level to 2-mobile.html`);
      } else {
        await page.waitFor(() => {
          const w = document.getElementById('gameIframeWrap');
          return w && !w.classList.contains('d-none');
        }, 6000);
        const info = await page.eval(() => ({
          url: location.href,
          src: document.getElementById('gameIframe').getAttribute('src'),
        }));
        assert.ok(info.url.includes('/app.html'), `${d.label} stays on app.html`);
        assert.strictEqual(info.src, 'games/2.HTML', `${d.label} embeds games/2.HTML`);
      }
      assert.deepStrictEqual(page._errors, [], `no errors during routing on ${d.label}`);
    } finally {
      await page.close();
    }
  }

  // Also verify phone (390x844) routes all 3 games to their respective mobile ports
  const iPhone14 = DEVICE_PROFILES.find((p) => p.label === 'iPhone 14 (390x844)');
  const phone = await browser.newPage(base, iPhone14);
  try {
    await seedStorage(phone, base, { session: STUDENT_4C7 });
    for (const [gid, mobileFile] of [['trig-ratio', '328-mobile.html'], ['bash-nim', '2-mobile.html'], ['ring-nim', '4-mobile.html']]) {
      await phone.goto(`${base}/app.html?screen=games`);
      await phone.waitFor((g) => document.querySelector(`#gameCardsRow button[data-gid="${g}"]`), 12000, gid);
      if (gid === 'trig-ratio') await phone.screenshot('mobile_390x844_games_hall');
      await phone.clickSelector(`#gameCardsRow button[data-gid="${gid}"]`);
      const navUrl = await phone.waitForUrl((u) => u.includes('/games/' + mobileFile) && u.includes('gameId=' + gid), 10000);
      assert.ok(navUrl.includes('/games/' + mobileFile), `phone routed ${gid} -> ${mobileFile}`);
    }
    assert.deepStrictEqual(phone._errors, [], 'no errors routing all 3 games on phone');
  } finally {
    await phone.close();
  }
  console.log(`[PASS] Live app.html routing matrix (${DEVICE_PROFILES.length}/15 profiles + all 3 phone ports)`);
}

// =========================================================================
// Test Group 2: Auth Guard & Return Routing (Unauth, class_rep, 4C_7, Seat 98)
// =========================================================================
async function testAuthGuardAndReturnRouting(browser, base) {
  const iPhone14 = DEVICE_PROFILES.find((p) => p.label === 'iPhone 14 (390x844)');
  const mobilePages = ['328-mobile.html', '2-mobile.html', '4-mobile.html'];

  // 2a. Unauthenticated & class_rep blocked on all 3 mobile games
  for (const sessLabel of ['unauthenticated', 'class_rep']) {
    const sess = sessLabel === 'class_rep' ? CLASS_REP_4C1 : null;
    for (const file of mobilePages) {
      const page = await browser.newPage(base, iPhone14);
      try {
        await seedStorage(page, base, { session: sess });
        await page.goto(`${base}/games/${file}`);
        await page.waitFor(() => !!document.getElementById('mgs-auth-gate'), 8000);
        const check = await page.eval(() => {
          const gate = document.getElementById('mgs-auth-gate');
          const r = gate.getBoundingClientRect();
          const stu = window.MobileGameShell ? window.MobileGameShell.getStudent() : 'NO_SHELL';
          try { if (typeof window.startGame === 'function') window.startGame(); } catch (e) {}
          const mainHidden = document.getElementById('main-wrapper').classList.contains('hidden');
          return { visible: r.width > 0 && r.height > 0, stu, mainHidden };
        });
        assert.strictEqual(check.visible, true, `${file} shows #mgs-auth-gate for ${sessLabel}`);
        assert.strictEqual(check.stu, null, `${file} getStudent() === null for ${sessLabel}`);
        assert.strictEqual(check.mainHidden, true, `${file} blocks startGame() for ${sessLabel}`);
      } finally {
        await page.close();
      }
    }
  }

  // 2b. Regular student (4C_7) & Seat 98 teacher_test (4D_98) ?screen=games and ?screen=points routing & URL cleanup
  for (const stu of [STUDENT_4C7, STUDENT_SEAT98]) {
    for (const [param, screenId] of [['games', 'screen-games'], ['points', 'screen-points']]) {
      const page = await browser.newPage(base, iPhone14);
      try {
        await seedStorage(page, base, { session: stu });
        await page.goto(`${base}/app.html?screen=${param}`);
        await page.waitFor((sid) => {
          const el = document.getElementById(sid);
          return window.AppUI && el && el.classList.contains('active');
        }, 12000, screenId);
        const state = await page.eval((sid) => ({
          url: location.href,
          active: document.getElementById(sid).classList.contains('active'),
          bankActive: document.getElementById('screen-practice-select')
            ? document.getElementById('screen-practice-select').classList.contains('active')
            : false,
        }), screenId);
        assert.strictEqual(state.active, true, `${stu.role} ?screen=${param} activates ${screenId}`);
        assert.strictEqual(state.bankActive, false, `${stu.role} ?screen=${param} does not hijack to practice selector`);
        assert.ok(!state.url.includes('screen='), `${stu.role} ?screen=${param} cleans URL query param (${state.url})`);
      } finally {
        await page.close();
      }
    }
  }

  console.log('[PASS] Auth guard (unauth + class_rep across 3 games) & deep-link routing (4C_7 + Seat 98)');
}

// =========================================================================
// Test Group 3: Desktop (1280x800) & iPad (820x1180) Iframe Countdown, Teardown & Outbox
// =========================================================================
async function testDesktopAndIpadIframe(browser, base) {
  const profiles = [
    {
      label: 'Desktop 1280x800',
      ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      width: 1280, height: 800, screenW: 1280, screenH: 800, dpr: 1, mobile: false, maxTouch: 0, coarse: false,
      shot: 'desktop_1280x800_iframe',
    },
    {
      label: 'iPad 820x1180',
      ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      width: 820, height: 1180, screenW: 820, screenH: 1180, dpr: 2, mobile: true, maxTouch: 5, coarse: true,
      shot: 'ipad_820x1180_iframe',
    },
  ];

  for (const prof of profiles) {
    const page = await browser.newPage(base, prof);
    try {
      await seedStorage(page, base, { session: STUDENT_4C7, usedMs: 0 });
      await page.goto(`${base}/app.html?screen=games`);
      await page.waitFor(() => window.AppUI && document.querySelector('#gameCardsRow button[data-gid="bash-nim"]'), 12000);

      // Launch game in iframe
      await page.clickSelector('#gameCardsRow button[data-gid="bash-nim"]');
      await page.waitFor(() => {
        const w = document.getElementById('gameIframeWrap');
        const f = document.getElementById('gameIframe');
        return w && !w.classList.contains('d-none') && f && f.contentWindow && f.contentWindow.document.readyState === 'complete';
      }, 10000);

      // Live badge countdown ticking
      const b1 = await page.eval(() => {
        const el = document.getElementById('gameIframePlaytimeBadge');
        const r = el.getBoundingClientRect();
        return { text: el.textContent, visible: r.width > 0 && r.height > 0 };
      });
      assert.strictEqual(b1.visible, true, `${prof.label} #gameIframePlaytimeBadge visible`);
      await sleep(2300);
      const b2 = await page.eval(() => document.getElementById('gameIframePlaytimeBadge').textContent);
      assert.notStrictEqual(b1.text, b2, `${prof.label} #gameIframePlaytimeBadge ticks (${b1.text} -> ${b2})`);
      await page.screenshot(prof.shot);

      // visibilitychange pause check
      await page.eval(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const usedBeforeHidden = await page.eval(() => MathCoreBonus.GameBridge.getPlaytimeStatus('4C_7').usedMs);
      await sleep(2200);
      const usedAfterHidden = await page.eval(() => MathCoreBonus.GameBridge.getPlaytimeStatus('4C_7').usedMs);
      assert.strictEqual(usedAfterHidden, usedBeforeHidden, `${prof.label} playtime paused while document hidden`);

      // Restore visibility & verify delta <= 5000ms clamp across 600s sleep jump
      await page.eval(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const usedBeforeJump = await page.eval(() => MathCoreBonus.GameBridge.getPlaytimeStatus('4C_7').usedMs);
      await page.eval(() => {
        window.__origDateNow = Date.now;
        const baseNow = window.__origDateNow();
        let calls = 0;
        Date.now = () => baseNow + 600000 + (++calls * 10);
      });
      await sleep(1300);
      await page.eval(() => {
        if (window.__origDateNow) {
          Date.now = window.__origDateNow;
          delete window.__origDateNow;
        }
      });
      const usedAfterJump = await page.eval(() => MathCoreBonus.GameBridge.getPlaytimeStatus('4C_7').usedMs);
      const jumpDelta = usedAfterJump - usedBeforeJump;
      assert.ok(jumpDelta > 0 && jumpDelta <= 10500, `${prof.label} sleep jump clamped <=5000ms per tick (got ${jumpDelta}ms)`);

      // MATH_GAME_REPORT -> MP_V2_OUTBOX game_finish + points_earn without double-awarding or 2x duration deduction
      const usedBeforeReport = await page.eval(() => MathCoreBonus.GameBridge.getPlaytimeStatus('4C_7').usedMs);
      await page.eval(() => {
        const f = document.getElementById('gameIframe');
        const fw = f.contentWindow;
        fw.startGame();
        fw.endGame('player');
      });
      await page.waitFor(() => {
        const outbox = JSON.parse(localStorage.getItem('MP_V2_OUTBOX') || '[]');
        const acts = outbox.map((x) => x.action);
        return acts.includes('game_finish') && acts.includes('points_earn');
      }, 6000);
      const reportCheck = await page.eval(() => {
        const outbox = JSON.parse(localStorage.getItem('MP_V2_OUTBOX') || '[]');
        const ptsLedger = MathCoreBonus.PointsLedger.getLedger('4C_7');
        const top10Awards = (ptsLedger.entries || []).filter((e) => e.sourceType === 'gameTop10Daily');
        const usedAfter = MathCoreBonus.GameBridge.getPlaytimeStatus('4C_7').usedMs;
        return {
          actions: outbox.map((x) => x.action),
          allSigned: outbox.every((x) => typeof x.sig === 'string' && x.sig.length === 32),
          top10AwardsCount: top10Awards.length,
          usedAfter,
        };
      });
      assert.strictEqual(reportCheck.allSigned, true, `${prof.label} outbox events signed`);
      assert.strictEqual(reportCheck.top10AwardsCount, 1, `${prof.label} zero double-awarding in PointsLedger`);
      assert.ok(reportCheck.usedAfter - usedBeforeReport < 5000, `${prof.label} zero 2x duration deduction`);

      // Teardown: showScreen('screen-points'), openGamesApp(), and logout()
      await page.eval(() => window.AppUI.showScreen('screen-points'));
      let td = await page.eval(() => ({
        hidden: document.getElementById('gameIframeWrap').classList.contains('d-none'),
        src: document.getElementById('gameIframe').getAttribute('src'),
      }));
      assert.strictEqual(td.hidden, true, `${prof.label} showScreen('screen-points') hides #gameIframeWrap`);
      assert.strictEqual(td.src, 'about:blank', `${prof.label} showScreen('screen-points') resets iframe src`);

      // Re-open game, then call openGamesApp() directly
      await page.eval(() => { window.AppUI.openGamesApp(); });
      await page.clickSelector('#gameCardsRow button[data-gid="bash-nim"]');
      await page.waitFor(() => !document.getElementById('gameIframeWrap').classList.contains('d-none'), 5000);
      await page.eval(() => { window.AppUI.openGamesApp(); });
      td = await page.eval(() => ({
        hidden: document.getElementById('gameIframeWrap').classList.contains('d-none'),
        src: document.getElementById('gameIframe').getAttribute('src'),
      }));
      assert.strictEqual(td.hidden, true, `${prof.label} openGamesApp() hides #gameIframeWrap`);
      assert.strictEqual(td.src, 'about:blank', `${prof.label} openGamesApp() resets iframe src`);

      // Re-open game, then call logout()
      await page.clickSelector('#gameCardsRow button[data-gid="bash-nim"]');
      await page.waitFor(() => !document.getElementById('gameIframeWrap').classList.contains('d-none'), 5000);
      await page.eval(() => { window.AppUI.logout(); });
      td = await page.eval(() => ({
        hidden: document.getElementById('gameIframeWrap').classList.contains('d-none'),
        src: document.getElementById('gameIframe').getAttribute('src'),
      }));
      assert.strictEqual(td.hidden, true, `${prof.label} logout() hides #gameIframeWrap`);
      assert.strictEqual(td.src, 'about:blank', `${prof.label} logout() resets iframe src`);

      // 5-min warning & 0:00 lockout
      await seedStorage(page, base, { session: STUDENT_4C7, usedMs: 25 * 60 * 1000 - 1500 });
      await page.goto(`${base}/app.html?screen=games`);
      await page.waitFor(() => document.querySelector('#gameCardsRow button[data-gid="bash-nim"]'), 10000);
      await page.clickSelector('#gameCardsRow button[data-gid="bash-nim"]');
      await page.waitFor(() => {
        const warn = document.getElementById('gameIframeWarn');
        const toast = document.querySelector('.mp-toast');
        return warn && !warn.classList.contains('d-none') && toast && toast.getBoundingClientRect().height > 0;
      }, 6000);
      const warnState = await page.eval(() => {
        const badge = document.getElementById('gameIframePlaytimeBadge');
        const warn = document.getElementById('gameIframeWarn');
        const toast = document.querySelector('.mp-toast');
        const tr = toast.getBoundingClientRect();
        return {
          badgeClass: badge.className,
          warnVisible: !warn.classList.contains('d-none'),
          toastVisible: tr.width > 0 && tr.height > 0,
          toastText: toast.textContent,
        };
      });
      assert.ok(warnState.badgeClass.includes('bg-warning'), `${prof.label} badge switches to warning class`);
      assert.strictEqual(warnState.warnVisible, true, `${prof.label} #gameIframeWarn visible`);
      assert.strictEqual(warnState.toastVisible, true, `${prof.label} .mp-toast visible`);

      // Lockout at 0:00
      await seedStorage(page, base, { session: STUDENT_4C7, usedMs: 30 * 60 * 1000 - 1500 });
      await page.goto(`${base}/app.html?screen=games`);
      await page.waitFor(() => document.querySelector('#gameCardsRow button[data-gid="bash-nim"]'), 10000);
      await page.clickSelector('#gameCardsRow button[data-gid="bash-nim"]');
      await page.waitFor(() => {
        const st = window.MathCoreBonus && MathCoreBonus.GameBridge.getPlaytimeStatus('4C_7');
        return st && st.locked && document.getElementById('gameIframeWrap').classList.contains('d-none');
      }, 6000);
      const lockState = await page.eval(() => ({
        wrapHidden: document.getElementById('gameIframeWrap').classList.contains('d-none'),
        src: document.getElementById('gameIframe').getAttribute('src'),
        locked: MathCoreBonus.GameBridge.getPlaytimeStatus('4C_7').locked,
      }));
      assert.strictEqual(lockState.locked, true, `${prof.label} locks at 0:00`);
      assert.strictEqual(lockState.wrapHidden, true, `${prof.label} auto-hides #gameIframeWrap at 0:00`);
      assert.strictEqual(lockState.src, 'about:blank', `${prof.label} resets iframe src at 0:00`);

      assert.deepStrictEqual(page._errors, [], `no page errors on ${prof.label}`);
      console.log(`[PASS] ${prof.label}: countdown, warn/toast, pause/clamp, outbox, teardown, 0:00 lock`);
    } finally {
      await page.close();
    }
  }
}

// =========================================================================
// Test Group 4: Mobile Shell Countdown, 5-Min Warn, Lockout, Mute & leave() Outbox Flush
// =========================================================================
async function testMobileShellLifecycle(browser, base) {
  const iPhone14 = DEVICE_PROFILES.find((p) => p.label === 'iPhone 14 (390x844)');
  const page = await browser.newPage(base, iPhone14);
  try {
    // 4a. setGameActive(false) on menu does NOT drain playtime; setGameActive(true) ticks live
    await seedStorage(page, base, { session: STUDENT_4C7, usedMs: 0 });
    await page.goto(`${base}/games/2-mobile.html?gameId=bash-nim`);
    await page.waitFor(() => !!document.getElementById('mgs-countdown'), 8000);

    const idleBefore = await page.eval(() => MathCoreBonus.GameBridge.getPlaytimeStatus('4C_7').usedMs);
    await sleep(2300);
    const idleAfter = await page.eval(() => MathCoreBonus.GameBridge.getPlaytimeStatus('4C_7').usedMs);
    assert.strictEqual(idleAfter, idleBefore, 'menu screen (setGameActive=false) must NOT drain daily playtime');

    // Start round -> setGameActive(true) ticks live
    await page.clickSelector('#start-screen .mega-btn');
    await page.waitFor(() => !document.getElementById('main-wrapper').classList.contains('hidden'), 5000);
    const t1 = await page.eval(() => document.getElementById('mgs-countdown').textContent);
    await sleep(2300);
    const t2 = await page.eval(() => document.getElementById('mgs-countdown').textContent);
    assert.match(t1, /⏳ \d\d:\d\d/);
    assert.notStrictEqual(t1, t2, `mobile countdown ticks when active (${t1} -> ${t2})`);

    // 4b. Mute persistence & playLineHum audio gate
    await page.clickSelector('#mgs-mute');
    const muteAfterClick = await page.eval(() => ({
      btn: document.getElementById('mgs-mute').textContent,
      ls: localStorage.getItem('MP_V2_GAME_MUTED'),
      muted: MobileGameShell.isMuted(),
    }));
    assert.strictEqual(muteAfterClick.muted, true);
    assert.strictEqual(muteAfterClick.ls, '1');
    assert.strictEqual(muteAfterClick.btn, '🔇');

    // Navigate to 328-mobile.html while muted -> verify mute persists and playLineHum creates 0 oscillators
    await page.goto(`${base}/games/328-mobile.html?gameId=trig-ratio`);
    await page.waitFor(() => !!document.getElementById('mgs-mute'), 8000);
    const humCheck = await page.eval(() => {
      let oscCount = 0;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && AC.prototype && AC.prototype.createOscillator) {
        const orig = AC.prototype.createOscillator;
        AC.prototype.createOscillator = function () {
          oscCount++;
          return orig.apply(this, arguments);
        };
      }
      if (typeof SoundManager !== 'undefined' && SoundManager.playLineHum) {
        SoundManager.playLineHum(100);
      }
      return {
        persistedMuted: MobileGameShell.isMuted(),
        btnText: document.getElementById('mgs-mute').textContent,
        oscCount,
      };
    });
    assert.strictEqual(humCheck.persistedMuted, true, 'mute persists across navigation');
    assert.strictEqual(humCheck.btnText, '🔇');
    assert.strictEqual(humCheck.oscCount, 0, 'playLineHum gated when muted');

    // 4c. 5-min warning banner + .mgs-warn
    await seedStorage(page, base, { session: STUDENT_4C7, usedMs: 25 * 60 * 1000 - 1500 });
    await page.goto(`${base}/games/2-mobile.html?gameId=bash-nim`);
    await page.waitFor(() => !!document.getElementById('mgs-countdown'), 8000);
    await page.clickSelector('#start-screen .mega-btn');
    await page.waitFor(() => {
      const b = document.getElementById('mgs-warn-banner');
      const c = document.getElementById('mgs-countdown');
      return b && c && c.classList.contains('mgs-warn');
    }, 6000);

    // 4d. reportRound() + immediate leave() via #mgs-back flushes signed points_earn + game_finish without async drop
    const usedBeforeReport = await page.eval(() => MathCoreBonus.GameBridge.getPlaytimeStatus('4C_7').usedMs);
    await page.eval(() => {
      const rep = MobileGameShell.reportRound({ gameId: 'bash-nim', win: true, durationMs: 25000 });
      if (!rep || rep.score <= 0) throw new Error('Expected positive reportRound result');
      document.getElementById('mgs-back').click();
    });
    await page.waitForUrl((u) => u.includes('/app.html'), 10000);
    await page.waitFor(() => window.AppUI && document.getElementById('screen-games').classList.contains('active'), 10000);
    const outboxAfterLeave = await page.eval(() => {
      const ob = JSON.parse(localStorage.getItem('MP_V2_OUTBOX') || '[]');
      const usedAfter = MathCoreBonus.GameBridge.getPlaytimeStatus('4C_7').usedMs;
      return {
        actions: ob.map((x) => x.action),
        allSigned: ob.every((x) => typeof x.sig === 'string' && x.sig.length === 32),
        usedAfter,
      };
    });
    assert.ok(outboxAfterLeave.actions.includes('points_earn'), 'leave() flushed points_earn');
    assert.ok(outboxAfterLeave.actions.includes('game_finish'), 'leave() flushed game_finish');
    assert.strictEqual(outboxAfterLeave.allSigned, true, 'flushed events carry 32-char HMAC sig');
    assert.ok(outboxAfterLeave.usedAfter - usedBeforeReport < 5000, 'mobile reportRound uses skipDurationRecord (no 2x)');

    // 4e. 00:00 Lockout overlay, reportRound() returns null, and #mgs-lock-points / #mgs-lock-lobby route through leave()
    for (const [linkSel, expectedScreen] of [['#mgs-lock-points', 'screen-points'], ['#mgs-lock-lobby', 'screen-games']]) {
      await seedStorage(page, base, { session: STUDENT_4C7, usedMs: 30 * 60 * 1000 - 1500 });
      await page.goto(`${base}/games/4-mobile.html?gameId=ring-nim`);
      await page.waitFor(() => !!document.getElementById('mgs-countdown'), 8000);
      await page.clickSelector('#start-screen .mega-btn');
      await page.waitFor(() => !!document.getElementById('mgs-lock-overlay'), 6000);

      const lockCheck = await page.eval(() => {
        const rep = MobileGameShell.reportRound({ gameId: 'ring-nim', win: true, durationMs: 12000 });
        // Queue an async signed event right before clicking lock link to prove leave() flushes it
        MathCoreSync.recordAction('game_finish', { gameId: 'ring-nim', score: 0, win: false, fromLockTest: true }, { sid: '4C_7' });
        return {
          rep,
          countdown: document.getElementById('mgs-countdown').textContent,
          wrapperHidden: document.getElementById('main-wrapper').classList.contains('hidden'),
        };
      });
      assert.strictEqual(lockCheck.rep, null, 'reportRound() returns null after 00:00 lockout');
      assert.strictEqual(lockCheck.countdown, '⏳ 00:00');
      assert.strictEqual(lockCheck.wrapperHidden, true);

      await page.clickSelector(linkSel);
      await page.waitForUrl((u) => u.includes('/app.html'), 10000);
      await page.waitFor((sid) => window.AppUI && document.getElementById(sid).classList.contains('active'), 10000, expectedScreen);
      const flushedLock = await page.eval(() => {
        const ob = JSON.parse(localStorage.getItem('MP_V2_OUTBOX') || '[]');
        return ob.some((e) => e.action === 'game_finish' && e.payload && e.payload.fromLockTest === true && typeof e.sig === 'string' && e.sig.length === 32);
      });
      assert.strictEqual(flushedLock, true, `${linkSel} awaited WebCrypto & flushed outbox via leave()`);
    }

    assert.deepStrictEqual(page._errors, [], 'no page errors in mobile shell lifecycle');
    console.log('[PASS] Mobile shell: idle non-drain, live tick, 5-min warn, mute+playLineHum, leave() & lock link outbox flush');
  } finally {
    await page.close();
  }
}

// =========================================================================
// Test Group 5: Game 1 (328-mobile.html) across 320x568, 375x667, 390x844, 844x390
// =========================================================================
async function testMobileGame1Trig(browser, base) {
  const iPhoneUA = DEVICE_PROFILES.find((p) => p.label === 'iPhone 14 (390x844)').ua;

  for (const vp of PHONE_VIEWPORTS) {
    const page = await browser.newPage(base, {
      ua: iPhoneUA, width: vp.width, height: vp.height, screenW: vp.width, screenH: vp.height,
      dpr: vp.dpr, mobile: true, maxTouch: 5, coarse: true,
    });
    try {
      await seedStorage(page, base, { session: STUDENT_4C7, usedMs: 0 });
      await page.goto(`${base}/games/328-mobile.html?gameId=trig-ratio`);
      await page.waitFor(() => !!document.getElementById('mgs-countdown') && typeof window.startGame === 'function', 8000);

      // Start screen: zero MathJax CDN, h1 not clipped above HUD
      const startCheck = await page.eval(() => {
        const hud = document.getElementById('mgs-hud').getBoundingClientRect();
        const h1 = document.querySelector('#start-screen h1').getBoundingClientRect();
        const mj = document.getElementById('MathJax-script');
        return {
          hasMathJaxTag: !!mj,
          h1Top: h1.top,
          hudBottom: hud.bottom,
          scrollTop: document.getElementById('start-screen').scrollTop,
        };
      });
      assert.strictEqual(startCheck.hasMathJaxTag, false, `328-mobile ${vp.label} has zero MathJax CDN script`);
      assert.ok(startCheck.h1Top >= startCheck.hudBottom - 1, `328-mobile ${vp.label} start h1 (${startCheck.h1Top}) >= hud (${startCheck.hudBottom})`);

      // Non-invasively spy on fillText & arc to inspect vertex labels and angle arc sweeps
      await page.eval(() => {
        window.__drawnTexts = [];
        window.__drawnArcs = [];
        const origFillText = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (txt) {
          if (this && this.canvas && this.canvas.id === 'main-canvas') {
            window.__drawnTexts.push(String(txt));
          }
          return origFillText.apply(this, arguments);
        };
        const origArc = CanvasRenderingContext2D.prototype.arc;
        CanvasRenderingContext2D.prototype.arc = function (x, y, r, s, e, ccw) {
          if (this && this.canvas && this.canvas.id === 'main-canvas') {
            window.__drawnArcs.push({ r, s, e, ccw: !!ccw });
          }
          return origArc.apply(this, arguments);
        };
      });

      // Start round
      await page.clickSelector('#start-screen button');
      await page.waitFor(() => !document.getElementById('main-wrapper').classList.contains('hidden'), 5000);
      await sleep(120);

      const canvasCheck = await page.eval(() => {
        const cv = document.getElementById('main-canvas');
        const qText = document.getElementById('question-text').textContent || '';
        const rText = document.getElementById('ratio-label').textContent || '';
        const rawTex = /\\\(|\\\)|\\triangle|\\sin|\\cos|\\tan/.test(qText + ' ' + rText);
        return {
          attrW: cv.width,
          attrH: cv.height,
          cssW: cv.clientWidth,
          cssH: cv.clientHeight,
          dpr: window.devicePixelRatio || 1,
          rawTex,
          qText,
          rText,
          drawnTexts: window.__drawnTexts.slice(),
          slotBottom: document.getElementById('denominator-slot').getBoundingClientRect().bottom,
          innerH: window.innerHeight,
        };
      });
      assert.strictEqual(canvasCheck.rawTex, false, `328-mobile ${vp.label} zero raw TeX (${canvasCheck.qText})`);
      assert.strictEqual(canvasCheck.attrW, Math.round(canvasCheck.cssW * canvasCheck.dpr), `328-mobile ${vp.label} DPR canvas width`);
      assert.strictEqual(canvasCheck.attrH, Math.round(canvasCheck.cssH * canvasCheck.dpr), `328-mobile ${vp.label} DPR canvas height`);
      assert.ok(canvasCheck.cssH >= 150, `328-mobile ${vp.label} cssH=${canvasCheck.cssH} >= 150`);
      assert.ok(canvasCheck.slotBottom <= canvasCheck.innerH + 1, `328-mobile ${vp.label} denominator slot fits viewport`);

      // Level 1 draws all 3 vertices (A, B, C)
      for (const v of ['A', 'B', 'C']) {
        assert.ok(canvasCheck.drawnTexts.includes(v), `328-mobile ${vp.label} Level 1 drew vertex ${v} (got ${JSON.stringify(canvasCheck.drawnTexts)})`);
      }

      if (vp.label === '390x844' || vp.label === '844x390') {
        await page.screenshot(`mobile_${vp.label}_328_play`);
      }

      // Check angle arc sweep <= 180 deg across both dir=+1 and dir=-1 (on 390x844)
      if (vp.label === '390x844') {
        const arcAudit = await page.eval(() => {
          let sawPos = false, sawNeg = false;
          const bad = [];
          for (let i = 0; i < 40; i++) {
            window.__drawnArcs = [];
            nextMission();
            const dir = Math.sign(currentMission.vis.ref.pt[0]);
            if (dir > 0) sawPos = true; else if (dir < 0) sawNeg = true;
            for (const a of window.__drawnArcs) {
              const twoPi = Math.PI * 2;
              let sweep = (a.s === a.e) ? 0 : (a.ccw ? (a.s - a.e) : (a.e - a.s));
              sweep = ((sweep % twoPi) + twoPi) % twoPi;
              const deg = (sweep * 180) / Math.PI;
              if (deg > 180.05 && deg < 359.95) bad.push({ i, dir, deg });
            }
          }
          return { sawPos, sawNeg, bad };
        });
        assert.strictEqual(arcAudit.sawPos && arcAudit.sawNeg, true, '328-mobile tested both dir=+1 and dir=-1');
        assert.deepStrictEqual(arcAudit.bad, [], `328-mobile angle arc sweep <= 180° (bad=${JSON.stringify(arcAudit.bad)})`);
        // Reset cleanly via startGame so state is fresh
        await page.eval(() => startGame('30s'));
        await sleep(100);
      }

      // Interactive numerator & denominator taps via real CDP pointer events advance score
      const edges = await page.eval(() => {
        const r = document.getElementById('main-canvas').getBoundingClientRect();
        const { pA, pD, pRef } = ctx.renderData;
        const map = {
          opp: { x: r.left + (pA.x + pD.x) / 2, y: r.top + (pA.y + pD.y) / 2 },
          adj: { x: r.left + (pD.x + pRef.x) / 2, y: r.top + (pD.y + pRef.y) / 2 },
          hyp: { x: r.left + (pA.x + pRef.x) / 2, y: r.top + (pA.y + pRef.y) / 2 },
        };
        return { numPt: map[currentMission.steps.num], denPt: map[currentMission.steps.den] };
      });
      await page.mouseClickAt(edges.numPt.x, edges.numPt.y);
      await sleep(80);
      const afterNum = await page.eval(() => ({
        score,
        numFilled,
        denFilled,
        gameState,
      }));
      assert.strictEqual(afterNum.numFilled, true, `328-mobile ${vp.label} numerator tap filled slot`);
      assert.ok(afterNum.score >= 100, `328-mobile ${vp.label} numerator tap increased score`);

      await page.mouseClickAt(edges.denPt.x, edges.denPt.y);
      await sleep(80);
      const afterDen = await page.eval(() => ({
        score,
        numFilled,
        denFilled,
        gameState,
      }));
      assert.strictEqual(afterDen.denFilled, true, `328-mobile ${vp.label} denominator tap filled slot`);
      assert.strictEqual(afterDen.gameState, 'SUCCESS', `328-mobile ${vp.label} round reached SUCCESS`);
      assert.ok(afterDen.score > afterNum.score, `328-mobile ${vp.label} denominator tap increased score`);

      // Transition timeout does NOT hijack returnToMenu()
      await page.eval(() => returnToMenu());
      await sleep(850);
      const afterMenu = await page.eval(() => ({
        gameState,
        startVisible: !document.getElementById('start-screen').classList.contains('hidden'),
        wrapperHidden: document.getElementById('main-wrapper').classList.contains('hidden'),
      }));
      assert.strictEqual(afterMenu.gameState, 'MENU', `328-mobile ${vp.label} transition timeout cancelled on returnToMenu()`);
      assert.strictEqual(afterMenu.startVisible, true);
      assert.strictEqual(afterMenu.wrapperHidden, true);

      assert.deepStrictEqual(page._errors, [], `no page errors on 328-mobile ${vp.label}`);
    } finally {
      await page.close();
    }
  }

  // 328-mobile End screen: XSS-safe .mgs-top10, Replay (startGame without reload), and Lobby return
  const xssPage = await browser.newPage(base, {
    ua: iPhoneUA, width: 375, height: 667, screenW: 375, screenH: 667, dpr: 2, mobile: true, maxTouch: 5, coarse: true,
  });
  try {
    const xssStudent = Object.assign({}, STUDENT_4C7, { name: '<img src=x onerror=window.__xss=1>' });
    await seedStorage(xssPage, base, { session: xssStudent, usedMs: 0 });
    await xssPage.goto(`${base}/games/328-mobile.html?gameId=trig-ratio`);
    await xssPage.waitFor(() => typeof window.endGame === 'function', 8000);
    await xssPage.clickSelector('#start-screen button');
    await xssPage.waitFor(() => !document.getElementById('main-wrapper').classList.contains('hidden'), 5000);
    await xssPage.eval(() => {
      window.__sameDoc = 1;
      score = 300;
      endGame();
    });
    await xssPage.waitFor(() => !!document.querySelector('.end-overlay .mgs-top10'), 5000);
    const endCheck = await xssPage.eval(() => {
      const hud = document.getElementById('mgs-hud').getBoundingClientRect();
      const h1 = document.querySelector('.end-overlay h1').getBoundingClientRect();
      return {
        xss: window.__xss,
        imgCount: document.querySelectorAll('.mgs-top10 img').length,
        top10Text: document.querySelector('.mgs-top10').textContent,
        h1Top: h1.top,
        hudBottom: hud.bottom,
        replayText: document.getElementById('btn-replay').textContent,
        lobbyText: document.getElementById('btn-lobby').textContent,
      };
    });
    assert.strictEqual(endCheck.xss, undefined, '328-mobile XSS payload must NOT execute');
    assert.strictEqual(endCheck.imgCount, 0, '328-mobile .mgs-top10 must contain zero injected <img>');
    assert.ok(endCheck.top10Text.includes('<img src=x'), '328-mobile .mgs-top10 renders escaped student name');
    assert.ok(endCheck.h1Top >= endCheck.hudBottom - 1, '328-mobile end h1 not clipped above HUD');
    assert.ok(endCheck.lobbyText.includes('返回遊戲大廳'), '328-mobile end screen has lobby button');
    await xssPage.screenshot('mobile_375x667_328_end');

    // Replay calls startGame without reload
    await xssPage.clickSelector('#btn-replay');
    await xssPage.waitFor(() => !document.getElementById('main-wrapper').classList.contains('hidden'), 5000);
    assert.strictEqual(await xssPage.eval(() => window.__sameDoc), 1, '328-mobile Replay keeps same document (no location.reload)');

    // Lobby button returns to app.html?screen=games
    await xssPage.eval(() => endGame());
    await xssPage.waitFor(() => !!document.getElementById('btn-lobby'), 5000);
    await xssPage.clickSelector('#btn-lobby');
    await xssPage.waitForUrl((u) => u.includes('/app.html'), 10000);
    await xssPage.waitFor(() => window.AppUI && document.getElementById('screen-games').classList.contains('active'), 10000);
  } finally {
    await xssPage.close();
  }

  console.log('[PASS] Game 1 (328-mobile.html) across 4 viewports + math/vertices/arcs/taps/timers/XSS/end');
}

// =========================================================================
// Test Group 6: Game 2 (2-mobile.html) across 320x568, 375x667, 390x844, 844x390
// =========================================================================
async function testMobileGame2Bash(browser, base) {
  const iPhoneUA = DEVICE_PROFILES.find((p) => p.label === 'iPhone 14 (390x844)').ua;

  for (const vp of PHONE_VIEWPORTS) {
    const page = await browser.newPage(base, {
      ua: iPhoneUA, width: vp.width, height: vp.height, screenW: vp.width, screenH: vp.height,
      dpr: vp.dpr, mobile: true, maxTouch: 5, coarse: true,
    });
    try {
      await seedStorage(page, base, { session: STUDENT_4C7, usedMs: 0 });
      await page.goto(`${base}/games/2-mobile.html?gameId=bash-nim`);
      await page.waitFor(() => !!document.getElementById('mgs-countdown') && typeof window.startGame === 'function', 8000);

      // Start screen h1 >= hudBottom
      const startGeo = await page.eval(() => ({
        h1Top: document.querySelector('#start-screen h1').getBoundingClientRect().top,
        hudBottom: document.getElementById('mgs-hud').getBoundingClientRect().bottom,
      }));
      assert.ok(startGeo.h1Top >= startGeo.hudBottom - 1, `2-mobile ${vp.label} start h1 not clipped above HUD`);

      // Trigger genuine startGame() until random maxTake === 9 (so we verify worst-case 9-button layout)
      await page.clickSelector('#start-screen .mega-btn');
      await page.waitFor(() => !document.getElementById('main-wrapper').classList.contains('hidden'), 5000);
      await page.eval(() => {
        let tries = 0;
        while (maxTake < 9 && tries++ < 40) startGame();
        if (maxTake !== 9) throw new Error('Could not roll maxTake=9 in 40 starts');
      });
      await sleep(80);

      const layoutCheck = await page.eval(() => {
        const cv = document.getElementById('main-canvas');
        const cvRect = cv.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const btns = Array.from(document.querySelectorAll('#action-grid .take-btn'));
        const btnBoxes = btns.map((b) => {
          const r = b.getBoundingClientRect();
          return { text: b.textContent, top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height };
        });
        const ip = document.getElementById('right-pane').getBoundingClientRect();
        const ys = gems.map((g) => g.y);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        return {
          attrW: cv.width,
          attrH: cv.height,
          rectW: cvRect.width,
          rectH: cvRect.height,
          cssW: cv.clientWidth,
          cssH: cv.clientHeight,
          dpr,
          btnCount: btns.length,
          btnBoxes,
          innerH: window.innerHeight,
          innerW: window.innerWidth,
          ipBottom: ip.bottom,
          allFinite: gems.length >= 250 && gems.every((g) => Number.isFinite(g.x) && Number.isFinite(g.y)),
          gemSpanY: maxY - minY,
        };
      });

      assert.strictEqual(layoutCheck.attrW, Math.round(layoutCheck.rectW * layoutCheck.dpr), `2-mobile ${vp.label} DPR canvas width`);
      assert.strictEqual(layoutCheck.attrH, Math.round(layoutCheck.rectH * layoutCheck.dpr), `2-mobile ${vp.label} DPR canvas height`);
      assert.ok(layoutCheck.attrW !== 300 && layoutCheck.attrH !== 150, `2-mobile ${vp.label} never 300x150`);
      assert.ok(layoutCheck.cssH >= 60, `2-mobile ${vp.label} cssH=${layoutCheck.cssH} >= 60`);
      assert.strictEqual(layoutCheck.allFinite, true, `2-mobile ${vp.label} all gems finite`);
      assert.ok(layoutCheck.gemSpanY >= 40, `2-mobile ${vp.label} gems span vertically (${layoutCheck.gemSpanY})`);
      assert.strictEqual(layoutCheck.btnCount, 9, `2-mobile ${vp.label} renders all 9 take buttons`);
      for (const b of layoutCheck.btnBoxes) {
        assert.ok(b.bottom <= layoutCheck.innerH + 1, `2-mobile ${vp.label} button ${b.text} clipped at bottom (${b.bottom} > ${layoutCheck.innerH})`);
        assert.ok(b.right <= layoutCheck.innerW + 1, `2-mobile ${vp.label} button ${b.text} clipped at right`);
      }

      if (vp.label === '375x667' || vp.label === '844x390') {
        await page.screenshot(`mobile_${vp.label}_2_play`);
      }

      // Wait until it's player turn (in case AI won coin flip)
      await page.waitFor(() => currentTurn === 'player' && gameState === 'PLAYING', 5000);
      const remBefore = await page.eval(() => remainingItems);
      await page.clickSelector('#action-grid .take-btn:first-child');
      const remAfterTake = await page.eval(() => remainingItems);
      assert.strictEqual(remAfterTake, remBefore - 1, `2-mobile ${vp.label} take 1 reduced remainingItems`);

      // Wait for AI turn to complete -> remainingItems drops again
      await page.waitFor((prev) => remainingItems < prev && currentTurn === 'player', 5000, remAfterTake);
      const remAfterAi = await page.eval(() => remainingItems);
      assert.ok(remAfterAi < remAfterTake, `2-mobile ${vp.label} AI responded and reduced remainingItems`);

      // Fast returnToMenu() right after player take cancels pending AI timeout
      await page.clickSelector('#action-grid .take-btn:first-child');
      const remBeforeMenu = await page.eval(() => remainingItems);
      await page.eval(() => returnToMenu());
      await sleep(1600);
      const afterFastMenu = await page.eval(() => ({
        gameState,
        remainingItems,
        aiTimerId,
        startVisible: !document.getElementById('start-screen').classList.contains('hidden'),
      }));
      assert.strictEqual(afterFastMenu.gameState, 'MENU');
      assert.strictEqual(afterFastMenu.remainingItems, remBeforeMenu, `2-mobile ${vp.label} AI timeout cancelled on returnToMenu()`);
      assert.strictEqual(afterFastMenu.aiTimerId, null);
      assert.strictEqual(afterFastMenu.startVisible, true);

      assert.deepStrictEqual(page._errors, [], `no page errors on 2-mobile ${vp.label}`);
    } finally {
      await page.close();
    }
  }

  // End screen: .mgs-top10, Replay, and Lobby return
  const endPage = await browser.newPage(base, {
    ua: iPhoneUA, width: 375, height: 667, screenW: 375, screenH: 667, dpr: 2, mobile: true, maxTouch: 5, coarse: true,
  });
  try {
    await seedStorage(endPage, base, { session: STUDENT_4C7, usedMs: 0 });
    await endPage.goto(`${base}/games/2-mobile.html?gameId=bash-nim`);
    await endPage.waitFor(() => typeof window.endGame === 'function', 8000);
    await endPage.clickSelector('#start-screen .mega-btn');
    await endPage.waitFor(() => !document.getElementById('main-wrapper').classList.contains('hidden'), 5000);
    await endPage.eval(() => {
      window.__sameDoc = 1;
      endGame('player');
    });
    await endPage.waitFor(() => !!document.querySelector('#game-over-screen .mgs-top10'), 5000);
    const endCheck = await endPage.eval(() => ({
      h1Top: document.querySelector('#game-over-screen h1').getBoundingClientRect().top,
      hudBottom: document.getElementById('mgs-hud').getBoundingClientRect().bottom,
      hasTop10: !!document.querySelector('#game-over-screen .mgs-top10'),
      btnTexts: Array.from(document.querySelectorAll('#game-over-screen .end-actions button')).map((b) => b.textContent.trim()),
    }));
    assert.ok(endCheck.h1Top >= endCheck.hudBottom - 1, '2-mobile end h1 not clipped above HUD');
    assert.strictEqual(endCheck.hasTop10, true, '2-mobile end renders .mgs-top10');
    assert.ok(endCheck.btnTexts.some((t) => t.includes('再挑戰一次')), '2-mobile end has Replay');
    assert.ok(endCheck.btnTexts.some((t) => t.includes('返回遊戲大廳')), '2-mobile end has Lobby button');

    await endPage.clickSelector('#game-over-screen .end-actions button:first-child');
    await endPage.waitFor(() => !document.getElementById('main-wrapper').classList.contains('hidden'), 5000);
    assert.strictEqual(await endPage.eval(() => window.__sameDoc), 1, '2-mobile Replay stays on same document');

    await endPage.eval(() => endGame('player'));
    await endPage.waitFor(() => !!document.querySelector('#game-over-screen .end-actions button.secondary'), 5000);
    await endPage.clickSelector('#game-over-screen .end-actions button.secondary');
    await endPage.waitForUrl((u) => u.includes('/app.html'), 10000);
    await endPage.waitFor(() => window.AppUI && document.getElementById('screen-games').classList.contains('active'), 10000);
  } finally {
    await endPage.close();
  }

  console.log('[PASS] Game 2 (2-mobile.html) across 4 viewports + DPR/maxTake=9/AI/timers/end');
}

// =========================================================================
// Test Group 7: Game 3 (4-mobile.html) across 320x568, 375x667, 390x844, 844x390
// =========================================================================
async function testMobileGame3Ring(browser, base) {
  const iPhoneUA = DEVICE_PROFILES.find((p) => p.label === 'iPhone 14 (390x844)').ua;

  for (const vp of PHONE_VIEWPORTS) {
    const page = await browser.newPage(base, {
      ua: iPhoneUA, width: vp.width, height: vp.height, screenW: vp.width, screenH: vp.height,
      dpr: vp.dpr, mobile: true, maxTouch: 5, coarse: true,
    });
    try {
      await seedStorage(page, base, { session: STUDENT_4C7, usedMs: 0 });
      await page.goto(`${base}/games/4-mobile.html?gameId=ring-nim`);
      await page.waitFor(() => !!document.getElementById('mgs-countdown') && typeof window.startGame === 'function', 8000);

      // Start screen: zero literal $n$, h1 >= hudBottom, and roundRect fallback test
      const startCheck = await page.eval(() => {
        const bodyText = document.body.innerText || '';
        const h1 = document.querySelector('#start-screen h1').getBoundingClientRect();
        const hud = document.getElementById('mgs-hud').getBoundingClientRect();
        delete CanvasRenderingContext2D.prototype.roundRect;
        return {
          hasRawDollarN: bodyText.includes('$n$'),
          h1Top: h1.top,
          hudBottom: hud.bottom,
        };
      });
      assert.strictEqual(startCheck.hasRawDollarN, false, `4-mobile ${vp.label} zero literal $n$`);
      assert.ok(startCheck.h1Top >= startCheck.hudBottom - 1, `4-mobile ${vp.label} start h1 not clipped above HUD`);

      // Start genuine game & roll numPillars === 7 for worst-case geometry test
      await page.clickSelector('#start-screen .mega-btn');
      await page.waitFor(() => !document.getElementById('main-wrapper').classList.contains('hidden'), 5000);
      await page.eval(() => {
        let tries = 0;
        while (numPillars < 7 && tries++ < 40) startGame();
        if (numPillars !== 7) throw new Error('Could not roll numPillars=7 in 40 starts');
      });
      await sleep(80);

      const geo = await page.eval(() => {
        const cv = document.getElementById('main-canvas');
        const dpr = window.devicePixelRatio || 1;
        const m = getSceneMetrics();
        const hdr = document.getElementById('q-floating-header');
        const hdrBottom = hdr.offsetTop + hdr.offsetHeight;
        const topRing6 = getRingCoords(6, 6, m);
        const pills = Array.from(document.querySelectorAll('#pillar-pills .pillar-pill')).map((b) => b.textContent.trim());
        const rect = cv.getBoundingClientRect();
        const statsRect = document.getElementById('stats-card').getBoundingClientRect();
        return {
          attrW: cv.width,
          attrH: cv.height,
          rectW: rect.width,
          rectH: rect.height,
          cssW: cv.clientWidth,
          cssH: cv.clientHeight,
          dpr,
          m,
          hdrBottom,
          topRingTopY: topRing6.y - m.ringH / 2,
          pills,
          rightPillarScreen: {
            x: rect.left + m.padX + 6 * m.spacingX,
            y: rect.top + m.groundY - m.pillarH * 0.4,
          },
          statsCenter: {
            x: statsRect.left + statsRect.width / 2,
            y: statsRect.top + statsRect.height / 2,
          },
        };
      });

      assert.strictEqual(geo.attrW, Math.round(geo.rectW * geo.dpr), `4-mobile ${vp.label} DPR canvas width`);
      assert.strictEqual(geo.attrH, Math.round(geo.rectH * geo.dpr), `4-mobile ${vp.label} DPR canvas height`);
      assert.ok(geo.attrW !== 300 && geo.attrH !== 150, `4-mobile ${vp.label} never 300x150`);
      assert.ok(geo.m.ringW < geo.m.spacingX, `4-mobile ${vp.label} rings do not overlap (${geo.m.ringW} < ${geo.m.spacingX})`);
      assert.ok(geo.topRingTopY >= geo.hdrBottom - 4, `4-mobile ${vp.label} top ring (${geo.topRingTopY}) fits below header (${geo.hdrBottom})`);
      assert.ok(geo.m.platformLeft >= 0 && geo.m.platformLeft + geo.m.platformW <= geo.m.W, `4-mobile ${vp.label} platform inside X bounds`);
      assert.ok(geo.m.groundY + geo.m.platformH <= geo.m.H, `4-mobile ${vp.label} platform inside Y bounds`);
      assert.strictEqual(geo.pills.length, 7, `4-mobile ${vp.label} renders 7 pillar pills`);

      // Wait for player turn
      await page.waitFor(() => currentTurn === 'player' && gameState === 'PLAYING', 5000);

      // Tapping #stats-card must NOT select a pillar
      await page.mouseClickAt(geo.statsCenter.x, geo.statsCenter.y);
      assert.strictEqual(await page.eval(() => selectedCol), -1, `4-mobile ${vp.label} tapping #stats-card keeps selectedCol=-1`);

      // Tapping rightmost pillar (col 6) on canvas selects pillar 6
      await page.mouseClickAt(geo.rightPillarScreen.x, geo.rightPillarScreen.y);
      assert.strictEqual(await page.eval(() => selectedCol), 6, `4-mobile ${vp.label} canvas tap selects rightmost pillar 6`);

      if (vp.label === '375x667' || vp.label === '844x390') {
        await page.screenshot(`mobile_${vp.label}_4_play`);
      }

      // Pillar selector pill (柱 1) selects pillar 0 & move button executes turn
      await page.clickSelector('#pillar-pills .pillar-pill[data-pillar-col="0"]');
      assert.strictEqual(await page.eval(() => selectedCol), 0, `4-mobile ${vp.label} pillar pill selects pillar 0`);
      const totalBeforeMove = await page.eval(() => columns.reduce((a, b) => a + b, 0));
      await page.clickSelector('#action-grid .take-btn:first-child');
      const totalAfterMove = await page.eval(() => columns.reduce((a, b) => a + b, 0));
      assert.strictEqual(totalAfterMove, totalBeforeMove - 1, `4-mobile ${vp.label} move button executed turn`);

      // Fast returnToMenu() cancels pending AI timeout
      const colsSnap = await page.eval(() => columns.slice());
      await page.eval(() => returnToMenu());
      await sleep(1600);
      const afterMenu = await page.eval(() => ({
        gameState,
        columns: columns.slice(),
        aiTimerId,
        startVisible: !document.getElementById('start-screen').classList.contains('hidden'),
      }));
      assert.strictEqual(afterMenu.gameState, 'MENU');
      assert.deepStrictEqual(afterMenu.columns, colsSnap, `4-mobile ${vp.label} AI timeout cancelled on returnToMenu()`);
      assert.strictEqual(afterMenu.aiTimerId, null);
      assert.strictEqual(afterMenu.startVisible, true);

      assert.deepStrictEqual(page._errors, [], `no errors (including roundRect deleted) on 4-mobile ${vp.label}`);
    } finally {
      await page.close();
    }
  }

  // End screen: .mgs-top10, Replay, and Lobby return
  const endPage = await browser.newPage(base, {
    ua: iPhoneUA, width: 375, height: 667, screenW: 375, screenH: 667, dpr: 2, mobile: true, maxTouch: 5, coarse: true,
  });
  try {
    await seedStorage(endPage, base, { session: STUDENT_4C7, usedMs: 0 });
    await endPage.goto(`${base}/games/4-mobile.html?gameId=ring-nim`);
    await endPage.waitFor(() => typeof window.endGame === 'function', 8000);
    await endPage.clickSelector('#start-screen .mega-btn');
    await endPage.waitFor(() => !document.getElementById('main-wrapper').classList.contains('hidden'), 5000);
    await endPage.eval(() => {
      window.__sameDoc = 1;
      endGame('player');
    });
    await endPage.waitFor(() => !!document.querySelector('#game-over-screen .mgs-top10'), 5000);
    const endCheck = await endPage.eval(() => ({
      h1Top: document.querySelector('#game-over-screen h1').getBoundingClientRect().top,
      hudBottom: document.getElementById('mgs-hud').getBoundingClientRect().bottom,
      hasTop10: !!document.querySelector('#game-over-screen .mgs-top10'),
      btnTexts: Array.from(document.querySelectorAll('#game-over-screen .end-actions button')).map((b) => b.textContent.trim()),
    }));
    assert.ok(endCheck.h1Top >= endCheck.hudBottom - 1, '4-mobile end h1 not clipped above HUD');
    assert.strictEqual(endCheck.hasTop10, true, '4-mobile end renders .mgs-top10');
    assert.ok(endCheck.btnTexts.some((t) => t.includes('再次挑戰')), '4-mobile end has Replay');
    assert.ok(endCheck.btnTexts.some((t) => t.includes('返回遊戲大廳')), '4-mobile end has Lobby button');

    await endPage.clickSelector('#game-over-screen .end-actions button:first-child');
    await endPage.waitFor(() => !document.getElementById('main-wrapper').classList.contains('hidden'), 5000);
    assert.strictEqual(await endPage.eval(() => window.__sameDoc), 1, '4-mobile Replay stays on same document');

    await endPage.eval(() => endGame('player'));
    await endPage.waitFor(() => !!document.querySelector('#game-over-screen .end-actions button.secondary'), 5000);
    await endPage.clickSelector('#game-over-screen .end-actions button.secondary');
    await endPage.waitForUrl((u) => u.includes('/app.html'), 10000);
    await endPage.waitFor(() => window.AppUI && document.getElementById('screen-games').classList.contains('active'), 10000);
  } finally {
    await endPage.close();
  }

  console.log('[PASS] Game 3 (4-mobile.html) across 4 viewports + roundRect fallback/7-pillar geometry/taps/timers/end');
}

async function run() {
  testUnitDeviceMatrix();
  const srv = await serveStatic();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await launchChrome();
  try {
    await testLiveDeviceRouting(browser, base);
    await testAuthGuardAndReturnRouting(browser, base);
    await testDesktopAndIpadIframe(browser, base);
    await testMobileShellLifecycle(browser, base);
    await testMobileGame1Trig(browser, base);
    await testMobileGame2Bash(browser, base);
    await testMobileGame3Ring(browser, base);
    if (SCREENSHOT_DIR) {
      console.log('[INFO] Saved screenshots to ' + SCREENSHOT_DIR);
    }
    console.log('=== A11 MOBILE E2E: ALL PASSED ===');
  } finally {
    await browser.close();
    srv.close();
  }
}

run().catch((err) => {
  console.error('[FAIL]', err && err.stack ? err.stack : err);
  process.exit(1);
});
