/**
 * core/config.js
 * Single source of truth for endpoints, sync intervals, security parameters,
 * arena schedules, game anti-addiction, and default bonus rules.
 * Works as both ES Module and UMD/window global (`window.MathCoreConfig`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MathCoreConfig = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const CONFIG = {
    version: '2.0.0-20261106',

    // === Single Backend Endpoints (replaces 32 hardcoded occurrences) ===
    endpoints: {
      googleFormUrl:
        'https://docs.google.com/forms/u/0/d/e/1FAIpQLSeLZ6E4kLjJ26aWrKRPRPtDdthkxRHqOPX5AOwAq8_TYiT-OQ/formResponse',
      formFields: {
        classID: 'entry.543502435',
        studentID: 'entry.1745113091',
        dateID: 'entry.1972335137',
        score: 'entry.2095507383',
      },
      gasDriveUploaderUrl:
        'https://script.google.com/macros/s/AKfycbxjkXzqp4WOghvi__SF8qoVBGAcXcSKv96JoRsKN3hLU6xHwLjK4rHyaXODIv_fE9Ak/exec',
      gasSheetReaderUrl:
        'https://script.google.com/macros/s/AKfycbwNAQNxmNsNa8rWGp48qnYRrjA2WFLGIzKqSel2r8MilRp59s3ZfBJjeKXIrUfoS-Zp-g/exec',
      driveFolderId: '1oY52JyAqLLQQiETq8A-hre9jZ_goLHiY',
    },

    // === Sync Policy (D1) ===
    sync: {
      practiceIntervalMs: 24 * 60 * 60 * 1000, // >= 24 hours for offline practice
      onlineBatchIntervalMs: 60 * 1000,        // 1 minute micro-batch for online/exam/game
      maxEventsPerFormPost: 40,                // split large 1-min batches safely under Form URL limits
      networkProbeTimeoutMs: 3500,
      netwatchIntervalMs: 30 * 1000,           // probe every 30s
    },

    // === Crypto Parameters (S1, S2, S4, D6) ===
    crypto: {
      pbkdf2Iterations: 100000,
      saltPrefix: 'MATHPLATFORM_V2_SALT',
      consentVersion: '2026-11-v1',
    },

    // === Adaptive Engine Defaults (D4, D8 — shared across all question banks) ===
    adaptiveDefaults: {
      baseQuota: 25,
      maxQuota: 60,
      hastyThresholdMs: 3000,
      hastyAddCount: 5,
      wrongStreakTrigger: 3,
      wrongStreakAddCount: 3,
      maliciousAllSelectedStreak: 3,
      maliciousHastyCount: 5,
      maliciousSamePatternStreak: 4,
      maliciousTargetQuota: 60,
      prioritizePrevRoundWrong: true,
      tierOrder: [
        [4, 0.5],
        [6, 0.2],
        [8, 0.3],
      ],
    },

    // === Bonus Cap Defaults (D5) ===
    bonusDefaults: {
      drillThresholdScore: 80, // >80 gets +1 quiz score per 1 pt above 80
      pointsPerExtraScore: 1,
      defaultCapScore: 60,     // teacher-configurable per quiz
    },

    // === Math Games & Anti-Addiction (A11, D10) ===
    games: {
      dailyFreeLimitMs: 30 * 60 * 1000, // 30 minutes per day
      warnRemainingMs: 5 * 60 * 1000,   // warn when 5 minutes left
      pointsPer10MinExtra: 20,          // 20 points -> +10 minutes
      maxExtraMinutesPerDay: 30,
      catalog: [
        {
          id: 'trig-ratio',
          title: '三角比極速挑戰',
          path: 'games/328.HTML',
          mobilePath: 'games/328-mobile.html',
          scoringMode: 'native',
        },
        {
          id: 'bash-nim',
          title: '高級巴什博弈挑戰',
          path: 'games/2.HTML',
          mobilePath: 'games/2-mobile.html',
          scoringMode: 'win_speed', // Win = 100 + max(0, 60 - durationSec)
        },
        {
          id: 'ring-nim',
          title: '高級套圈博弈挑戰',
          path: 'games/4.html',
          mobilePath: 'games/4-mobile.html',
          scoringMode: 'win_speed', // Win = 100 + max(0, 60 - durationSec)
        },
      ],
    },

    // === Online Arena Schedule (A12, D7 — Macau UTC+8) ===
    arena: {
      timezoneOffsetMinutes: 480, // UTC+8 (Macau)
      weekdayWindow: { start: '17:00', end: '19:30' },
      weekendHolidayWindow: { start: '08:00', end: '19:30' },
      pairConfirmWindowMs: 60 * 1000, // 1 minute mutual accept window
      pollIntervalMs: 5000,
      maxLobbyWaitMs: 120 * 1000,
      // Teacher can update Macau public holidays in Teacher Console (YYYY-MM-DD)
      macauHolidays: [
        '2026-11-02',
        '2026-12-08',
        '2026-12-20',
        '2026-12-21',
        '2026-12-22',
        '2026-12-24',
        '2026-12-25',
        '2027-01-01',
      ],
    },

    // === Points Economy Rules (A13) ===
    pointsRules: {
      practiceCorrect: 1,
      drillCorrect: 2,
      adaptiveExtraCorrect: 3,
      reviewRetestCorrect: 1,
      arenaWin: 10,
      arenaLoss: 2,
      gameTop10Daily: 5,
      streak7Days: 10,
      dailyEarnCap: 150,
    },

    // === Storage Keys ===
    storageKeys: {
      dbName: 'MathPlatformV2DB',
      eventLogStore: 'interaction_events',
      outboxKey: 'MP_V2_OUTBOX',
      lastPracticeSyncKey: 'MP_V2_LAST_PRACTICE_SYNC_TS',
      lastOnlineSyncKey: 'MP_V2_LAST_ONLINE_SYNC_TS',
      sessionKey: 'MP_V2_SESSION',
      consentKeyPrefix: 'MP_V2_CONSENT_',
      gamePlaytimePrefix: 'MP_V2_GAME_TIME_',
      pointsCachePrefix: 'MP_V2_POINTS_',
      seqCounterKey: 'MP_V2_SEQ_COUNTER',
    },
  };

  return CONFIG;
});
