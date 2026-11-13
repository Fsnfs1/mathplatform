/**
 * core/bonus.js
 * Unified Bonus Rules Engine (A8, D5), Points Economy & Mall Ledger (A13),
 * Online Network Arena Pairing (A12, D7), and Math Game Bridge (A11, D10).
 * Also exposes `window.GameBridge` for 1-line integration in `games/*.html`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./config.js'),
      require('./registry.js'),
      require('./storage.js'),
      require('./sync.js'),
      require('./netwatch.js')
    );
  } else {
    const mod = factory(
      root.MathCoreConfig,
      root.MathPlatformRegistry,
      root.MathCoreStorage,
      root.MathCoreSync,
      root.MathCoreNetwatch
    );
    root.MathCoreBonus = mod;
    root.GameBridge = mod.GameBridge;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (
  CONFIG,
  REGISTRY,
  STORAGE,
  SYNC,
  NETWATCH
) {
  'use strict';

  const BONUS_DEFAULTS = (CONFIG && CONFIG.bonusDefaults) || {
    drillThresholdScore: 80,
    pointsPerExtraScore: 1,
    defaultCapScore: 60,
  };

  const POINTS_RULES = (CONFIG && CONFIG.pointsRules) || {
    practiceCorrect: 1,
    drillCorrect: 2,
    adaptiveExtraCorrect: 3,
    reviewRetestCorrect: 1,
    arenaWin: 10,
    arenaLoss: 2,
    gameTop10Daily: 5,
    streak7Days: 10,
    dailyEarnCap: 150,
  };

  const GAMES_CFG = (CONFIG && CONFIG.games) || {
    dailyFreeLimitMs: 30 * 60 * 1000,
    warnRemainingMs: 5 * 60 * 1000,
    pointsPer10MinExtra: 20,
    maxExtraMinutesPerDay: 30,
  };

  const ARENA_CFG = (CONFIG && CONFIG.arena) || {
    timezoneOffsetMinutes: 480,
    weekdayWindow: { start: '17:00', end: '19:30' },
    weekendHolidayWindow: { start: '08:00', end: '19:30' },
    pairConfirmWindowMs: 60 * 1000,
  };

  const _memStore = {};

  function getLocalJson(key, fallback) {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(key);
        if (raw) return JSON.parse(raw);
      } else if (_memStore[key] !== undefined) {
        return JSON.parse(_memStore[key]);
      }
    } catch (e) {}
    return fallback;
  }

  function setLocalJson(key, val) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(val));
      } else {
        _memStore[key] = JSON.stringify(val);
      }
    } catch (e) {}
  }

  function getMacauDateParts(ts) {
    const ms = (ts || Date.now()) + (ARENA_CFG.timezoneOffsetMinutes || 480) * 60 * 1000;
    const d = new Date(ms);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const min = String(d.getUTCMinutes()).padStart(2, '0');
    const dayOfWeek = d.getUTCDay(); // 0=Sun .. 6=Sat
    return {
      dateStr: `${yyyy}-${mm}-${dd}`,
      timeStr: `${hh}:${min}`,
      dayOfWeek: dayOfWeek,
    };
  }

  // =========================================================================
  // 1. Automated Bonus Cap Calculator (A8, D5)
  // =========================================================================
  /**
   * Calculate final quiz/exam score with either:
   * - Drill mode (default): auto-bonus (from drill > 80) + redeemed bonus, capped at `capScore` (default 60).
   * - Correction mode (`bonusMode: 'correction'`): correction bonus (0..`maxCorrectionBonus`, default 5), capped at `capScore` (default 120).
   * Formula: final = max(raw, min(raw + bonus, capScore))
   */
  function calculateQuizFinalScore(params) {
    const p = params || {};
    const rawScore = Number(p.rawScore || 0);
    const rule = p.rule || {};
    const bonusMode = rule.bonusMode || p.bonusMode || 'drill';

    if (bonusMode === 'correction') {
      const maxCorrectionBonus =
        rule.maxCorrectionBonus !== undefined && rule.maxCorrectionBonus !== null
          ? Number(rule.maxCorrectionBonus)
          : p.maxCorrectionBonus !== undefined && p.maxCorrectionBonus !== null
            ? Number(p.maxCorrectionBonus)
            : 5;
      const capScore =
        rule.capScore !== undefined && rule.capScore !== null
          ? Number(rule.capScore)
          : p.capScore !== undefined && p.capScore !== null
            ? Number(p.capScore)
            : 120;
      const correctionBonus = Math.max(
        0,
        Math.min(Number(p.correctionBonus || 0), maxCorrectionBonus)
      );
      const uncappedTotal = rawScore + correctionBonus;
      const finalScore =
        capScore > 0 ? Math.max(rawScore, Math.min(uncappedTotal, capScore)) : uncappedTotal;
      const appliedBonus = Math.max(0, finalScore - rawScore);

      return {
        bonusMode: 'correction',
        rawScore: rawScore,
        correctionBonus: correctionBonus,
        maxCorrectionBonus: maxCorrectionBonus,
        drillScore: 0,
        threshold: 0,
        autoBonus: 0,
        redeemedBonus: 0,
        capScore: capScore,
        finalScore: finalScore,
        appliedBonus: appliedBonus,
      };
    }

    const drillScore = Number(p.drillScore || 0);
    const redeemedBonus = Math.max(0, Number(p.redeemedBonus || 0));

    const threshold =
      rule.threshold !== undefined ? Number(rule.threshold) : BONUS_DEFAULTS.drillThresholdScore;
    const perPoint =
      rule.perPoint !== undefined ? Number(rule.perPoint) : BONUS_DEFAULTS.pointsPerExtraScore;
    const capScore =
      rule.capScore !== undefined && rule.capScore !== null
        ? Number(rule.capScore)
        : BONUS_DEFAULTS.defaultCapScore;

    const autoBonus =
      drillScore > threshold ? Math.floor((drillScore - threshold) * perPoint) : 0;
    const uncappedTotal = rawScore + autoBonus + redeemedBonus;
    const finalScore =
      capScore > 0 ? Math.max(rawScore, Math.min(uncappedTotal, capScore)) : uncappedTotal;
    const appliedBonus = Math.max(0, finalScore - rawScore);

    return {
      bonusMode: 'drill',
      rawScore: rawScore,
      correctionBonus: 0,
      maxCorrectionBonus: 0,
      drillScore: drillScore,
      threshold: threshold,
      autoBonus: autoBonus,
      redeemedBonus: redeemedBonus,
      capScore: capScore,
      finalScore: finalScore,
      appliedBonus: appliedBonus,
    };
  }

  function calculateMajorExamFinalScore(params) {
    const p = Object.assign({}, params || {});
    const rule = Object.assign(
      { bonusMode: 'correction', maxCorrectionBonus: 5, capScore: 120 },
      p.rule || {}
    );
    return calculateQuizFinalScore(Object.assign({}, p, { bonusMode: 'correction', rule: rule }));
  }

  // =========================================================================
  // 2. Points Economy & Mall Ledger (A13)
  // =========================================================================
  const PointsLedger = {
    _key: function (sid) {
      return 'MP_V2_POINTS_' + String(sid || 'GUEST').toUpperCase();
    },

    getLedger: function (sid) {
      return getLocalJson(this._key(sid), { entries: [], mallOrders: [] });
    },

    getBalance: function (sid) {
      const ledger = this.getLedger(sid);
      let confirmed = 0;
      let pending = 0;
      ledger.entries.forEach(e => {
        if (e.revoked) return;
        if (e.status === 'pending') pending += e.amount;
        else confirmed += e.amount;
      });
      return {
        confirmed: Math.max(0, confirmed),
        pending: Math.max(0, pending),
        total: Math.max(0, confirmed + pending),
        entries: ledger.entries,
        mallOrders: ledger.mallOrders || [],
      };
    },

    awardPoints: function (sid, sourceType, customAmount, meta) {
      const ledger = this.getLedger(sid);
      const today = getMacauDateParts().dateStr;
      const baseAmount =
        typeof customAmount === 'number'
          ? customAmount
          : POINTS_RULES[sourceType] !== undefined
          ? POINTS_RULES[sourceType]
          : 1;

      // Enforce daily earn cap against point farming
      const earnedToday = ledger.entries
        .filter(e => !e.revoked && e.amount > 0 && e.dateStr === today)
        .reduce((acc, e) => acc + e.amount, 0);

      const allowedAmount = Math.max(
        0,
        Math.min(baseAmount, (POINTS_RULES.dailyEarnCap || 150) - earnedToday)
      );
      if (allowedAmount <= 0) {
        return { awarded: 0, reason: 'daily_cap_reached', balance: this.getBalance(sid) };
      }

      const netState =
        NETWATCH && typeof NETWATCH.getState === 'function' ? NETWATCH.getState() : null;
      const isOnlineMacau = !netState || netState.status === 'GREEN';
      const isOfflinePractice = sourceType === 'practiceCorrect';

      const entry = {
        id: 'PT_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        sid: sid,
        sourceType: sourceType,
        amount: allowedAmount,
        status: !isOnlineMacau || isOfflinePractice ? 'pending' : 'confirmed',
        dateStr: today,
        ts: Date.now(),
        meta: meta || {},
        revoked: false,
      };

      ledger.entries.push(entry);
      setLocalJson(this._key(sid), ledger);

      if (SYNC && typeof SYNC.recordAction === 'function') {
        SYNC.recordAction('points_earn', entry, { sid: sid });
      }

      return { awarded: allowedAmount, entry: entry, balance: this.getBalance(sid) };
    },

    confirmPendingPoints: function (sid) {
      const ledger = this.getLedger(sid);
      let count = 0;
      ledger.entries.forEach(e => {
        if (e.status === 'pending' && !e.revoked) {
          e.status = 'confirmed';
          count++;
        }
      });
      if (count > 0) setLocalJson(this._key(sid), ledger);
      return count;
    },

    redeemPoints: function (sid, targetType, cost, meta) {
      const bal = this.getBalance(sid);
      const ptsCost = Math.abs(Number(cost || 0));
      if (bal.confirmed < ptsCost) {
        return { ok: false, error: '可用已入帳積分不足（需 ' + ptsCost + ' 積分）' };
      }

      const ledger = this.getLedger(sid);
      const today = getMacauDateParts().dateStr;
      const entry = {
        id: 'REDEEM_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        sid: sid,
        sourceType: 'redeem_' + targetType, // 'quiz_bonus' | 'game_time' | 'mall_item'
        amount: -ptsCost,
        status: 'confirmed',
        dateStr: today,
        ts: Date.now(),
        meta: meta || {},
        revoked: false,
      };
      ledger.entries.push(entry);

      if (targetType === 'mall_item') {
        ledger.mallOrders = ledger.mallOrders || [];
        ledger.mallOrders.push({
          orderId: entry.id,
          sid: sid,
          itemTitle: (meta && meta.itemTitle) || '積分禮品',
          cost: ptsCost,
          teacherStatus: 'pending_approval',
          ts: entry.ts,
        });
      } else if (targetType === 'game_time') {
        const addMin = (meta && meta.minutes) || 10;
        GameBridge.addRedeemedMinutes(sid, addMin);
      }

      setLocalJson(this._key(sid), ledger);
      if (SYNC && typeof SYNC.recordAction === 'function') {
        SYNC.recordAction('points_redeem', entry, { sid: sid });
      }
      return { ok: true, entry: entry, balance: this.getBalance(sid) };
    },

    revokeEntry: function (sid, entryId, teacherId) {
      const ledger = this.getLedger(sid);
      const target = ledger.entries.find(e => e.id === entryId);
      if (!target) return false;
      target.revoked = true;
      target.revokedBy = teacherId || 'teacher';
      target.revokedAt = Date.now();
      setLocalJson(this._key(sid), ledger);
      return true;
    },
  };

  // =========================================================================
  // 3. Online Network Arena Schedule & Pairing (A12, D7)
  // =========================================================================
  const ArenaManager = {
    _lobbyKey: 'MP_V2_ARENA_LOBBY',

    /**
     * Check if Arena is open at given timestamp (Macau UTC+8):
     * - Mon–Fri: 17:00–19:30
     * - Sat, Sun, or Macau Public Holidays: 08:00–19:30
     */
    isOpenNow: function (ts, customHolidays) {
      const parts = getMacauDateParts(ts);
      const holidays = customHolidays || ARENA_CFG.macauHolidays || [];
      const isWeekend = parts.dayOfWeek === 0 || parts.dayOfWeek === 6;
      const isHoliday = holidays.includes(parts.dateStr);
      const win =
        isWeekend || isHoliday ? ARENA_CFG.weekendHolidayWindow : ARENA_CFG.weekdayWindow;
      const open = parts.timeStr >= win.start && parts.timeStr <= win.end;
      return {
        open: open,
        dateStr: parts.dateStr,
        timeStr: parts.timeStr,
        isWeekendOrHoliday: isWeekend || isHoliday,
        window: win,
      };
    },

    setAllowArena: function (student, allow) {
      const lobby = getLocalJson(this._lobbyKey, { pool: {}, matches: {} });
      const sid = student.classID + '_' + student.studentID;
      if (allow) {
        lobby.pool[sid] = {
          sid: sid,
          name: student.name,
          classID: student.classID,
          grade: String(student.classID || '').slice(0, 1),
          joinedAt: Date.now(),
          agreedAt: null,
        };
      } else {
        delete lobby.pool[sid];
      }
      setLocalJson(this._lobbyKey, lobby);
      return lobby.pool[sid] || null;
    },

    /**
     * Record a student clicking "同意" on an Arena invitation; if 2 terminals agree within 1 minute (60,000ms),
     * automatically pairs them with a shared question seed (D7).
     */
    acceptInvitation: function (student, acceptTs) {
      const now = acceptTs || Date.now();
      const lobby = getLocalJson(this._lobbyKey, { pool: {}, matches: {} });
      const sid = student.classID + '_' + student.studentID;
      const grade = String(student.classID || '').slice(0, 1);

      lobby.pool[sid] = {
        sid: sid,
        name: student.name || sid,
        classID: student.classID,
        grade: grade,
        joinedAt: (lobby.pool[sid] && lobby.pool[sid].joinedAt) || now,
        agreedAt: now,
      };

      const windowMs = ARENA_CFG.pairConfirmWindowMs || 60 * 1000;
      const candidates = Object.values(lobby.pool).filter(
        p => p.sid !== sid && p.agreedAt && Math.abs(now - p.agreedAt) <= windowMs
      );

      // Prioritize same-grade random match (D7)
      candidates.sort((a, b) => {
        const aSame = a.grade === grade ? 0 : 1;
        const bSame = b.grade === grade ? 0 : 1;
        return aSame !== bSame ? aSame - bSame : Math.random() - 0.5;
      });

      let match = null;
      if (candidates.length > 0) {
        const opp = candidates[0];
        const matchId = 'ARENA_' + now + '_' + Math.random().toString(36).slice(2, 6);
        match = {
          matchId: matchId,
          seed: Math.floor(Math.random() * 1000000),
          players: [lobby.pool[sid], opp],
          createdAt: now,
          status: 'READY_POPUP', // Triggers popup "進入擂台賽" on both terminals
        };
        lobby.matches[matchId] = match;
        delete lobby.pool[sid];
        delete lobby.pool[opp.sid];
      }

      setLocalJson(this._lobbyKey, lobby);
      if (SYNC && typeof SYNC.recordAction === 'function') {
        SYNC.recordAction('arena_accept', { sid: sid, matched: !!match, matchId: match && match.matchId }, { sid: sid });
      }
      return { matched: !!match, match: match };
    },
  };

  // =========================================================================
  // 4. Math Game Bridge & 30-Min Anti-Addiction (A11, D10)
  // =========================================================================
  const GameBridge = {
    _timeKey: function (sid, dateStr) {
      const prefix =
        (CONFIG && CONFIG.storageKeys && CONFIG.storageKeys.gamePlaytimePrefix) ||
        'MP_V2_GAME_TIME_';
      return prefix + String(sid || 'GUEST').toUpperCase() + '_' + (dateStr || getMacauDateParts().dateStr);
    },
    _boardKey: function (gameId) {
      return 'MP_V2_GAMEBOARD_' + String(gameId || 'trig-ratio');
    },

    getCurrentStudent: function () {
      const sess = getLocalJson('MP_V2_SESSION', null);
      if (sess && sess.classID && sess.studentID) return sess;
      return { classID: '4C', studentID: '1', name: '實名同學' };
    },

    getPlaytimeStatus: function (sid) {
      const student = sid ? { sid: sid } : this.getCurrentStudent();
      const resolvedSid = student.sid || student.classID + '_' + student.studentID;
      const rec = getLocalJson(this._timeKey(resolvedSid), {
        usedMs: 0,
        redeemedExtraMs: 0,
      });
      const totalAllowedMs =
        (GAMES_CFG.dailyFreeLimitMs || 30 * 60 * 1000) + (rec.redeemedExtraMs || 0);
      const remainingMs = Math.max(0, totalAllowedMs - (rec.usedMs || 0));
      return {
        sid: resolvedSid,
        usedMs: rec.usedMs || 0,
        redeemedExtraMs: rec.redeemedExtraMs || 0,
        totalAllowedMs: totalAllowedMs,
        remainingMs: remainingMs,
        warn: remainingMs > 0 && remainingMs <= (GAMES_CFG.warnRemainingMs || 5 * 60 * 1000),
        locked: remainingMs <= 0,
      };
    },

    recordPlayDuration: function (sid, addMs) {
      const key = this._timeKey(sid);
      const rec = getLocalJson(key, { usedMs: 0, redeemedExtraMs: 0 });
      rec.usedMs = Math.max(0, (rec.usedMs || 0) + Math.max(0, Number(addMs || 0)));
      setLocalJson(key, rec);
      return this.getPlaytimeStatus(sid);
    },

    addRedeemedMinutes: function (sid, minutes) {
      const key = this._timeKey(sid);
      const rec = getLocalJson(key, { usedMs: 0, redeemedExtraMs: 0 });
      const maxExtraMs = (GAMES_CFG.maxExtraMinutesPerDay || 30) * 60 * 1000;
      const addMs = Math.max(0, Number(minutes || 10)) * 60 * 1000;
      rec.redeemedExtraMs = Math.min(maxExtraMs, (rec.redeemedExtraMs || 0) + addMs);
      setLocalJson(key, rec);
      return this.getPlaytimeStatus(sid);
    },

    /**
     * Standardized score calculation (D10):
     * - 'trig-ratio' (328.HTML): native score
     * - 'bash-nim' (2.HTML) & 'ring-nim' (4.html): Win = 100 + max(0, 60 - durationSec), Loss = 0
     */
    computeGameScore: function (payload) {
      const p = payload || {};
      const gameId = p.gameId || 'trig-ratio';
      if (gameId === 'bash-nim' || gameId === 'ring-nim' || p.scoringMode === 'win_speed') {
        if (!p.win) return 0;
        const durationSec = Math.floor(Math.max(0, Number(p.durationMs || 0)) / 1000);
        return 100 + Math.max(0, 60 - durationSec);
      }
      return Math.max(0, Number(p.score || 0));
    },

    /**
     * 1-line hook called at end of `games/328.HTML`, `games/2.HTML`, `games/4.html`:
     * `window.GameBridge && window.GameBridge.report({ gameId, score, win, durationMs })`
     */
    report: function (payload) {
      const p = payload || {};
      const stu = p.student || this.getCurrentStudent();
      const sid = stu.classID + '_' + stu.studentID;
      const gameId = p.gameId || 'trig-ratio';
      const durationMs = Math.max(1000, Number(p.durationMs || 15000));

      const timeStatus = this.recordPlayDuration(sid, durationMs);
      const finalScore = this.computeGameScore({
        gameId: gameId,
        score: p.score,
        win: p.win,
        durationMs: durationMs,
      });

      const board = getLocalJson(this._boardKey(gameId), []);
      board.push({
        sid: sid,
        classID: stu.classID,
        studentID: stu.studentID,
        name: stu.name || sid,
        score: finalScore,
        win: !!p.win,
        durationMs: durationMs,
        dateStr: getMacauDateParts().dateStr,
        ts: Date.now(),
      });
      board.sort((a, b) => b.score - a.score || a.durationMs - b.durationMs);
      const top10 = board.slice(0, 10);
      setLocalJson(this._boardKey(gameId), top10);

      const inTop10 = top10.some(item => item.sid === sid && item.score === finalScore && finalScore > 0);
      if (inTop10) {
        PointsLedger.awardPoints(sid, 'gameTop10Daily', POINTS_RULES.gameTop10Daily, {
          gameId: gameId,
          score: finalScore,
        });
      }

      if (SYNC && typeof SYNC.recordAction === 'function') {
        SYNC.recordAction(
          'game_finish',
          {
            gameId: gameId,
            score: finalScore,
            win: !!p.win,
            durationMs: durationMs,
            inTop10: inTop10,
          },
          { sid: sid, classID: stu.classID, studentID: stu.studentID }
        );
      }

      if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
        try {
          window.parent.postMessage(
            {
              type: 'MATH_GAME_REPORT',
              gameId: gameId,
              sid: sid,
              score: finalScore,
              top10: top10,
              playtime: timeStatus,
            },
            '*'
          );
        } catch (e) {}
      }

      return {
        sid: sid,
        gameId: gameId,
        score: finalScore,
        inTop10: inTop10,
        top10: top10,
        playtime: timeStatus,
      };
    },

    getTop10: function (gameId) {
      return getLocalJson(this._boardKey(gameId || 'trig-ratio'), []);
    },
  };

  return {
    calculateQuizFinalScore: calculateQuizFinalScore,
    calculateMajorExamFinalScore: calculateMajorExamFinalScore,
    PointsLedger: PointsLedger,
    ArenaManager: ArenaManager,
    GameBridge: GameBridge,
    getMacauDateParts: getMacauDateParts,
  };
});
