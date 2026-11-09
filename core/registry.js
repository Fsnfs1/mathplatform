/**
 * core/registry.js
 * Central declarative registry for classes, extraRoster, banks, exams,
 * scorePacks, bonusRules, and games (F21).
 * Supports 5+1 zero-code-change extension scenarios and runtime registration.
 * Works as both CommonJS (`module.exports`) and Browser global (`window.MathPlatformRegistry`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./config.js'));
  } else {
    root.MathPlatformRegistry = factory(root.MathCoreConfig);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (CONFIG) {
  'use strict';

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  const DEFAULT_CLASSES = ['4C', '4D', '5B', '5C'];

  const DEFAULT_BANKS = [
    {
      id: '4cd_1023',
      title: '高一 1023 函數題庫',
      globalVar: 'QUESTIONS_4CD1023',
      script: 'js/questions_4cd1023.js',
      classes: ['4C', '4D'],
    },
    {
      id: '4cd_1102',
      title: '高一 1102 函數進階題庫',
      globalVar: 'BANK_4CD_T2',
      globalVarAliases: ['BANK_4CD_T2_ALL'],
      subKey: 'all',
      script: 'js/bank_4cd_t2.js',
      adaptiveVar: 'BANK_4CD_1102_ADAPTIVE',
      adaptiveScript: 'js/bank_4cd_1102_adaptive.js',
      classes: ['4C', '4D'],
    },
    {
      id: '5bc_1102',
      title: '高二 1102 空間幾何與數列題庫',
      globalVar: 'BANK_5BC1102',
      script: 'js/bank_5bc1102.js',
      classes: ['5B', '5C'],
    },
  ];

  const DEFAULT_EXAMS = [
    {
      id: 'drill_4cd_1023',
      title: '4CD 1023 函數自適應刷題',
      bankId: '4cd_1023',
      mode: 'drill',
      classes: ['4C', '4D'],
      timeLimitMin: 15,
      feedbackMode: 'immediate',
      adaptive: Object.assign(
        {},
        (CONFIG && CONFIG.adaptiveDefaults) || {
          baseQuota: 25,
          maxQuota: 60,
          hastyThresholdMs: 3000,
          hastyAddCount: 5,
          wrongStreakTrigger: 3,
          wrongStreakAddCount: 3,
        }
      ),
    },
    {
      id: 'drill_4cd_1102',
      title: '4CD 1102 函數進階聯網刷題',
      bankId: '4cd_1102',
      mode: 'drill',
      classes: ['4C', '4D'],
      timeLimitMin: 15,
      feedbackMode: 'immediate',
      adaptive: Object.assign(
        {},
        (CONFIG && CONFIG.adaptiveDefaults) || {
          baseQuota: 25,
          maxQuota: 60,
          hastyThresholdMs: 3000,
          hastyAddCount: 5,
          wrongStreakTrigger: 3,
          wrongStreakAddCount: 3,
        }
      ),
    },
    {
      id: 'exam_4cd_1102',
      title: '4CD 1102 隨堂小測',
      bankId: '4cd_1102',
      subKey: 'exam',
      mode: 'exam',
      classes: ['4C', '4D'],
      timeLimitMin: 15,
      feedbackMode: 'after_submit',
      adaptive: false,
      guard: { macau: true, tabSwitchLimit: 3, photoCheck: true },
    },
    {
      id: 'drill_5bc_1102',
      title: '5BC 1102 聯網自適應刷題',
      bankId: '5bc_1102',
      mode: 'drill',
      classes: ['5B', '5C'],
      timeLimitMin: 15,
      feedbackMode: 'immediate',
      adaptive: Object.assign(
        {},
        (CONFIG && CONFIG.adaptiveDefaults) || {},
        { wrongStreakAddCount: 2, wrongStreakScope: 'category' }
      ),
    },
    {
      id: 'exam_5bc_1102',
      title: '5BC 1102 隨堂測驗',
      bankId: '5bc_1102',
      mode: 'exam',
      classes: ['5B', '5C'],
      timeLimitMin: 15,
      feedbackMode: 'after_submit',
      adaptive: true,
      guard: { macau: true, tabSwitchLimit: 3, photoCheck: true },
    },
  ];

  const DEFAULT_SCORE_PACKS = [
    {
      id: 'quiz_1023',
      title: '1023 隨堂小測',
      classes: ['4C', '4D', '5B'],
      adapter: 'quiz1023_store',
      script: 'js/quiz1023_encrypted_store.js',
    },
    {
      id: 'quiz_1030',
      title: '1030 加密考卷詳情',
      classes: ['4C', '4D', '5B'],
      adapter: 'enc_folder',
      folder: 'quiz_results',
      indexFile: 'quiz_results/index.json',
      saltPrefix: 'F4CD_1030_SECRET_',
    },
    {
      id: 'quiz_1106',
      title: '1106 隨堂小測',
      classes: ['4C', '4D', '5B', '5C'],
      adapter: 'sheet_live',
    },
  ];

  const DEFAULT_BONUS_RULES = [
    {
      id: 'bonus_1106_4cd',
      targetScorePackId: 'quiz_1106',
      sourceExamId: 'drill_4cd_1102',
      classes: ['4C', '4D'],
      threshold: 80,
      perPoint: 1,
      capScore: 60,
    },
    {
      id: 'bonus_1106_5bc',
      targetScorePackId: 'quiz_1106',
      sourceExamId: 'drill_5bc_1102',
      classes: ['5B', '5C'],
      threshold: 80,
      perPoint: 1,
      capScore: 60,
    },
  ];

  const DEFAULT_GAMES =
    CONFIG && CONFIG.games && Array.isArray(CONFIG.games.catalog)
      ? deepClone(CONFIG.games.catalog)
      : [
          {
            id: 'trig-ratio',
            title: '三角比極速挑戰',
            path: 'games/328.HTML',
            scoringMode: 'native',
          },
          {
            id: 'bash-nim',
            title: '高級巴什博弈挑戰',
            path: 'games/2.HTML',
            scoringMode: 'win_speed',
          },
          {
            id: 'ring-nim',
            title: '高級套圈博弈挑戰',
            path: 'games/4.html',
            scoringMode: 'win_speed',
          },
        ];

  const DEFAULT_EXTRA_ROSTER = DEFAULT_CLASSES.map(function (cls) {
    return {
      id: 98,
      name: '教師測試帳戶 (直通題庫)',
      grade: cls.startsWith('5') ? 11 : 10,
      classID: cls,
      isTeacherTest: true,
      directToBank: true,
    };
  });

  const DEFAULT_ANNOUNCEMENTS = [
    {
      id: 'ann_welcome',
      title: '📢 歡迎使用 MathPlatform 智慧課後學習與評測平臺',
      content: '歡迎同學們使用本平臺進行課後自主刷題與隨堂小測。系統支援斷網自適應練習、錯題重練及積分兌換加分獎勵，有任何數學疑問歡迎於求助專區提問！',
      priority: 'urgent', // 'urgent' | 'normal' | 'tip'
      targetClasses: ['4C', '4D', '5B', '5C'],
      publishTs: Date.now() - 3600000,
      expireTs: Date.now() + 86400000 * 30,
      isPinned: true,
      author: '數學教研組'
    }
  ];

  const registry = {
    classes: deepClone(DEFAULT_CLASSES),
    extraRoster: deepClone(DEFAULT_EXTRA_ROSTER),
    banks: deepClone(DEFAULT_BANKS),
    exams: deepClone(DEFAULT_EXAMS),
    scorePacks: deepClone(DEFAULT_SCORE_PACKS),
    bonusRules: deepClone(DEFAULT_BONUS_RULES),
    games: deepClone(DEFAULT_GAMES),
    announcements: deepClone(DEFAULT_ANNOUNCEMENTS),
  };

  function normalizeClassId(cls) {
    return String(cls || '').trim().toUpperCase();
  }

  function inferGradeFromClass(classCode) {
    const c = normalizeClassId(classCode);
    if (c.startsWith('4')) return 10;
    if (c.startsWith('5')) return 11;
    if (c.startsWith('6')) return 12;
    return 10;
  }

  function registerClass(classCode) {
    const norm = normalizeClassId(classCode);
    if (!norm) throw new Error('classCode is required');
    if (registry.classes.indexOf(norm) === -1) {
      registry.classes.push(norm);
    }
    const has98 = registry.extraRoster.some(function (s) {
      return s.classID === norm && String(s.id) === '98';
    });
    if (!has98) {
      registry.extraRoster.push({
        id: 98,
        name: '教師測試帳戶 (直通題庫)',
        grade: inferGradeFromClass(norm),
        classID: norm,
        isTeacherTest: true,
        directToBank: true,
      });
    }
    return norm;
  }

  function registerExtraStudent(studentObj) {
    if (!studentObj || !studentObj.classID || studentObj.id === undefined || !studentObj.name) {
      throw new Error('studentObj requires classID, id, and name');
    }
    const cls = normalizeClassId(studentObj.classID);
    registerClass(cls);
    const idNum = parseInt(studentObj.id, 10);
    const entry = {
      id: isNaN(idNum) ? studentObj.id : idNum,
      name: String(studentObj.name).trim(),
      grade: studentObj.grade || inferGradeFromClass(cls),
      classID: cls,
    };
    const existingIdx = registry.extraRoster.findIndex(function (s) {
      return s.classID === cls && String(s.id) === String(entry.id);
    });
    if (existingIdx >= 0) {
      registry.extraRoster[existingIdx] = entry;
    } else {
      registry.extraRoster.push(entry);
    }
    return entry;
  }

  function loadBaseRosterData(baseRosterData) {
    if (baseRosterData && typeof baseRosterData === 'object') {
      return baseRosterData;
    }
    if (typeof globalThis !== 'undefined' && globalThis.ROSTER_DATA) {
      return globalThis.ROSTER_DATA;
    }
    if (typeof require === 'function') {
      try {
        const rosterMod = require('../js/roster.js');
        if (rosterMod && rosterMod.ROSTER_DATA) {
          return rosterMod.ROSTER_DATA;
        }
      } catch (e) {
        // ignore if not found
      }
    }
    return {};
  }

  /**
   * Merges base `ROSTER_DATA` (from `js/roster.js` without modifying it) with `registry.extraRoster`.
   * Returns a cloned object mapping `classID -> Array<{ id, name, grade, classID }>`.
   */
  function getMergedRoster(baseRosterData) {
    const rawBase = loadBaseRosterData(baseRosterData);
    const merged = {};

    for (let i = 0; i < registry.classes.length; i++) {
      const cls = registry.classes[i];
      merged[cls] = Array.isArray(rawBase[cls]) ? deepClone(rawBase[cls]) : [];
    }

    const baseKeys = Object.keys(rawBase || {});
    for (let i = 0; i < baseKeys.length; i++) {
      const cls = normalizeClassId(baseKeys[i]);
      if (!merged[cls]) {
        merged[cls] = Array.isArray(rawBase[baseKeys[i]]) ? deepClone(rawBase[baseKeys[i]]) : [];
      }
    }

    for (let i = 0; i < registry.extraRoster.length; i++) {
      const extra = registry.extraRoster[i];
      const cls = normalizeClassId(extra.classID);
      if (!merged[cls]) merged[cls] = [];
      const idx = merged[cls].findIndex(function (s) {
        return String(s.id) === String(extra.id);
      });
      const copy = deepClone(extra);
      if (idx >= 0) {
        merged[cls][idx] = copy;
      } else {
        merged[cls].push(copy);
      }
    }

    // Ensure every class has seat #98 teacher test account
    Object.keys(merged).forEach(function (cls) {
      const has98 = merged[cls].some(function (s) {
        return String(s.id) === '98';
      });
      if (!has98) {
        merged[cls].push({
          id: 98,
          name: '教師測試帳戶 (直通題庫)',
          grade: inferGradeFromClass(cls),
          classID: cls,
          isTeacherTest: true,
          directToBank: true,
        });
      }
    });

    return merged;
  }

  function upsertById(list, obj, requiredFields) {
    if (!obj || !obj.id) {
      throw new Error('Registration object requires an id');
    }
    if (Array.isArray(requiredFields)) {
      for (let i = 0; i < requiredFields.length; i++) {
        const f = requiredFields[i];
        if (obj[f] === undefined || obj[f] === null || obj[f] === '') {
          throw new Error('Registration object missing required field: ' + f);
        }
      }
    }
    const copy = deepClone(obj);
    const idx = list.findIndex(function (item) {
      return item.id === copy.id;
    });
    if (idx >= 0) {
      list[idx] = Object.assign({}, list[idx], copy);
      return list[idx];
    }
    list.push(copy);
    return copy;
  }

  function registerBank(bankObj) {
    if (bankObj && bankObj.globalVar === 'BANK_4CD_T2_ALL') {
      bankObj = Object.assign({}, bankObj, {
        globalVar: 'BANK_4CD_T2',
        globalVarAliases: ['BANK_4CD_T2_ALL'],
        subKey: bankObj.subKey || 'all',
      });
    }
    const entry = upsertById(registry.banks, bankObj, ['title']);
    if (Array.isArray(entry.classes)) {
      entry.classes.forEach(registerClass);
    }
    return entry;
  }

  function registerExam(examObj) {
    const entry = upsertById(registry.exams, examObj, ['title', 'bankId']);
    if (Array.isArray(entry.classes)) {
      entry.classes.forEach(registerClass);
    }
    return entry;
  }

  function registerScorePack(packObj) {
    const entry = upsertById(registry.scorePacks, packObj, ['title', 'adapter']);
    if (Array.isArray(entry.classes)) {
      entry.classes.forEach(registerClass);
    }
    return entry;
  }

  function registerBonusRule(ruleObj) {
    const entry = upsertById(registry.bonusRules, ruleObj, ['targetScorePackId', 'sourceExamId']);
    if (entry.capScore === undefined) {
      entry.capScore =
        (CONFIG && CONFIG.bonusDefaults && CONFIG.bonusDefaults.defaultCapScore) || 60;
    }
    if (entry.threshold === undefined) {
      entry.threshold =
        (CONFIG && CONFIG.bonusDefaults && CONFIG.bonusDefaults.drillThresholdScore) || 80;
    }
    if (entry.perPoint === undefined) {
      entry.perPoint =
        (CONFIG && CONFIG.bonusDefaults && CONFIG.bonusDefaults.pointsPerExtraScore) || 1;
    }
    return entry;
  }

  function registerGame(gameObj) {
    return upsertById(registry.games, gameObj, ['title', 'path']);
  }

  function registerAnnouncement(annObj) {
    if (!annObj.id) {
      annObj.id = 'ann_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    }
    if (!annObj.publishTs) annObj.publishTs = Date.now();
    if (!annObj.priority) annObj.priority = 'normal';
    if (!Array.isArray(annObj.targetClasses) || annObj.targetClasses.length === 0) {
      annObj.targetClasses = ['*'];
    }
    return upsertById(registry.announcements, annObj, ['title', 'content']);
  }

  function matchesClass(itemClasses, classID) {
    if (!classID) return true;
    if (!Array.isArray(itemClasses) || itemClasses.length === 0) return true;
    if (itemClasses.indexOf('*') >= 0 || itemClasses.indexOf('ALL') >= 0) return true;
    const norm = normalizeClassId(classID);
    return itemClasses.some(function (c) {
      return normalizeClassId(c) === norm;
    });
  }

  function getAnnouncementsForClass(classID) {
    const now = Date.now();
    return (registry.announcements || []).filter(function (ann) {
      const okClass = matchesClass(ann.targetClasses, classID);
      const notExpired = !ann.expireTs || ann.expireTs > now;
      return okClass && notExpired;
    }).sort(function (a, b) {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return (b.publishTs || 0) - (a.publishTs || 0);
    });
  }

  function getBanksForClass(classID) {
    return registry.banks.filter(function (b) {
      return matchesClass(b.classes, classID);
    });
  }

  function getExamsForClass(classID, mode) {
    return registry.exams.filter(function (e) {
      const okClass = matchesClass(e.classes, classID);
      const okMode = !mode || e.mode === mode;
      return okClass && okMode;
    });
  }

  function getScorePacksForClass(classID) {
    return registry.scorePacks.filter(function (p) {
      return matchesClass(p.classes, classID);
    });
  }

  function getBonusRulesForClass(classID) {
    return registry.bonusRules.filter(function (r) {
      return matchesClass(r.classes, classID);
    });
  }

  function getBankById(bankIdOrGlobalVar) {
    if (!bankIdOrGlobalVar) return null;
    return (
      registry.banks.find(function (b) {
        if (b.id === bankIdOrGlobalVar || b.globalVar === bankIdOrGlobalVar) return true;
        if (Array.isArray(b.globalVarAliases) && b.globalVarAliases.indexOf(bankIdOrGlobalVar) >= 0) {
          return true;
        }
        return false;
      }) || null
    );
  }

  /**
   * Resolves a bank's raw global data from `root` / `globalThis`, supporting
   * `BANK_4CD_T2` (`{ exam: [...], practice: [...] }`) and `'BANK_4CD_T2_ALL'` alias.
   */
  function resolveBankGlobalData(bankOrId, rootScope) {
    const scope = rootScope || (typeof globalThis !== 'undefined' ? globalThis : {});
    const bank = typeof bankOrId === 'string' ? getBankById(bankOrId) : bankOrId;
    if (!bank) return null;

    let raw = scope[bank.globalVar];
    if (!raw && Array.isArray(bank.globalVarAliases)) {
      for (let i = 0; i < bank.globalVarAliases.length; i++) {
        if (scope[bank.globalVarAliases[i]]) {
          raw = scope[bank.globalVarAliases[i]];
          break;
        }
      }
    }
    if (!raw && bank.globalVar === 'BANK_4CD_T2_ALL' && scope.BANK_4CD_T2) {
      raw = scope.BANK_4CD_T2;
    }
    if (!raw) return null;

    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'object') {
      const subKey = bank.subKey || 'all';
      if (subKey === 'exam' && Array.isArray(raw.exam)) return raw.exam;
      if (subKey === 'practice' && Array.isArray(raw.practice)) return raw.practice;
      const combined = [];
      if (Array.isArray(raw.exam)) combined.push.apply(combined, raw.exam);
      if (Array.isArray(raw.practice)) combined.push.apply(combined, raw.practice);
      return combined;
    }
    return null;
  }

  function exportRegistrySnippet() {
    const snapshot = {
      classes: registry.classes,
      extraRoster: registry.extraRoster,
      banks: registry.banks,
      exams: registry.exams,
      scorePacks: registry.scorePacks,
      bonusRules: registry.bonusRules,
      games: registry.games,
      announcements: registry.announcements,
    };
    return (
      '// Auto-generated by MathPlatformRegistry Config Generator\n' +
      'window.MathPlatformRegistryData = ' +
      JSON.stringify(snapshot, null, 2) +
      ';\n' +
      'if (window.MathPlatformRegistry && typeof window.MathPlatformRegistry.importSnapshot === "function") {\n' +
      '  window.MathPlatformRegistry.importSnapshot(window.MathPlatformRegistryData);\n' +
      '}\n'
    );
  }

  function importSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return registry;
    if (Array.isArray(snapshot.classes)) registry.classes = deepClone(snapshot.classes);
    if (Array.isArray(snapshot.extraRoster)) registry.extraRoster = deepClone(snapshot.extraRoster);
    if (Array.isArray(snapshot.banks)) registry.banks = deepClone(snapshot.banks);
    if (Array.isArray(snapshot.exams)) registry.exams = deepClone(snapshot.exams);
    if (Array.isArray(snapshot.scorePacks)) registry.scorePacks = deepClone(snapshot.scorePacks);
    if (Array.isArray(snapshot.bonusRules)) registry.bonusRules = deepClone(snapshot.bonusRules);
    if (Array.isArray(snapshot.games)) registry.games = deepClone(snapshot.games);
    if (Array.isArray(snapshot.announcements)) registry.announcements = deepClone(snapshot.announcements);
    return registry;
  }

  function resetToDefaults() {
    registry.classes = deepClone(DEFAULT_CLASSES);
    registry.extraRoster = [];
    registry.banks = deepClone(DEFAULT_BANKS);
    registry.exams = deepClone(DEFAULT_EXAMS);
    registry.scorePacks = deepClone(DEFAULT_SCORE_PACKS);
    registry.bonusRules = deepClone(DEFAULT_BONUS_RULES);
    registry.games = deepClone(DEFAULT_GAMES);
    registry.announcements = deepClone(DEFAULT_ANNOUNCEMENTS);
    return registry;
  }

  registry.registerClass = registerClass;
  registry.registerExtraStudent = registerExtraStudent;
  registry.getMergedRoster = getMergedRoster;
  registry.registerBank = registerBank;
  registry.registerExam = registerExam;
  registry.registerScorePack = registerScorePack;
  registry.registerBonusRule = registerBonusRule;
  registry.registerGame = registerGame;
  registry.registerAnnouncement = registerAnnouncement;
  registry.getAnnouncementsForClass = getAnnouncementsForClass;
  registry.getBanksForClass = getBanksForClass;
  registry.getExamsForClass = getExamsForClass;
  registry.getScorePacksForClass = getScorePacksForClass;
  registry.getBonusRulesForClass = getBonusRulesForClass;
  registry.getBankById = getBankById;
  registry.resolveBankGlobalData = resolveBankGlobalData;
  registry.exportRegistrySnippet = exportRegistrySnippet;
  registry.importSnapshot = importSnapshot;
  registry.resetToDefaults = resetToDefaults;

  return registry;
});
