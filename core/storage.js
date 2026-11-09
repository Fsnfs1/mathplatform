/**
 * core/storage.js
 * Persistent local storage & IndexedDB abstraction layer (F1, F2, F5, F7, F8).
 * - Uses MathCoreConfig.storageKeys.
 * - Provides IndexedDB (`MathPlatformV2DB`, object store `interaction_events`) when available
 *   plus synchronous LocalStorage & in-memory fallback for deterministic execution in both
 *   Browser and Node.js.
 * - Monotonic `nextSeq()` counter (`MP_V2_SEQ_COUNTER`).
 * - Event queue & outbox: `appendEvent`, `getPendingEvents`, `markEventsSynced`, `getPendingCount`.
 * - Sync timestamps, active quiz breakpoint state, wrong question store, and generic KV helpers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./config.js'));
  } else {
    root.MathCoreStorage = factory(root.MathCoreConfig);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (CONFIG) {
  'use strict';

  const KEYS = Object.assign(
    {
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
      activeQuizKey: 'MP_V2_ACTIVE_QUIZ',
      wrongQuestionsPrefix: 'MP_V2_WRONG_QUESTIONS_',
      netwatchTransitionsKey: 'MP_V2_NETWATCH_TRANSITIONS',
      announcementsKey: 'MP_V2_ANNOUNCEMENTS',
      readNoticesPrefix: 'MP_V2_READ_NOTICES_',
    },
    (CONFIG && CONFIG.storageKeys) || {}
  );

  const memStore = new Map();
  let idbInstance = null;
  let idbOpeningPromise = null;

  function getLocalStorage() {
    try {
      if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
        return globalThis.localStorage;
      }
    } catch (e) {
      // SecurityError in restricted iframe/context
    }
    return null;
  }

  function setItem(key, val) {
    const serialized = JSON.stringify(val);
    memStore.set(key, serialized);
    const ls = getLocalStorage();
    if (ls) {
      try {
        ls.setItem(key, serialized);
      } catch (e) {
        // QuotaExceededError fallback to memStore
      }
    }
    return val;
  }

  function getItem(key, defaultVal) {
    const ls = getLocalStorage();
    let raw = null;
    if (ls) {
      try {
        raw = ls.getItem(key);
      } catch (e) {
        raw = null;
      }
    }
    if (raw === null || raw === undefined) {
      raw = memStore.has(key) ? memStore.get(key) : null;
    } else {
      memStore.set(key, raw);
    }
    if (raw === null || raw === undefined) {
      return defaultVal !== undefined ? defaultVal : null;
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      return raw;
    }
  }

  function removeItem(key) {
    memStore.delete(key);
    const ls = getLocalStorage();
    if (ls) {
      try {
        ls.removeItem(key);
      } catch (e) {
        // ignore
      }
    }
  }

  function openIndexedDB() {
    if (idbInstance) return Promise.resolve(idbInstance);
    if (idbOpeningPromise) return idbOpeningPromise;
    if (typeof globalThis === 'undefined' || !globalThis.indexedDB) {
      return Promise.resolve(null);
    }
    idbOpeningPromise = new Promise(function (resolve) {
      try {
        const req = globalThis.indexedDB.open(KEYS.dbName, 1);
        req.onupgradeneeded = function (ev) {
          const db = ev.target.result;
          if (!db.objectStoreNames.contains(KEYS.eventLogStore)) {
            const store = db.createObjectStore(KEYS.eventLogStore, { keyPath: 'seq' });
            store.createIndex('synced', 'synced', { unique: false });
            store.createIndex('mode', 'mode', { unique: false });
          }
        };
        req.onsuccess = function (ev) {
          idbInstance = ev.target.result;
          resolve(idbInstance);
        };
        req.onerror = function () {
          resolve(null);
        };
      } catch (e) {
        resolve(null);
      }
    });
    return idbOpeningPromise;
  }

  function writeEventToIdb(eventRecord) {
    openIndexedDB().then(function (db) {
      if (!db) return;
      try {
        const tx = db.transaction([KEYS.eventLogStore], 'readwrite');
        tx.objectStore(KEYS.eventLogStore).put(eventRecord);
      } catch (e) {
        // fallback already persisted in outbox
      }
    });
  }

  function markSyncedInIdb(seqSet) {
    openIndexedDB().then(function (db) {
      if (!db) return;
      try {
        const tx = db.transaction([KEYS.eventLogStore], 'readwrite');
        const store = tx.objectStore(KEYS.eventLogStore);
        seqSet.forEach(function (seq) {
          const getReq = store.get(seq);
          getReq.onsuccess = function () {
            if (getReq.result) {
              const updated = Object.assign({}, getReq.result, {
                synced: true,
                syncedTs: Date.now(),
              });
              store.put(updated);
            }
          };
        });
      } catch (e) {
        // ignore
      }
    });
  }

  /**
   * Monotonic sequence number generator (`MP_V2_SEQ_COUNTER`).
   */
  function nextSeq() {
    const current = parseInt(getItem(KEYS.seqCounterKey, 0), 10) || 0;
    const next = current + 1;
    setItem(KEYS.seqCounterKey, next);
    return next;
  }

  function getOutboxList() {
    const list = getItem(KEYS.outboxKey, []);
    return Array.isArray(list) ? list : [];
  }

  function saveOutboxList(list) {
    setItem(KEYS.outboxKey, list);
  }

  /**
   * Appends an interaction or answer event to storage & outbox queue.
   * Automatically assigns monotonic `seq` and millisecond `clientTs` if missing.
   * Deduplicates if an event with the exact same `seq` already exists.
   */
  function appendEvent(evt) {
    if (!evt || typeof evt !== 'object') {
      throw new Error('appendEvent requires an event object');
    }
    const seq = typeof evt.seq === 'number' && evt.seq > 0 ? evt.seq : nextSeq();
    const currentMax = parseInt(getItem(KEYS.seqCounterKey, 0), 10) || 0;
    if (seq > currentMax) {
      setItem(KEYS.seqCounterKey, seq);
    }

    const record = Object.assign({}, evt, {
      seq: seq,
      clientTs: typeof evt.clientTs === 'number' ? evt.clientTs : Date.now(),
      mode: evt.mode || 'online',
      offline: Boolean(evt.offline),
      synced: Boolean(evt.synced),
    });

    const outbox = getOutboxList();
    const existingIdx = outbox.findIndex(function (item) {
      return item && item.seq === record.seq;
    });
    if (existingIdx >= 0) {
      outbox[existingIdx] = record;
    } else {
      outbox.push(record);
    }
    // Keep sorted by monotonic `seq`
    outbox.sort(function (a, b) {
      return (a.seq || 0) - (b.seq || 0);
    });
    saveOutboxList(outbox);
    writeEventToIdb(record);
    return record;
  }

  /**
   * Returns all unsynced events (`!evt.synced`) sorted by `seq`, optionally filtered by `filterFn`.
   */
  function getPendingEvents(filterFn) {
    const outbox = getOutboxList();
    const pending = outbox.filter(function (evt) {
      if (!evt || evt.synced) return false;
      return typeof filterFn === 'function' ? Boolean(filterFn(evt)) : true;
    });
    pending.sort(function (a, b) {
      return (a.seq || 0) - (b.seq || 0);
    });
    return pending;
  }

  function getAllEvents(filterFn) {
    const outbox = getOutboxList();
    if (typeof filterFn !== 'function') return outbox.slice();
    return outbox.filter(filterFn);
  }

  /**
   * Marks events with `seq` in `seqList` as synced (`synced: true, syncedTs: Date.now()`).
   */
  function markEventsSynced(seqList) {
    if (!Array.isArray(seqList) || seqList.length === 0) return 0;
    const seqSet = new Set(
      seqList.map(function (s) {
        return Number(s);
      })
    );
    const outbox = getOutboxList();
    let markedCount = 0;
    const now = Date.now();
    for (let i = 0; i < outbox.length; i++) {
      if (outbox[i] && seqSet.has(Number(outbox[i].seq)) && !outbox[i].synced) {
        outbox[i].synced = true;
        outbox[i].syncedTs = now;
        markedCount++;
      }
    }
    saveOutboxList(outbox);
    markSyncedInIdb(seqSet);
    return markedCount;
  }

  function getPendingCount(filterFn) {
    return getPendingEvents(filterFn).length;
  }

  // === Sync Timestamps ===
  function getLastPracticeSyncTs() {
    return Number(getItem(KEYS.lastPracticeSyncKey, 0)) || 0;
  }

  function setLastPracticeSyncTs(ts) {
    const val = typeof ts === 'number' ? ts : Date.now();
    setItem(KEYS.lastPracticeSyncKey, val);
    return val;
  }

  function getLastOnlineSyncTs() {
    return Number(getItem(KEYS.lastOnlineSyncKey, 0)) || 0;
  }

  function setLastOnlineSyncTs(ts) {
    const val = typeof ts === 'number' ? ts : Date.now();
    setItem(KEYS.lastOnlineSyncKey, val);
    return val;
  }

  // === Breakpoint Resume State (`MP_V2_ACTIVE_QUIZ`) ===
  function saveActiveQuizState(state) {
    if (!state || typeof state !== 'object') {
      throw new Error('saveActiveQuizState requires a state object');
    }
    const payload = Object.assign({}, state, { savedAt: Date.now() });
    setItem(KEYS.activeQuizKey, payload);
    return payload;
  }

  function loadActiveQuizState() {
    return getItem(KEYS.activeQuizKey, null);
  }

  function clearActiveQuizState() {
    removeItem(KEYS.activeQuizKey);
  }

  // === Wrong Questions Store (for A5) ===
  function getWrongStoreKey(sid) {
    const normSid = String(sid || 'GUEST').trim().toUpperCase();
    return KEYS.wrongQuestionsPrefix + normSid;
  }

  function saveWrongQuestion(sid, wrongItem) {
    if (!wrongItem || !wrongItem.qid) {
      throw new Error('saveWrongQuestion requires wrongItem with qid');
    }
    const key = getWrongStoreKey(sid);
    const list = getItem(key, []);
    const items = Array.isArray(list) ? list : [];
    const idx = items.findIndex(function (x) {
      return x && x.qid === wrongItem.qid;
    });
    const now = Date.now();
    if (idx >= 0) {
      const prev = items[idx];
      items[idx] = Object.assign({}, prev, wrongItem, {
        wrongCount: (prev.wrongCount || 1) + 1,
        lastWrongTs: now,
        mastered: false,
      });
    } else {
      items.push(
        Object.assign(
          {
            sid: sid,
            qid: wrongItem.qid,
            topic: wrongItem.topic || '未分類',
            category: wrongItem.category || wrongItem.topic || '未分類',
            errorType: wrongItem.errorType || 'concept',
            userAnswer: wrongItem.userAnswer,
            correctKeys: wrongItem.correctKeys || [],
            stem: wrongItem.stem || '',
            explanation: wrongItem.explanation || '',
            wrongCount: 1,
            retestCount: 0,
            mastered: false,
            firstWrongTs: now,
            lastWrongTs: now,
          },
          wrongItem
        )
      );
    }
    setItem(key, items);
    return items[idx >= 0 ? idx : items.length - 1];
  }

  function getWrongQuestions(sid, filter) {
    const key = getWrongStoreKey(sid);
    const list = getItem(key, []);
    const items = Array.isArray(list) ? list : [];
    if (!filter) return items;
    if (typeof filter === 'function') {
      return items.filter(filter);
    }
    return items.filter(function (item) {
      if (filter.topic && item.topic !== filter.topic && item.category !== filter.topic) {
        return false;
      }
      if (filter.errorType && item.errorType !== filter.errorType) {
        return false;
      }
      if (filter.unmasteredOnly && item.mastered) {
        return false;
      }
      return true;
    });
  }

  function markWrongQuestionRetested(sid, qid, isCorrect) {
    const key = getWrongStoreKey(sid);
    const list = getItem(key, []);
    const items = Array.isArray(list) ? list : [];
    const idx = items.findIndex(function (x) {
      return x && x.qid === qid;
    });
    if (idx === -1) return null;
    const item = items[idx];
    item.retestCount = (item.retestCount || 0) + 1;
    item.lastRetestTs = Date.now();
    item.lastRetestCorrect = Boolean(isCorrect);
    if (isCorrect) {
      item.mastered = true;
    } else {
      item.mastered = false;
      item.wrongCount = (item.wrongCount || 1) + 1;
    }
    items[idx] = item;
    setItem(key, items);
    return item;
  }

  function getReadNoticeKey(sid) {
    return KEYS.readNoticesPrefix + String(sid || 'guest');
  }

  function getReadAnnouncementIds(sid) {
    const val = getItem(getReadNoticeKey(sid), []);
    return Array.isArray(val) ? val : [];
  }

  function markAnnouncementRead(sid, annId) {
    if (!annId) return;
    const key = getReadNoticeKey(sid);
    const set = new Set(getReadAnnouncementIds(sid));
    set.add(String(annId));
    setItem(key, Array.from(set));
  }

  function getLocalAnnouncements() {
    const val = getItem(KEYS.announcementsKey, null);
    return Array.isArray(val) ? val : null;
  }

  function saveLocalAnnouncements(list) {
    if (Array.isArray(list)) {
      setItem(KEYS.announcementsKey, list);
    }
  }

  function clearAll() {
    memStore.clear();
    const ls = getLocalStorage();
    if (ls && typeof ls.clear === 'function') {
      try {
        ls.clear();
      } catch (e) {
        // ignore
      }
    }
  }

  return {
    storageKeys: KEYS,
    setItem: setItem,
    getItem: getItem,
    removeItem: removeItem,
    nextSeq: nextSeq,
    appendEvent: appendEvent,
    getPendingEvents: getPendingEvents,
    getAllEvents: getAllEvents,
    markEventsSynced: markEventsSynced,
    getPendingCount: getPendingCount,
    getLastPracticeSyncTs: getLastPracticeSyncTs,
    setLastPracticeSyncTs: setLastPracticeSyncTs,
    getLastOnlineSyncTs: getLastOnlineSyncTs,
    setLastOnlineSyncTs: setLastOnlineSyncTs,
    saveActiveQuizState: saveActiveQuizState,
    loadActiveQuizState: loadActiveQuizState,
    clearActiveQuizState: clearActiveQuizState,
    saveWrongQuestion: saveWrongQuestion,
    getWrongQuestions: getWrongQuestions,
    markWrongQuestionRetested: markWrongQuestionRetested,
    getReadAnnouncementIds: getReadAnnouncementIds,
    markAnnouncementRead: markAnnouncementRead,
    getLocalAnnouncements: getLocalAnnouncements,
    saveLocalAnnouncements: saveLocalAnnouncements,
    openIndexedDB: openIndexedDB,
    clearAll: clearAll,
  };
});
