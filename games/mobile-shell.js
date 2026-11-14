/**
 * games/mobile-shell.js — window.MobileGameShell
 * Shared runtime for the phone-native full-screen game ports (games/*-mobile.html):
 * auth gate, compact HUD with live anti-addiction countdown (MM:SS), 5-min warning,
 * 00:00 lockout, score reporting (GameBridge, no double time-recording) and lobby return.
 */
(function (root) {
  'use strict';
  const doc = root.document;
  const LOBBY_URL = '../app.html?screen=games';
  const POINTS_URL = '../app.html?screen=points';
  const MUTE_KEY = 'MP_V2_GAME_MUTED';

  let opts = {};
  let student = null;
  let sid = null;
  let timerId = null;
  let lastTick = 0;
  let gameActive = false;
  let warnShown = false;
  let locked = false;
  let muted = false;
  let leaving = false;
  const pendingSyncOps = new Set();

  function trackSyncPromise(p) {
    if (p && typeof p.then === 'function') {
      const cleanup = function () { pendingSyncOps.delete(tracked); };
      const tracked = Promise.resolve(p).then(cleanup, cleanup);
      pendingSyncOps.add(tracked);
    }
    return p;
  }

  function wrapSyncMethods() {
    const sync = root.MathCoreSync;
    if (!sync || sync.__mgsTracked) return;
    sync.__mgsTracked = true;
    ['recordAction', 'recordEvent'].forEach(function (name) {
      if (typeof sync[name] === 'function') {
        const orig = sync[name];
        sync[name] = function () {
          return trackSyncPromise(orig.apply(this, arguments));
        };
      }
    });
  }

  function settlePendingSync(maxWaitMs) {
    if (pendingSyncOps.size === 0) return Promise.resolve();
    const waitMs = Math.max(50, Number(maxWaitMs || 800));
    const opsList = Array.from(pendingSyncOps);
    const ops = typeof Promise.allSettled === 'function' ? Promise.allSettled(opsList) : Promise.all(opsList);
    const timer = new Promise(function (r) { setTimeout(r, waitMs); });
    return Promise.race([ops, timer]);
  }

  function bridge() {
    return (root.MathCoreBonus && root.MathCoreBonus.GameBridge) || root.GameBridge || null;
  }

  function mmss(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function readSession() {
    try {
      if (root.MathCoreAuth && typeof root.MathCoreAuth.requireAuth === 'function') {
        return root.MathCoreAuth.requireAuth('student');
      }
    } catch (e) {
      return null;
    }
    try {
      const s = JSON.parse(root.localStorage.getItem('MP_V2_SESSION') || 'null');
      if (s && s.token && (s.role === 'student' || s.role === 'teacher_test')) return s;
    } catch (e) {}
    return null;
  }

  function renderAuthGate() {
    const g = doc.createElement('div');
    g.id = 'mgs-auth-gate';
    g.innerHTML = '<h2>🔒 請先登入</h2><p>遊戲需要實名學生帳號登入後才能遊玩。</p>' +
      '<a href="' + LOBBY_URL + '">🏠 前往登入 / 遊戲大廳</a>';
    doc.body.appendChild(g);
  }

  function status() {
    const b = bridge();
    return b ? b.getPlaytimeStatus(sid) : { remainingMs: 0, locked: true, warn: false };
  }

  function updateHud(st) {
    const el = doc.getElementById('mgs-countdown');
    if (!el) return;
    el.textContent = '⏳ ' + mmss(st.remainingMs);
    el.classList.toggle('mgs-warn', !!st.warn);
    el.classList.toggle('mgs-locked', !!st.locked);
  }

  function updateNet(state) {
    const el = doc.getElementById('mgs-net');
    if (!el) return;
    const s = String((state && (state.status || state.level || state)) || '').toLowerCase();
    el.textContent = /red|offline/.test(s) ? '🔴' : /yellow|degraded|slow/.test(s) ? '🟡' : (root.navigator && root.navigator.onLine === false ? '🔴' : '🟢');
  }

  function showWarn() {
    if (warnShown) return;
    warnShown = true;
    const b = doc.createElement('div');
    b.id = 'mgs-warn-banner';
    b.textContent = '⏰ 今日遊戲時間只剩 5 分鐘以內！';
    doc.body.appendChild(b);
    setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 6000);
  }

  function lockout() {
    if (locked) return;
    locked = true;
    stopTimer(false);
    try { if (typeof opts.onLockout === 'function') opts.onLockout(); } catch (e) {}
    const o = doc.createElement('div');
    o.id = 'mgs-lock-overlay';
    o.innerHTML = '<h2>⏰ 今日遊戲時間已用完</h2><p>防沉迷保護：每日免費 30 分鐘已用盡。</p>' +
      '<a id="mgs-lock-points" href="' + POINTS_URL + '">💎 用積分加時</a>' +
      '<a id="mgs-lock-lobby" class="mgs-secondary" href="' + LOBBY_URL + '">🏠 返回遊戲大廳</a>';
    doc.body.appendChild(o);
    const ptsLink = doc.getElementById('mgs-lock-points');
    if (ptsLink) {
      ptsLink.addEventListener('click', function (e) {
        e.preventDefault();
        leave(POINTS_URL);
      });
    }
    const lobbyLink = doc.getElementById('mgs-lock-lobby');
    if (lobbyLink) {
      lobbyLink.addEventListener('click', function (e) {
        e.preventDefault();
        leave(LOBBY_URL);
      });
    }
    updateHud(status());
  }

  function tick() {
    const now = Date.now();
    const delta = Math.min(5000, Math.max(0, now - lastTick));
    lastTick = now;
    if (locked) return;
    let st;
    if (gameActive && doc.visibilityState !== 'hidden') {
      st = bridge().recordPlayDuration(sid, delta);
    } else {
      st = status();
    }
    updateHud(st);
    try { if (typeof opts.onTick === 'function') opts.onTick(st); } catch (e) {}
    if (st.warn) showWarn();
    if (st.locked || st.remainingMs <= 0) lockout();
  }

  function startTimer() {
    if (timerId) return;
    lastTick = Date.now();
    timerId = setInterval(tick, 1000);
  }

  function stopTimer(flush) {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
    if (flush && !locked && gameActive && lastTick && doc.visibilityState !== 'hidden') {
      const delta = Math.min(5000, Math.max(0, Date.now() - lastTick));
      if (delta > 0) bridge().recordPlayDuration(sid, delta);
    }
    lastTick = 0;
  }

  function onVisibility() {
    if (doc.visibilityState === 'hidden') {
      stopTimer(true);
      try { if (typeof opts.onVisibilityPause === 'function') opts.onVisibilityPause(true); } catch (e) {}
      settlePendingSync(300).then(function () {
        flushSync(true);
      });
    } else if (!locked && !leaving) {
      startTimer();
      try { if (typeof opts.onVisibilityPause === 'function') opts.onVisibilityPause(false); } catch (e) {}
    }
  }

  function flushSync(useBeacon) {
    try {
      if (root.MathCoreSync && typeof root.MathCoreSync.flushNow === 'function') {
        return Promise.resolve(root.MathCoreSync.flushNow(useBeacon ? { useBeacon: true } : undefined)).catch(function () {});
      }
    } catch (e) {}
    return Promise.resolve();
  }

  function leave(url) {
    if (leaving) return;
    leaving = true;
    stopTimer(true);
    const timeout = new Promise(function (r) { setTimeout(r, 1500); });
    const settleAndFlush = settlePendingSync(700).then(function () {
      return flushSync(false);
    });
    Promise.race([settleAndFlush, timeout]).then(function () {
      root.location.href = url;
    });
  }

  function renderHud() {
    const hud = doc.createElement('div');
    hud.id = 'mgs-hud';
    hud.innerHTML =
      '<button id="mgs-back" type="button" aria-label="返回遊戲大廳">← 大廳</button>' +
      '<span class="mgs-name" id="mgs-name">' + esc(student.classID + ' ' + (student.name || student.studentID)) + '</span>' +
      '<span id="mgs-countdown" aria-live="polite">⏳ --:--</span>' +
      '<span id="mgs-net" title="網絡狀態">🟢</span>' +
      '<button id="mgs-mute" type="button" aria-label="靜音">' + (muted ? '🔇' : '🔊') + '</button>';
    doc.body.insertBefore(hud, doc.body.firstChild);
    doc.getElementById('mgs-back').addEventListener('click', function () { leave(LOBBY_URL); });
    doc.getElementById('mgs-mute').addEventListener('click', function () {
      muted = !muted;
      try { root.localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) {}
      this.textContent = muted ? '🔇' : '🔊';
      try { if (typeof opts.onMute === 'function') opts.onMute(muted); } catch (e) {}
    });
  }

  const Shell = {
    init: function (options) {
      opts = options || {};
      doc.body.classList.add('mgs-body');
      const sess = readSession();
      if (!sess || !sess.classID || !sess.studentID) {
        renderAuthGate();
        try { if (typeof opts.onLockout === 'function') opts.onLockout(); } catch (e) {}
        return false;
      }
      student = sess;
      sid = sess.classID + '_' + sess.studentID;
      try { muted = root.localStorage.getItem(MUTE_KEY) === '1'; } catch (e) {}
      try {
        if (root.MathCoreNetwatch) {
          root.MathCoreNetwatch.start();
          if (typeof root.MathCoreNetwatch.onChange === 'function') root.MathCoreNetwatch.onChange(updateNet);
        }
      } catch (e) {}
      try {
        if (root.MathCoreSync) {
          wrapSyncMethods();
          root.MathCoreSync.start();
          if (typeof root.MathCoreSync.setDefaultContext === 'function') {
            root.MathCoreSync.setDefaultContext({ sid: sid, classID: sess.classID, studentID: sess.studentID, mode: 'game', signingKey: sess.signingKey || sess.token });
          }
        }
      } catch (e) {}
      renderHud();
      updateNet(root.MathCoreNetwatch && root.MathCoreNetwatch.getState ? root.MathCoreNetwatch.getState() : null);
      const st = status();
      updateHud(st);
      if (st.locked || st.remainingMs <= 0) {
        lockout();
        return false;
      }
      if (st.warn) showWarn();
      startTimer();
      doc.addEventListener('visibilitychange', onVisibility);
      root.addEventListener('pagehide', function () {
        stopTimer(true);
        if (pendingSyncOps.size > 0) {
          settlePendingSync(200).then(function () { flushSync(true); });
        } else {
          flushSync(true);
        }
      });
      return true;
    },
    getStudent: function () { return student; },
    getPlaytimeStatus: function () { return status(); },
    isLocked: function () { return locked; },
    isMuted: function () { return muted; },
    setGameActive: function (on) {
      const next = !!on;
      if (next === gameActive) return;
      if (lastTick && gameActive && !next) {
        stopTimer(true);
        gameActive = false;
        if (!locked && !leaving) startTimer();
        return;
      }
      gameActive = next;
      if (next && !locked && !leaving) {
        lastTick = Date.now();
        if (!timerId) startTimer();
      }
    },
    settlePendingSync: settlePendingSync,
    escapeHtml: esc,
    reportRound: function (p) {
      const b = bridge();
      if (!b || !student || locked) return null;
      const payload = Object.assign({}, p || {}, { student: student, skipDurationRecord: true });
      return b.report(payload);
    },
    renderTop10Html: function (board, stu) {
      const me = stu || student || {};
      const rows = (board || []).map(function (r, i) {
        const mine = r.classID === me.classID && String(r.studentID) === String(me.studentID);
        return '<tr class="' + (mine ? 'mgs-me' : '') + '"><td>#' + (i + 1) + '</td><td>' + esc(r.classID + ' ' + r.name) +
          '</td><td>' + Number(r.score || 0) + '</td></tr>';
      }).join('');
      return '<table class="mgs-top10"><thead><tr><th>排名</th><th>學生</th><th>分數</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="3">暫無記錄</td></tr>') + '</tbody></table>';
    },
    goToLobby: function () { leave(LOBBY_URL); },
    goToPoints: function () { leave(POINTS_URL); },
  };

  root.MobileGameShell = Shell;
})(typeof window !== 'undefined' ? window : this);
