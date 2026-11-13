/**
 * core/ui.js
 * Shared UI Helpers & Privacy-Respecting Renderers (F4, F9, F19, Section 六).
 * Works cleanly in both Browser DOM and headless/Node.js test environments.
 * - `showScreen(screenId, rootEl)`
 * - `showToast(message, type, durationMs)`
 * - `showModal({ title, bodyHtml, onConfirm, onCancel, unclosable })`
 * - `formatMMSS(totalSeconds)`
 * - `renderNetworkBanner(container, netState, pendingCount)`
 * - `formatLeaderboardName(student, displayMode, rankIndex)`
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MathCoreUI = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  let currentScreenId = null;
  const toastHistory = [];
  let activeModalState = null;

  function getDoc() {
    if (typeof document !== 'undefined' && document) {
      return document;
    }
    return null;
  }

  /**
   * Switches active screen by hiding `.app-screen` / `[data-screen]` elements and revealing `screenId`.
   */
  function showScreen(screenId, rootEl) {
    if (!screenId) return null;
    currentScreenId = String(screenId);
    const doc = rootEl || getDoc();
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return { screenId: currentScreenId, domUpdated: false };
    }

    const screens = doc.querySelectorAll('.app-screen, [data-screen]');
    for (let i = 0; i < screens.length; i++) {
      const el = screens[i];
      const matches =
        el.id === currentScreenId ||
        (el.dataset && el.dataset.screen === currentScreenId);
      if (matches) {
        if (el.classList) {
          el.classList.remove('hidden');
          el.classList.add('active');
        }
        if (el.style) el.style.display = '';
      } else {
        if (el.classList) {
          el.classList.remove('active');
          el.classList.add('hidden');
        }
        if (el.style) el.style.display = 'none';
      }
    }

    return { screenId: currentScreenId, domUpdated: true };
  }

  function getCurrentScreen() {
    return currentScreenId;
  }

  /**
   * Displays a non-blocking toast notification (e.g. `"已提交 N 笔 ✓"`).
   */
  function showToast(message, type, durationMs) {
    const toastObj = {
      message: String(message || ''),
      type: type || 'info',
      durationMs: durationMs || 3000,
      ts: Date.now(),
    };
    toastHistory.push(toastObj);
    while (toastHistory.length > 50) {
      toastHistory.shift();
    }

    const doc = getDoc();
    if (doc && doc.body && typeof doc.createElement === 'function') {
      let container = doc.getElementById('mp-v2-toast-container');
      if (!container) {
        container = doc.createElement('div');
        container.id = 'mp-v2-toast-container';
        container.className = 'mp-toast-container';
        doc.body.appendChild(container);
      }
      const item = doc.createElement('div');
      item.className = `mp-toast mp-toast-${toastObj.type}`;
      item.textContent = toastObj.message;
      container.appendChild(item);

      const timer = setTimeout(function () {
        if (item.parentNode) {
          item.parentNode.removeChild(item);
        }
      }, toastObj.durationMs);
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    }

    return toastObj;
  }

  function getToastHistory() {
    return toastHistory.slice();
  }

  /**
   * Shows a modal dialog supporting `unclosable: true` (for mandatory check-ins or alerts).
   */
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showModal(options) {
    const opts = options || {};
    activeModalState = {
      title: String(opts.title || ''),
      bodyHtml: String(opts.bodyHtml || opts.body || ''),
      unclosable: Boolean(opts.unclosable),
      confirmText: opts.confirmText || '確定',
      cancelText: opts.cancelText || '取消',
      onConfirm: typeof opts.onConfirm === 'function' ? opts.onConfirm : null,
      onCancel: typeof opts.onCancel === 'function' ? opts.onCancel : null,
      open: true,
      ts: Date.now(),
    };

    const doc = getDoc();
    if (doc && doc.body && typeof doc.createElement === 'function') {
      let modalEl = doc.getElementById('mp-v2-modal-overlay');
      if (!modalEl) {
        modalEl = doc.createElement('div');
        modalEl.id = 'mp-v2-modal-overlay';
        modalEl.className = 'mp-modal-overlay';
        doc.body.appendChild(modalEl);
      }
      modalEl.style.display = 'flex';
      modalEl.innerHTML =
        `<div class="mp-modal-card" role="dialog" aria-modal="true">` +
        `<div class="mp-modal-header"><h3 class="mp-modal-title">${escapeHtml(activeModalState.title)}</h3></div>` +
        `<div class="mp-modal-body">${activeModalState.bodyHtml}</div>` +
        `<div class="mp-modal-footer">` +
        (activeModalState.unclosable
          ? ''
          : `<button type="button" id="mp-v2-modal-cancel" class="mp-btn mp-btn-secondary">${escapeHtml(activeModalState.cancelText)}</button>`) +
        `<button type="button" id="mp-v2-modal-confirm" class="mp-btn mp-btn-primary">${escapeHtml(activeModalState.confirmText)}</button>` +
        `</div></div>`;

      const confirmBtn = doc.getElementById('mp-v2-modal-confirm');
      if (confirmBtn) {
        confirmBtn.onclick = function () {
          const cb = activeModalState && activeModalState.onConfirm;
          closeModal(true);
          if (cb) cb();
        };
      }
      const cancelBtn = doc.getElementById('mp-v2-modal-cancel');
      if (cancelBtn && !activeModalState.unclosable) {
        cancelBtn.onclick = function () {
          const cb = activeModalState && activeModalState.onCancel;
          closeModal(true);
          if (cb) cb();
        };
      }
    }

    return activeModalState;
  }

  function closeModal(force) {
    if (activeModalState && activeModalState.unclosable && !force) {
      return false;
    }
    if (activeModalState) {
      activeModalState.open = false;
    }
    const doc = getDoc();
    if (doc && typeof doc.getElementById === 'function') {
      const modalEl = doc.getElementById('mp-v2-modal-overlay');
      if (modalEl && modalEl.style) {
        modalEl.style.display = 'none';
      }
    }
    return true;
  }

  function getActiveModal() {
    return activeModalState;
  }

  /**
   * Formats seconds into `MM:SS` (clamping negative values to `00:00`).
   */
  function formatMMSS(totalSeconds) {
    const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const mm = Math.floor(sec / 60);
    const ss = sec % 60;
    return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  }

  /**
   * Renders network region status banner (`🟢`, `🟡`, `🔴`) + pending outbox badge (`待提交 N 筆`).
   */
  function renderNetworkBanner(container, netState, pendingCount) {
    const state = netState || { status: 'GREEN' };
    const status = String(state.status || 'GREEN').toUpperCase();
    const count = Math.max(0, parseInt(pendingCount, 10) || 0);

    let statusText = '🟢 澳門/非大陸網絡';
    if (status === 'YELLOW') {
      statusText = '🟡 回到澳門網絡後將自動提交';
    } else if (status === 'RED') {
      statusText = '🔴 離線模式（回到澳門網絡後將自動提交）';
    }

    const pendingBadgeText = `待提交 ${count} 筆`;
    const html =
      `<div class="mp-network-banner mp-net-${status.toLowerCase()}" data-net-status="${status}">` +
      `<span class="mp-net-status-text">${statusText}</span>` +
      `<span class="mp-net-pending-badge" data-pending-count="${count}">${pendingBadgeText}</span>` +
      `</div>`;

    if (container && typeof container === 'object') {
      if ('innerHTML' in container) {
        container.innerHTML = html;
      } else if ('textContent' in container) {
        container.textContent = `${statusText} | ${pendingBadgeText}`;
      }
    }

    return {
      status: status,
      statusText: statusText,
      pendingBadgeText: pendingBadgeText,
      pendingCount: count,
      html: html,
    };
  }

  /**
   * Formats student name for leaderboards according to Teacher Console privacy mode (Section 六):
   * - `'real_name'`: `"古永晴"`
   * - `'nickname'`: `"古*晴"` (or 2-char name `"谷雨"` -> `"谷*"`)
   * - `'seat_no'` / `'seat_only'`: `"4C #01"`
   * - `'anonymous'`: `"同學 #1"` (uses 1-based `rankIndex + 1` or `1`)
   * - `'hidden'`: `""` / `null` (indicates leaderboard is hidden)
   */
  function formatLeaderboardName(student, displayMode, rankIndex) {
    const mode = String(displayMode || 'real_name').trim().toLowerCase();
    if (mode === 'hidden') {
      return '';
    }

    const s = student || {};
    const rawName = String(s.name || '').trim();
    const classID = String(s.classID || s.class || '').trim().toUpperCase();
    const idNum = parseInt(s.studentID !== undefined ? s.studentID : s.id, 10);
    const padId = isNaN(idNum)
      ? String(s.studentID || s.id || '01').padStart(2, '0')
      : String(idNum).padStart(2, '0');

    if (mode === 'anonymous') {
      const rankNum =
        typeof rankIndex === 'number' && !isNaN(rankIndex) ? rankIndex + 1 : 1;
      return `同學 #${rankNum}`;
    }

    if (mode === 'seat_no' || mode === 'seat_only') {
      return classID ? `${classID} #${padId}` : `#${padId}`;
    }

    if (mode === 'nickname') {
      if (!rawName) {
        return classID ? `${classID} #${padId}` : '同學';
      }
      const chars = Array.from(rawName);
      if (chars.length <= 1) return chars[0] + '*';
      if (chars.length === 2) return chars[0] + '*';
      return (
        chars[0] +
        '*'.repeat(chars.length - 2) +
        chars[chars.length - 1]
      );
    }

    // Default: 'real_name'
    return rawName || (classID ? `${classID} #${padId}` : '未知同學');
  }

  /**
   * Filters and limits ranked leaderboard entries.
   * When `options.minScore` is a valid number, entries with `score < minScore` are excluded.
   * Caps result length to `options.limit` (defaults to 10).
   */
  function buildLeaderboardEntries(entries, options) {
    const list = Array.isArray(entries) ? entries.slice() : [];
    const opts = options && typeof options === 'object' ? options : {};
    const hasMin =
      opts.minScore !== undefined &&
      opts.minScore !== null &&
      opts.minScore !== '' &&
      !isNaN(Number(opts.minScore));
    const minScore = hasMin ? Number(opts.minScore) : null;
    const limit =
      opts.limit !== undefined && opts.limit !== null && !isNaN(Number(opts.limit))
        ? Math.max(0, Number(opts.limit))
        : 10;

    const filtered =
      minScore !== null
        ? list.filter(function (item) {
            return item && Number(item.score) >= minScore;
          })
        : list;

    return filtered.slice(0, limit);
  }

  /**
   * A11 phone detection. Returns true only for phones (iPhone/Android phone/etc.);
   * iPad, Android tablets and desktops/laptops return false.
   * `envOverride` = { ua, maxTouch, minScreen, coarsePointer } for testing.
   */
  function isPhoneDevice(envOverride) {
    const env = envOverride || {};
    const g = typeof window !== 'undefined' ? window : {};
    const nav = g.navigator || {};
    const ua = String(env.ua != null ? env.ua : nav.userAgent || '');
    const maxTouch = Number(env.maxTouch != null ? env.maxTouch : nav.maxTouchPoints || 0);
    let minScreen = env.minScreen;
    if (minScreen == null) {
      const s = g.screen || {};
      minScreen = Math.min(Number(s.width || 0), Number(s.height || 0)) || 0;
    }
    minScreen = Number(minScreen) || 0;
    let coarse = env.coarsePointer;
    if (coarse == null) {
      try {
        coarse = !!(g.matchMedia && g.matchMedia('(pointer: coarse)').matches);
      } catch (e) {
        coarse = false;
      }
    }
    // Tablets / iPad -> keep embedded iframe
    if (/iPad/i.test(ua) || /Tablet|PlayBook|Silk/i.test(ua)) return false;
    if (/Macintosh/i.test(ua) && maxTouch > 1 && minScreen >= 600) return false;
    if (/Android/i.test(ua) && !/Mobile/i.test(ua) && (minScreen === 0 || minScreen >= 600)) return false;
    // Phones
    if (/iPhone|iPod/i.test(ua)) return true;
    if (/Android/i.test(ua) && /Mobile/i.test(ua)) return true;
    if (/Windows Phone|IEMobile|BlackBerry|Opera Mini|HarmonyOS.*Phone/i.test(ua)) return true;
    if (/Macintosh/i.test(ua) && maxTouch > 1 && minScreen > 0 && minScreen <= 540) return true;
    if (/Android/i.test(ua) && minScreen > 0 && minScreen <= 540) return true;
    if (maxTouch > 0 && coarse && minScreen > 0 && minScreen <= 540) return true;
    return false;
  }

  return {
    isPhoneDevice: isPhoneDevice,
    showScreen: showScreen,
    getCurrentScreen: getCurrentScreen,
    showToast: showToast,
    getToastHistory: getToastHistory,
    showModal: showModal,
    closeModal: closeModal,
    getActiveModal: getActiveModal,
    formatMMSS: formatMMSS,
    renderNetworkBanner: renderNetworkBanner,
    formatLeaderboardName: formatLeaderboardName,
    buildLeaderboardEntries: buildLeaderboardEntries,
  };
});
