/**
 * persistence.js - Dual Persistence & Offline Sync Engine
 * High School Mobile Math Practice & Anti-Cheating Quiz Platform
 * 
 * Channels:
 * 1. Image Channel: Google Apps Script Web App POST uploader for Google Drive (Folder ID: 1oY52JyAqLLQQiETq8A-hre9jZ_goLHiY).
 * 2. Data Channel: Google Form no-cors POST submission (classID, studentID, dateID/vector, score/tag).
 * 3. OfflineSyncManager: LocalStorage FIFO queue, exponential backoff with jitter retry, online/offline listeners, UI badge indicator.
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PersistenceModule = factory();
    // Expose convenient globals for browser runtime
    root.submitFormRecord = root.PersistenceModule.submitFormRecord;
    root.uploadDrivePhoto = root.PersistenceModule.uploadDrivePhoto;
    root.saveStudentProfile = root.PersistenceModule.saveStudentProfile;
    root.getStudentProfile = root.PersistenceModule.getStudentProfile;
    root.hasStudentProfile = root.PersistenceModule.hasStudentProfile;
    root.getStudentProfileHistory = root.PersistenceModule.getStudentProfileHistory;
    root.getLatestStudentVector = root.PersistenceModule.getLatestStudentVector;
    root.normalizeVector = root.PersistenceModule.normalizeVector;
    root.getAllStudentProfiles = root.PersistenceModule.getAllStudentProfiles;
    root.fetchStudentFromSheet = root.PersistenceModule.fetchStudentFromSheet;
    root.syncAllProfilesFromSheet = root.PersistenceModule.syncAllProfilesFromSheet;
    root.OfflineSyncManager = root.PersistenceModule.OfflineSyncManager;
    root.PERSISTENCE_CONFIG = root.PersistenceModule.PERSISTENCE_CONFIG;
    root.probeMacauNetwork = root.PersistenceModule.probeMacauNetwork;
    root.auditAndCleanseProfiles = root.PersistenceModule.auditAndCleanseProfiles;
    root.sha256 = root.PersistenceModule.sha256;
    root.hashPassword = root.PersistenceModule.hashPassword;
    root.getStudentPasswordRecord = root.PersistenceModule.getStudentPasswordRecord;
    root.verifyStudentPassword = root.PersistenceModule.verifyStudentPassword;
    root.saveStudentPassword = root.PersistenceModule.saveStudentPassword;
    root.updateStudentPassword = root.PersistenceModule.updateStudentPassword;
    root.setStudentPasswordDirect = root.PersistenceModule.setStudentPasswordDirect;
    root.enhanceStudentVector = root.PersistenceModule.enhanceStudentVector;
    root.initDefaultPasswords = root.PersistenceModule.initDefaultPasswords;
    root.loadPreloadedProfiles = root.PersistenceModule.loadPreloadedProfiles;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Global configuration
  const PERSISTENCE_CONFIG = {
    // Google Form formResponse endpoint
    googleFormUrl: "https://docs.google.com/forms/u/0/d/e/1FAIpQLSeLZ6E4kLjJ26aWrKRPRPtDdthkxRHqOPX5AOwAq8_TYiT-OQ/formResponse",
    // Field mappings for Google Form
    formFields: {
      classID: "entry.543502435",
      studentID: "entry.1745113091",
      dateID: "entry.1972335137",
      score: "entry.2095507383"
    },
    // Google Apps Script Drive Uploader Web App URL (Target folder: 1oY52JyAqLLQQiETq8A-hre9jZ_goLHiY)
    gasDriveUploaderUrl: "https://script.google.com/macros/s/AKfycbxjkXzqp4WOghvi__SF8qoVBGAcXcSKv96JoRsKN3hLU6xHwLjK4rHyaXODIv_fE9Ak/exec",
    // Google Apps Script Sheet Data Reader Web App URL
    gasSheetReaderUrl: "https://script.google.com/macros/s/AKfycbwNAQNxmNsNa8rWGp48qnYRrjA2WFLGIzKqSel2r8MilRp59s3ZfBJjeKXIrUfoS-Zp-g/exec",
    // LocalStorage keys
    queueStorageKey: "MATH_OFFLINE_QUEUE_V1",
    profilePrefix: "math_student_profile_"
  };

  /**
   * Helper: extract millisecond timestamp from profile record or timestamp field
   * Supports numbers, numeric strings, ISO date strings, and serialized |TS: timestamp tags.
   * @param {Object|string} item 
   * @returns {number}
   */
  function extractTimestamp(item) {
    if (!item) return 0;
    if (typeof item === 'string') {
      if (item.includes('|TS:')) {
        const match = item.match(/\|TS:(\d+)/);
        if (match) return Number(match[1]) || 0;
      }
      const num = Number(item);
      if (!isNaN(num) && num > 0) return num;
      const parsed = Date.parse(item);
      if (!isNaN(parsed) && parsed > 0) return parsed;
      return 0;
    }
    if (typeof item.updatedAt === 'number' && !isNaN(item.updatedAt) && item.updatedAt > 0) return item.updatedAt;
    if (typeof item.timestamp === 'number' && !isNaN(item.timestamp) && item.timestamp > 0) return item.timestamp;
    if (typeof item.updatedAt === 'string') {
      const num = Number(item.updatedAt);
      if (!isNaN(num) && num > 0) return num;
      const parsed = Date.parse(item.updatedAt);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    if (typeof item.timestamp === 'string') {
      const num = Number(item.timestamp);
      if (!isNaN(num) && num > 0) return num;
      const parsed = Date.parse(item.timestamp);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    if (typeof item.registeredAt === 'string') {
      const parsed = Date.parse(item.registeredAt);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return 0;
  }

  /**
   * Helper: normalize vector representation into standard Array<number> of length 128
   * Accepts Array, Float32Array, object with index keys 0..127 (from stringified TypedArray), or CSV string
   * @param {*} vec 
   * @returns {Array<number>|null}
   */
  function normalizeVector(vec) {
    if (!vec) return null;
    if (vec instanceof Float32Array && vec.length === 128) {
      return Array.from(vec);
    }
    if (Array.isArray(vec) && vec.length === 128) {
      return vec.map(Number);
    }
    if (typeof vec === 'string') {
      let s = vec.trim();
      if (s.startsWith('ABNORMAL_DUPLICATE')) return null;
      if (s.includes('|')) s = s.split('|')[0];
      if (s.includes(':')) {
        const parts = s.split(':');
        s = parts[parts.length - 1];
      }
      const nums = s.split(',').map(Number);
      if (nums.length === 128 && !nums.some(isNaN)) {
        return nums;
      }
    }
    if (typeof vec === 'object') {
      if (typeof vec.length === 'number' && vec.length === 128) {
        return Array.from(vec).map(Number);
      }
      const keys = Object.keys(vec);
      if (keys.length === 128) {
        const arr = new Array(128);
        let valid = true;
        for (let i = 0; i < 128; i++) {
          if (vec[i] === undefined) { valid = false; break; }
          arr[i] = Number(vec[i]) || 0;
        }
        if (valid) return arr;
      }
    }
    return null;
  }

  /**
   * Save student identity and facial vector profile to LocalStorage
   * If existing records are found, compares timestamps and unconditionally replaces with latest features.
   * @param {Object} profile { classID, studentID, name, vector, photoJpgBase64, registeredAt, updatedAt, timestamp, version, forceLatest }
   * @returns {boolean}
   */
  function saveStudentProfile(profile, options) {
    if (!profile || !profile.classID || !profile.studentID) return false;
    const cid = String(profile.classID).trim().toUpperCase();
    let sid = String(profile.studentID).trim();
    if ((cid === "5B" || cid === "4C" || cid === "4D") && (sid === "..." || sid === "99")) {
      sid = "99";
    }
    const key = PERSISTENCE_CONFIG.profilePrefix + cid + "_" + sid;
    try {
      // 1. Read existing profile if present
      let existing = null;
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(key);
        if (raw) {
          try {
            existing = JSON.parse(raw);
          } catch (e) {
            existing = null;
          }
        }
      }

      // 2. Compute incoming timestamp and version
      const incomingTime = extractTimestamp(profile) || Date.now();

      let existingTime = 0;
      let existingVersion = 0;
      let historyList = [];

      if (existing) {
        if (Array.isArray(existing)) {
          // Legacy or multi-array storage
          for (let i = 0; i < existing.length; i++) {
            const itm = existing[i];
            const t = extractTimestamp(itm);
            if (t > existingTime) existingTime = t;
            const v = itm.version || (i + 1);
            if (v > existingVersion) existingVersion = v;
            historyList.push(itm);
          }
        } else {
          existingTime = extractTimestamp(existing);
          existingVersion = existing.version || 1;
          if (Array.isArray(existing.history)) {
            historyList = existing.history.slice();
          }
        }
      }

      const versionNum = typeof profile.version === 'number'
        ? profile.version
        : (existingVersion > 0 ? existingVersion + 1 : 1);

      // 3. Timestamp comparison: unconditionally replace with latest feature
      const isForceLatest = !!profile.forceLatest;
      const shouldPromote = !existing || incomingTime >= existingTime || isForceLatest;

      let activeVector;
      let activePhoto;
      let activeTime;
      let activeVersion;

      const incomingNormVec = normalizeVector(profile.vector);

      // R3: Duplicate registration defense check (similarity >= 92% alert/reject)
      // Only enforce if explicitly requested by options.enforceDeduplication,
      // as interactive UI registration handles deduplication warning dialogs,
      // and low-level storage calls, vector resampling, and test setups must succeed.
      const enforceDeduplication = !!(options && options.enforceDeduplication);
      if (enforceDeduplication && incomingNormVec) {
        const faceAuth = (typeof globalThis !== 'undefined' && globalThis.FaceAuthModule) ||
                         (typeof window !== 'undefined' && window.FaceAuthModule);
        if (faceAuth && typeof faceAuth.checkDuplicateFace === 'function') {
          const allProfiles = getAllStudentProfiles();
          const dupCheck = faceAuth.checkDuplicateFace(
            incomingNormVec,
            profile.classID,
            profile.studentID,
            allProfiles,
            0.92
          );
          if (dupCheck.isDuplicate && dupCheck.duplicateStudent) {
            console.warn(`[Persistence] Rejected duplicate face binding for ${profile.classID}_${profile.studentID}, matches ${dupCheck.duplicateStudent.classID}_${dupCheck.duplicateStudent.studentID} (${dupCheck.percentage}%)`);
            return false;
          }
        }
      }

      if (shouldPromote) {
        // Enforce monotonicity for administrative re-registration or clock skew
        activeTime = (existing && existingTime >= incomingTime) ? (existingTime + 1) : incomingTime;
        activeVersion = (existing && existingVersion >= versionNum) ? (existingVersion + 1) : versionNum;
        activeVector = incomingNormVec || (existing ? normalizeVector(existing.vector) : null) || [];
        activePhoto = profile.photoJpgBase64 || "";

        // Archive previous active record if one existed
        if (existing && existing.vector) {
          const oldNorm = normalizeVector(existing.vector);
          if (oldNorm) {
            historyList.push({
              version: existing.version || existingVersion || 1,
              vector: oldNorm,
              photoJpgBase64: existing.photoJpgBase64 || "",
              registeredAt: existing.registeredAt || "",
              updatedAt: existing.updatedAt || existing.timestamp || existingTime,
              timestamp: existing.timestamp || existing.updatedAt || existingTime
            });
          }
        }
      } else {
        // Out-of-order older record arriving without forceLatest: preserve existing active
        console.warn(`[Persistence] Incoming profile timestamp (${incomingTime}) is older than existing (${existingTime}). Preserving latest.`);
        activeVector = (existing ? normalizeVector(existing.vector) : null) || incomingNormVec || [];
        activePhoto = existing ? (existing.photoJpgBase64 || "") : (profile.photoJpgBase64 || "");
        activeTime = existingTime;
        activeVersion = existingVersion;
        if (incomingNormVec) {
          historyList.push({
            version: versionNum,
            vector: incomingNormVec,
            photoJpgBase64: profile.photoJpgBase64 || "",
            registeredAt: profile.registeredAt || new Date(incomingTime).toISOString(),
            updatedAt: incomingTime,
            timestamp: incomingTime
          });
        }
      }

      // Deduplicate history by version and retain up to 10 latest entries to protect LocalStorage quota
      const seenVersions = new Set();
      historyList = historyList.filter(function (h) {
        if (!h || !h.vector) return false;
        const norm = normalizeVector(h.vector);
        if (!norm) return false;
        h.vector = norm;
        const v = h.version || 0;
        if (v === activeVersion) return false; // Invariant: history cannot duplicate active version
        if (seenVersions.has(v)) return false;
        seenVersions.add(v);
        return true;
      });
      if (historyList.length > 10) {
        historyList = historyList.slice(-10);
      }

      const data = {
        classID: String(profile.classID).trim().toUpperCase(),
        studentID: parseInt(profile.studentID, 10),
        name: profile.name || (existing && existing.name ? existing.name : ""),
        vector: activeVector,
        photoJpgBase64: activePhoto,
        registeredAt: (existing && existing.registeredAt) ? existing.registeredAt : (profile.registeredAt || new Date(incomingTime).toISOString()),
        updatedAt: activeTime,
        timestamp: activeTime,
        version: activeVersion,
        history: historyList
      };

      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(data));
      }
      return true;
    } catch (e) {
      console.error("[Persistence] Failed to save student profile to localStorage:", e);
      return false;
    }
  }

  /**
   * Retrieve saved student profile from LocalStorage
   * Strictly resolves the feature vector with the latest timestamp.
   * Filters out obsolete historical entries and normalizes vector format.
   * @param {string} classID 
   * @param {number|string} studentID 
   * @returns {Object|null}
   */
  function getStudentProfile(classID, studentID) {
    if (!classID || studentID === undefined || studentID === null) return null;
    const cid = String(classID).trim().toUpperCase();
    let sid = String(studentID).trim();
    if ((cid === "5B" || cid === "4C" || cid === "4D") && (sid === "..." || sid === "99")) {
      sid = "99";
    }
    const key = PERSISTENCE_CONFIG.profilePrefix + cid + "_" + sid;
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(key);
        if (raw) {
          let parsed = JSON.parse(raw);
          if (parsed) {
            // Candidate version array to sort by timestamp descending
            let candidates = [];

            if (Array.isArray(parsed)) {
              // If stored as an array of versions
              parsed.forEach(function (itm) {
                const norm = itm && normalizeVector(itm.vector);
                if (norm) {
                  candidates.push(Object.assign({}, itm, { vector: norm }));
                }
              });
            } else if (parsed && typeof parsed === 'object') {
              // Top-level item
              const topNorm = normalizeVector(parsed.vector);
              if (topNorm) {
                candidates.push(Object.assign({}, parsed, { vector: topNorm }));
              }
              // History items
              if (Array.isArray(parsed.history)) {
                parsed.history.forEach(function (h) {
                  const hNorm = h && normalizeVector(h.vector);
                  if (hNorm) {
                    candidates.push(Object.assign({}, h, {
                      classID: parsed.classID,
                      studentID: parsed.studentID,
                      name: parsed.name,
                      vector: hNorm
                    }));
                  }
                });
              }
            }

            if (candidates.length > 0) {
              // Sort descending: candidate with maximum timestamp comes first, tie-break by version
              candidates.sort(function (a, b) {
                const tA = extractTimestamp(a);
                const tB = extractTimestamp(b);
                if (tB !== tA) return tB - tA;
                return (b.version || 0) - (a.version || 0);
              });

              const latestRecord = candidates[0];
              const latestTime = extractTimestamp(latestRecord);

              // Filter history to exclude the active version
              const cleanHistory = (Array.isArray(parsed.history) ? parsed.history : []).filter(function (h) {
                return h && (h.version || 0) !== (latestRecord.version || 1);
              });

              // Construct standard profile object with latest vector
              const result = {
                classID: String(latestRecord.classID || parsed.classID).trim().toUpperCase(),
                studentID: parseInt(latestRecord.studentID || parsed.studentID, 10),
                name: latestRecord.name || parsed.name || "",
                vector: new Float32Array(latestRecord.vector),
                photoJpgBase64: latestRecord.photoJpgBase64 || parsed.photoJpgBase64 || "",
                registeredAt: parsed.registeredAt || latestRecord.registeredAt || new Date().toISOString(),
                updatedAt: latestTime,
                timestamp: latestTime,
                version: latestRecord.version || parsed.version || 1,
                history: cleanHistory
              };

              return result;
            } else if (parsed && !Array.isArray(parsed) && parsed.classID) {
              const fallbackNorm = normalizeVector(parsed.vector);
              if (fallbackNorm) {
                parsed.vector = new Float32Array(fallbackNorm);
                return parsed;
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn("[Persistence] Failed to read student profile from localStorage:", e);
    }

    // Legacy fallback: 5BC1102.html math_student_vector_<cid>_<sid>
    if (typeof localStorage !== 'undefined') {
      try {
        const legacyVecRaw = localStorage.getItem(`math_student_vector_${cid}_${sid}`);
        if (legacyVecRaw) {
          const legacyParsed = JSON.parse(legacyVecRaw);
          const legacyNorm = normalizeVector(legacyParsed);
          if (legacyNorm && legacyNorm.length === 128) {
            const sName = (typeof window !== 'undefined' && window.getStudentName ? window.getStudentName(cid, sid) : (typeof globalThis !== 'undefined' && globalThis.getStudentName ? globalThis.getStudentName(cid, sid) : `學生 ${sid}`));
            return {
              classID: cid,
              studentID: parseInt(sid, 10),
              name: sName,
              vector: new Float32Array(legacyNorm),
              photoJpgBase64: "",
              registeredAt: new Date(0).toISOString(),
              updatedAt: 0,
              timestamp: 0,
              version: 1,
              history: []
            };
          }
        }
      } catch (e) {}
    }

    // Direct memory fallback: PRELOADED_STUDENT_FACES
    const preloaded = (typeof window !== 'undefined' && window.PRELOADED_STUDENT_FACES) ||
                      (typeof globalThis !== 'undefined' && globalThis.PRELOADED_STUDENT_FACES);
    if (preloaded) {
      const pItem = preloaded[`${cid}_${sid}`];
      if (pItem && pItem.vector) {
        const norm = normalizeVector(pItem.vector);
        if (norm && norm.length === 128) {
          const sName = pItem.name || (typeof window !== 'undefined' && window.getStudentName ? window.getStudentName(cid, sid) : (typeof globalThis !== 'undefined' && globalThis.getStudentName ? globalThis.getStudentName(cid, sid) : `學生 ${sid}`));
          return {
            classID: cid,
            studentID: parseInt(sid, 10),
            name: sName,
            vector: new Float32Array(norm),
            photoJpgBase64: "",
            registeredAt: new Date(pItem.ts || Date.now()).toISOString(),
            updatedAt: pItem.ts || 0,
            timestamp: pItem.ts || 0,
            version: 1,
            history: []
          };
        }
      }
    }
    return null;
  }

  /**
   * Determine whether a student currently has a valid face profile saved
   * @param {string} classID 
   * @param {number|string} studentID 
   * @returns {boolean}
   */
  function hasStudentProfile(classID, studentID) {
    const prof = getStudentProfile(classID, studentID);
    if (!prof || prof.isAbnormal || prof.abnormal) return false;
    return !!(prof && prof.vector && prof.vector.length === 128);
  }

  /**
   * Retrieve complete history of student facial profiles sorted by timestamp descending
   * @param {string} classID 
   * @param {number|string} studentID 
   * @returns {Array<Object>}
   */
  function getStudentProfileHistory(classID, studentID) {
    if (!classID || studentID === undefined || studentID === null) return [];
    const prof = getStudentProfile(classID, studentID);
    if (!prof) return [];
    const list = [];
    if (prof.vector && prof.vector.length === 128) {
      list.push({
        version: prof.version || 1,
        vector: prof.vector,
        timestamp: prof.timestamp || prof.updatedAt,
        updatedAt: prof.updatedAt || prof.timestamp,
        registeredAt: prof.registeredAt,
        photoJpgBase64: prof.photoJpgBase64,
        isActive: true
      });
    }
    if (Array.isArray(prof.history)) {
      prof.history.forEach(function (h) {
        const norm = normalizeVector(h.vector);
        if (norm) {
          list.push({
            version: h.version || 1,
            vector: new Float32Array(norm),
            timestamp: h.timestamp || h.updatedAt || extractTimestamp(h),
            updatedAt: h.updatedAt || h.timestamp || extractTimestamp(h),
            registeredAt: h.registeredAt,
            photoJpgBase64: h.photoJpgBase64,
            isActive: false
          });
        }
      });
    }
    list.sort(function (a, b) {
      return (b.timestamp || 0) - (a.timestamp || 0);
    });
    return list;
  }

  /**
   * Directly get latest Float32Array vector and timestamp for a student
   * @param {string} classID 
   * @param {number|string} studentID 
   * @returns {{vector: Float32Array, timestamp: number, version: number}|null}
   */
  function getLatestStudentVector(classID, studentID) {
    const prof = getStudentProfile(classID, studentID);
    if (!prof || prof.isAbnormal || prof.abnormal || !prof.vector || prof.vector.length !== 128) return null;
    return {
      vector: prof.vector,
      timestamp: prof.timestamp || prof.updatedAt || 0,
      version: prof.version || 1
    };
  }

  /**
   * Retrieve all saved student profiles from LocalStorage
   * @returns {Array<Object>}
   */
  function getAllStudentProfiles() {
    const profileMap = {};
    
    // 1. Base: load all profiles directly from PRELOADED_STUDENT_FACES in memory
    const preloaded = (typeof window !== 'undefined' && window.PRELOADED_STUDENT_FACES) ||
                      (typeof globalThis !== 'undefined' && globalThis.PRELOADED_STUDENT_FACES);
    if (preloaded && typeof preloaded === 'object') {
      for (const k in preloaded) {
        const item = preloaded[k];
        if (!item || !item.classID || !item.studentID || !item.vector) continue;
        const norm = normalizeVector(item.vector);
        if (norm && norm.length === 128) {
          const cid = String(item.classID).trim().toUpperCase();
          const sid = parseInt(item.studentID, 10);
          const sName = item.name || (typeof window !== 'undefined' && window.getStudentName ? window.getStudentName(cid, sid) : `學生 ${sid}`);
          profileMap[`${cid}_${sid}`] = {
            classID: cid,
            studentID: sid,
            name: sName,
            vector: new Float32Array(norm),
            photoJpgBase64: "",
            registeredAt: new Date(item.ts || Date.now()).toISOString(),
            updatedAt: item.ts || 0,
            timestamp: item.ts || 0,
            version: 1,
            history: []
          };
        }
      }
    }

    // 2. Overlay: load newer or locally registered profiles from LocalStorage
    const modernProfileKeys = new Set();
    if (typeof localStorage !== 'undefined') {
      const prefix = PERSISTENCE_CONFIG.profilePrefix;
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.indexOf(prefix) === 0) {
            const rest = key.substring(prefix.length); // e.g. "4C_1"
            const parts = rest.split("_");
            if (parts.length >= 2) {
              const cls = parts[0];
              const sid = parts[1];
              const k = `${String(cls).toUpperCase()}_${parseInt(sid, 10)}`;
              modernProfileKeys.add(k);
              const p = getStudentProfile(cls, sid);
              if (p && !p.isAbnormal && !p.abnormal && p.vector && (p.vector.length === 128 || (Array.isArray(p.vector) && p.vector.length === 128))) {
                if (!profileMap[k] || (p.timestamp || p.updatedAt || 0) >= (profileMap[k].timestamp || 0)) {
                  profileMap[k] = p;
                }
              }
            }
          }
        }

        // 3. Overlay legacy 5BC1102.html math_student_vector_* when no modern math_student_profile_ exists
        const legacyPrefix = "math_student_vector_";
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.indexOf(legacyPrefix) === 0) {
            const rest = key.substring(legacyPrefix.length);
            const parts = rest.split("_");
            if (parts.length >= 2) {
              const cid = String(parts[0]).trim().toUpperCase();
              const sid = parseInt(parts[1], 10);
              if (!cid || isNaN(sid)) continue;
              const k = `${cid}_${sid}`;
              if (modernProfileKeys.has(k)) continue;
              const rawVec = localStorage.getItem(key);
              if (!rawVec) continue;
              try {
                const parsedVec = JSON.parse(rawVec);
                const normVec = normalizeVector(parsedVec);
                if (normVec && normVec.length === 128) {
                  const sName = (typeof window !== 'undefined' && window.getStudentName ? window.getStudentName(cid, sid) : `學生 ${sid}`);
                  profileMap[k] = {
                    classID: cid,
                    studentID: sid,
                    name: sName,
                    vector: new Float32Array(normVec),
                    photoJpgBase64: "",
                    registeredAt: new Date(0).toISOString(),
                    updatedAt: 0,
                    timestamp: 0,
                    version: 1,
                    history: []
                  };
                }
              } catch (_) {}
            }
          }
        }
      } catch (e) {
        console.warn("[Persistence] Error getting all student profiles:", e);
      }
    }

    return Object.values(profileMap);
  }

  /**
   * Query student face record from deployed Google Sheet GAS Web App
   * @param {string} classID 
   * @param {string|number} studentID 
   * @returns {Promise<Object|null>}
   */
  async function fetchStudentFromSheet(classID, studentID) {
    if (!classID || !studentID) return null;
    const gasUrl = PERSISTENCE_CONFIG.gasSheetReaderUrl;
    if (!gasUrl) return null;
    const cTarget = String(classID).trim().toUpperCase();
    const sTarget = parseInt(studentID, 10);
    try {
      const response = await fetch(gasUrl, { method: "GET", mode: "cors" });
      if (!response.ok) return null;
      const data = await response.json();
      let candidateRow = null;

      if (Array.isArray(data)) {
        // Filter rows matching this student where dateID contains a face vector embedding
        const matches = data.filter(function (r) {
          const rc = String(r.classID || "").trim().toUpperCase();
          const rs = parseInt(r.studentID, 10);
          const did = String(r.dateID || "");
          return rc === cTarget && rs === sTarget && did.includes("|TS:");
        });
        if (matches.length > 0) {
          matches.sort(function (a, b) {
            const tsA = extractTimestamp(a.dateID);
            const tsB = extractTimestamp(b.dateID);
            return tsB - tsA;
          });
          candidateRow = matches[0];
        }
      } else if (data && !data.error && typeof data === 'object') {
        candidateRow = data;
      }

      if (candidateRow) {
        console.log("[Persistence] Successfully matched student record from Sheet:", candidateRow);
        const vecCandidate = candidateRow.vector || candidateRow.featureVector || candidateRow.dateID;
        const norm = normalizeVector(vecCandidate);
        if (norm) {
          candidateRow.normalizedVector = norm;
          candidateRow.vector = norm;
        }
        return candidateRow;
      }
      return null;
    } catch (e) {
      console.warn("[Persistence] Failed to query student from Sheet:", e.message);
      return null;
    }
  }

  /**
   * Synchronize all registered face profiles from deployed Google Sheet GAS Web App
   * Populates localStorage so 1:N recognition & dropdown exclusion work seamlessly across all devices
   * @returns {Promise<{success: boolean, count: number, students: string[]}>}
   */
  async function syncAllProfilesFromSheet() {
    const gasUrl = PERSISTENCE_CONFIG.gasSheetReaderUrl;
    if (!gasUrl) return { success: false, count: 0, students: [] };
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(function () { controller.abort(); }, 5000) : null;
    try {
      const response = await fetch(gasUrl, {
        method: 'GET',
        mode: 'cors',
        signal: controller ? controller.signal : undefined
      });
      if (timeoutId) clearTimeout(timeoutId);
      if (!response.ok) return { success: false, count: 0, students: [] };
      const rows = await response.json();
      if (!Array.isArray(rows)) return { success: false, count: 0, students: [] };

      let syncedCount = 0;
      const syncedStudents = [];
      const faceMap = {};
      const pwdMap = {};

      // Group face vector & password records by student to find their latest entries
      rows.forEach(function (r) {
        if (!r) return;
        const did = String(r.dateID || "");
        if (did.startsWith("PWD|")) {
          const cid = String(r.classID || "").trim().toUpperCase();
          const sid = parseInt(r.studentID, 10);
          if (!cid || isNaN(sid)) return;
          const hashMatch = did.match(/HASH:([^|]+)/);
          const saltMatch = did.match(/SALT:([^|]+)/);
          const changedMatch = did.match(/CHANGED:([^|]+)/);
          const tsMatch = did.match(/TS:(\d+)/);
          if (hashMatch) {
            const h = String(hashMatch[1]).toLowerCase();
            const s = saltMatch ? saltMatch[1] : derivePasswordSalt(cid, sid);
            const ch = changedMatch ? (changedMatch[1] === "1" || changedMatch[1] === "true") : false;
            const ts = tsMatch ? Number(tsMatch[1]) : 0;
            const pk = `${cid}_${sid}`;
            const prevPwd = pwdMap[pk];
            if (!prevPwd || ts > prevPwd.ts || (ts === prevPwd.ts && ch && !prevPwd.ch)) {
              pwdMap[pk] = { cid: cid, sid: sid, s: s, h: h, ch: ch, ts: ts };
            }
          }
          return;
        }
        if (r.isAbnormal || r.abnormal) return;
        if (!did.includes("|TS:")) return;
        if (did.includes("ABNORMAL_DUPLICATE")) return;
        const cid = String(r.classID || "").trim().toUpperCase();
        const sid = parseInt(r.studentID, 10);
        if (!cid || isNaN(sid)) return;

        const ts = extractTimestamp(did);
        const k = `${cid}_${sid}`;
        if (!faceMap[k] || ts > faceMap[k].ts) {
          faceMap[k] = { classID: cid, studentID: sid, dateID: did, ts: ts };
        }
      });

      const adminPasswords = (typeof window !== 'undefined' && window.ADMIN_STUDENT_PASSWORDS) ||
                             (typeof globalThis !== 'undefined' && globalThis.ADMIN_STUDENT_PASSWORDS) ||
                             (typeof self !== 'undefined' && self.ADMIN_STUDENT_PASSWORDS);

      for (const pk in pwdMap) {
        const pItem = pwdMap[pk];
        const existing = getStudentPasswordRecord(pItem.cid, pItem.sid);
        const existingChanged = !!(existing && existing.passwordChanged);
        const existingTs = (existing && existing.updatedAt) || 0;
        const shouldUpdatePwd = !existing ||
          (!existingChanged && pItem.ch) ||
          (pItem.ts > 0 && pItem.ts > existingTs && (pItem.ch || !existingChanged)) ||
          (pItem.ts === existingTs && pItem.ch && !existingChanged);

        if (shouldUpdatePwd) {
          const recObj = {
            classID: pItem.cid,
            studentID: pItem.sid,
            salt: pItem.s,
            hash: pItem.h,
            passwordChanged: pItem.ch,
            updatedAt: pItem.ts
          };
          if (typeof localStorage !== 'undefined') {
            try {
              localStorage.setItem(`math_student_password_${pItem.cid}_${pItem.sid}`, JSON.stringify(recObj));
            } catch (_) {}
          }
          if (adminPasswords && typeof adminPasswords === 'object') {
            adminPasswords[pk] = {
              salt: recObj.salt,
              hash: recObj.hash,
              passwordChanged: recObj.passwordChanged,
              updatedAt: recObj.updatedAt
            };
          }
        }
      }

      for (const k in faceMap) {
        const item = faceMap[k];
        const norm = normalizeVector(item.dateID);
        if (norm && norm.length === 128) {
          const existing = getStudentProfile(item.classID, item.studentID);
          const existingTime = existing ? extractTimestamp(existing) : 0;
          if (!existing || item.ts > existingTime) {
            const studentName = (typeof window !== 'undefined' && window.getStudentName) ?
              window.getStudentName(item.classID, item.studentID) : `學生 ${item.studentID}`;
            saveStudentProfile({
              classID: item.classID,
              studentID: item.studentID,
              name: studentName,
              vector: norm,
              registeredAt: new Date(item.ts || Date.now()).toISOString(),
              updatedAt: item.ts || Date.now(),
              timestamp: item.ts || Date.now(),
              version: 1,
              forceLatest: true
            });
            syncedCount++;
            syncedStudents.push(k);
          }
        }
      }
      console.log(`[Persistence] Cloud sync finished: ${syncedCount} profile(s) synced:`, syncedStudents);
      return { success: true, count: syncedCount, students: syncedStudents };
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      console.warn("[Persistence] Failed to sync profiles from sheet:", err);
      return { success: false, count: 0, students: [] };
    }
  }

  /**
   * Audit and Cleanse Profiles (R3):
   * Audits registered profiles in LocalStorage, detects duplicate bindings (similarity >= 92%),
   * especially historical anomalous clones (e.g. 4D 21 contaminated with 4D 4 features),
   * purges corrupted records so the victim student returns to an unregistered state.
   * @returns {{cleansedCount: number, cleansedStudents: Array<{classID: string, studentID: number, reason: string}>}}
   */
  function auditAndCleanseProfiles() {
    const cleansed = [];
    if (typeof localStorage === 'undefined') return { cleansedCount: 0, cleansedStudents: cleansed };

    const faceAuth = (typeof globalThis !== 'undefined' && globalThis.FaceAuthModule) ||
                     (typeof window !== 'undefined' && window.FaceAuthModule);

    const prefix = PERSISTENCE_CONFIG.profilePrefix;
    const profileKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(prefix) === 0) {
        profileKeys.push(k);
      }
    }

    // Pass 1: Direct abnormal flag or contaminated string purge
    for (const key of profileKeys) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const prof = JSON.parse(raw);
        if (prof && (prof.isAbnormal || prof.abnormal || raw.includes("ABNORMAL_DUPLICATE"))) {
          localStorage.removeItem(key);
          cleansed.push({ classID: prof.classID, studentID: prof.studentID, reason: "Flagged abnormal/contaminated" });
        }
      } catch (e) {
        localStorage.removeItem(key);
        cleansed.push({ key: key, reason: "Corrupted profile record" });
      }
    }

    // Pass 2: Check for duplicate faces against older registrations among remaining clean profiles
    const cleanProfiles = getAllStudentProfiles();
    for (let i = 0; i < cleanProfiles.length; i++) {
      const prof = cleanProfiles[i];
      if (!prof || !prof.vector) continue;
      const key = prefix + String(prof.classID).trim().toUpperCase() + "_" + String(prof.studentID).trim();
      if (faceAuth && typeof faceAuth.checkDuplicateFace === 'function') {
        const others = cleanProfiles.filter(function (p, idx) { return idx !== i; });
        const dup = faceAuth.checkDuplicateFace(prof.vector, prof.classID, prof.studentID, others, 0.92);
        if (dup.isDuplicate && dup.duplicateStudent) {
          const myTime = extractTimestamp(prof) || 0;
          const otherTime = extractTimestamp(dup.duplicateStudent) || 0;
          if (myTime > otherTime) {
            localStorage.removeItem(key);
            cleansed.push({
              classID: prof.classID,
              studentID: prof.studentID,
              reason: `Duplicate match with ${dup.duplicateStudent.classID}_${dup.duplicateStudent.studentID} (${dup.percentage}%)`
            });
          }
        }
      }
    }

    if (cleansed.length > 0) {
      console.log(`[Persistence] auditAndCleanseProfiles cleansed ${cleansed.length} record(s):`, cleansed);
    }
    return { cleansedCount: cleansed.length, cleansedStudents: cleansed };
  }

  /**
   * Submit telemetry / facial record / answer to Google Form via mode: 'no-cors' POST
   * @param {Object} record { classID, studentID, dateID, scoreTag }
   * @returns {Promise<boolean>}
   */
  async function submitFormRecord(record) {
    if (!record) return false;
    const classID = String(record.classID || "").trim().toUpperCase();
    const studentID = String(record.studentID || "").trim();
    const dateID = String(record.dateID || "").trim();
    const scoreTag = String(record.scoreTag !== undefined ? record.scoreTag : (record.score !== undefined ? record.score : "")).trim();

    const payload = {};
    payload[PERSISTENCE_CONFIG.formFields.classID] = classID;
    payload[PERSISTENCE_CONFIG.formFields.studentID] = studentID;
    payload[PERSISTENCE_CONFIG.formFields.dateID] = dateID;
    payload[PERSISTENCE_CONFIG.formFields.score] = scoreTag;

    // Check test bypass hooks for automated testing
    if (typeof window !== 'undefined') {
      try {
        if (window.__BYPASS_FORM_SUBMIT__ === true) return true;
        if (window.location && window.location.search) {
          const urlParams = new URLSearchParams(window.location.search);
          if (urlParams.get('test_bypass_probe') === '1' || urlParams.get('bypass_macau') === '1') {
            return true;
          }
        }
      } catch (e) {}
    }

    // Check online status; if offline, automatically enqueue
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    if (!isOnline) {
      console.log("[Persistence] Browser is offline. Enqueuing Form record to LocalStorage queue.");
      OfflineSyncManager.enqueue("FORM", PERSISTENCE_CONFIG.googleFormUrl, payload);
      return true;
    }

    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(function () { controller.abort(); }, 3500) : null;
      const bodyParams = new URLSearchParams(payload);
      await fetch(PERSISTENCE_CONFIG.googleFormUrl, {
        method: "POST",
        mode: "no-cors",
        signal: controller ? controller.signal : undefined,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: bodyParams.toString()
      });
      if (timeoutId) clearTimeout(timeoutId);
      console.log("[Persistence] Form record successfully submitted (no-cors).");
      return true;
    } catch (err) {
      console.warn("[Persistence] Form submission network error, saving to offline queue:", err.message);
      OfflineSyncManager.enqueue("FORM", PERSISTENCE_CONFIG.googleFormUrl, payload);
      return false;
    }
  }


  /**
   * Upload facial snapshot JPEG (Base64) to Google Drive via GAS Web App POST
   * @param {Object} uploadData { classID, studentID, studentName, imageBase64, tag }
   * @returns {Promise<{success: boolean, fileId?: string, error?: string}>}
   */
  async function uploadDrivePhoto(uploadData) {
    if (!uploadData || !uploadData.imageBase64) {
      return { success: false, error: "Missing imageBase64 payload" };
    }

    const payload = {
      classID: String(uploadData.classID || "").trim().toUpperCase(),
      studentID: String(uploadData.studentID || "").trim(),
      studentName: String(uploadData.studentName || "").trim(),
      imageBase64: uploadData.imageBase64,
      tag: String(uploadData.tag || "REGISTRATION").trim().toUpperCase(),
      folderId: uploadData.folderId || "1oY52JyAqLLQQiETq8A-hre9jZ_goLHiY"
    };
    if (uploadData.timestamp || uploadData.updatedAt) {
      payload.timestamp = uploadData.timestamp || uploadData.updatedAt;
    }
    if (uploadData.version) {
      payload.version = uploadData.version;
    }
    if (uploadData.fileName || uploadData.filename) {
      payload.fileName = uploadData.fileName || uploadData.filename;
      payload.filename = uploadData.fileName || uploadData.filename;
    }

    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    const targetUrl = uploadData.gasUrl || PERSISTENCE_CONFIG.gasDriveUploaderUrl;

    // If offline or placeholder URL, manage queue or simulated completion
    if (!isOnline) {
      console.log("[Persistence] Offline: enqueuing Drive photo upload.");
      OfflineSyncManager.enqueue("DRIVE", targetUrl, payload);
      const offlineTs = payload.timestamp || Date.now();
      const offlineFileName = payload.fileName || payload.filename || `${payload.classID}_${payload.studentID}_${payload.studentName}_${offlineTs}_${payload.tag}.jpg`;
      return { success: true, queued: true, fileName: offlineFileName, filename: offlineFileName, message: "Queued for upload when online" };
    }

    // Check if real GAS URL configured
    const isPlaceholder = targetUrl.includes("placeholder_drive_uploader");
    if (isPlaceholder) {
      console.log("[Persistence] GAS Drive URL is placeholder. Simulated local archive complete.");
      const ts = payload.timestamp || Date.now();
      const resolvedFileName = payload.fileName || payload.filename || `${payload.classID}_${payload.studentID}_${payload.studentName}_${ts}_${payload.tag}.jpg`;
      return {
        success: true,
        simulated: true,
        fileId: "mock_drive_file_" + ts,
        fileName: resolvedFileName,
        filename: resolvedFileName,
        folderId: payload.folderId,
        tag: payload.tag,
        timestamp: ts,
        version: payload.version || 1
      };
    }

    try {
      // Use text/plain;charset=utf-8 to bypass CORS OPTIONS preflight check in GAS
      const res = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=utf-8"
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data && data.success === false) {
        throw new Error(data.error || "GAS photo upload rejected");
      }
      return data;
    } catch (err) {
      console.warn("[Persistence] Drive photo upload failed, enqueuing:", err.message);
      OfflineSyncManager.enqueue("DRIVE", targetUrl, payload);
      return { success: false, queued: true, error: err.message };
    }
  }

  /**
   * Offline Sync Manager with LocalStorage Queue & Exponential Backoff + Jitter
   */
  const OfflineSyncManager = {
    isFlushing: false,
    timerId: null,
    listeners: [],

    init: function () {
      if (typeof window !== 'undefined') {
        const self = this;
        window.addEventListener("online", function () {
          console.log("[OfflineSyncManager] Network online detected. Probing Macau network & flushing queue.");
          self.triggerProbeAndFlush();
        });
        window.addEventListener("offline", function () {
          console.log("[OfflineSyncManager] Network offline detected.");
          self.notifyListeners();
        });

        // Periodic queue inspection every 25 seconds
        if (!this.timerId) {
          this.timerId = setInterval(function () {
            self.flushQueue();
          }, 25000);
        }

        // Attach DOM triggers
        if (typeof document !== 'undefined') {
          if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", function () {
              self.bindTriggers();
            });
          } else {
            this.bindTriggers();
          }
        }

        // Auto-probe on initial load after brief delay
        setTimeout(function () {
          self.triggerProbeAndFlush();
        }, 150);
      }
      this.notifyListeners();
    },

    bindTriggers: function () {
      if (typeof document === 'undefined') return;
      const self = this;
      const triggers = [
        document.getElementById("btnManualSyncQueue"),
        document.getElementById("syncStatusBadge"),
        document.getElementById("queueSyncBadge")
      ];

      triggers.forEach(function (el) {
        if (el && !el.__syncListenerAttached) {
          el.__syncListenerAttached = true;
          el.addEventListener("click", function (e) {
            e.preventDefault();
            const status = self.getStatus();
            if (status.isFlushing) {
              console.log("[OfflineSyncManager] Flush already in progress.");
              return;
            }
            if (status.pendingCount > 0) {
              console.log("[OfflineSyncManager] User manually triggered queue flush (forceAll=true).");
              self.flushQueue(true);
            } else {
              console.log("[OfflineSyncManager] Queue is empty. No pending items.");
            }
          });
        }
      });
    },

    triggerProbeAndFlush: async function (timeoutMs) {
      const queue = this.getQueue();
      if (queue.length === 0) {
        this.notifyListeners();
        return false;
      }
      const probeFn = typeof probeMacauNetwork === 'function' ? probeMacauNetwork : (typeof window !== 'undefined' ? window.probeMacauNetwork : null);
      if (typeof probeFn === 'function') {
        try {
          const isReachable = await probeFn(timeoutMs || 3500);
          if (isReachable) {
            console.log("[OfflineSyncManager] Macau network confirmed. Flushing queue.");
            await this.flushQueue();
            return true;
          } else {
            console.log("[OfflineSyncManager] Macau network probe failed. Queue retained.");
            this.notifyListeners();
            return false;
          }
        } catch (e) {
          console.warn("[OfflineSyncManager] Probe error:", e);
        }
      } else {
        await this.flushQueue();
      }
      return false;
    },

    getQueue: function () {
      try {
        if (typeof localStorage !== 'undefined') {
          const parsed = JSON.parse(localStorage.getItem(PERSISTENCE_CONFIG.queueStorageKey) || "[]");
          if (Array.isArray(parsed)) return parsed;
        }
      } catch (e) {
        console.warn("[OfflineSyncManager] Failed to read queue:", e);
      }
      return [];
    },

    saveQueue: function (queue) {
      try {
        if (typeof localStorage !== 'undefined') {
          let safeQueue = Array.isArray(queue) ? queue : [];
          if (safeQueue.length > 200) {
            safeQueue = safeQueue.slice(-200);
          }
          try {
            localStorage.setItem(PERSISTENCE_CONFIG.queueStorageKey, JSON.stringify(safeQueue));
          } catch (storageErr) {
            console.warn("[OfflineSyncManager] LocalStorage quota exceeded, pruning oldest queue items.");
            safeQueue = safeQueue.slice(Math.floor(safeQueue.length / 2));
            localStorage.setItem(PERSISTENCE_CONFIG.queueStorageKey, JSON.stringify(safeQueue));
          }
        }
      } catch (e) {
        console.error("[OfflineSyncManager] Failed to persist queue:", e);
      }
      this.notifyListeners();
    },

    clearQueue: function () {
      this.saveQueue([]);
    },

    enqueue: function (channel, url, payload) {
      const queue = this.getQueue();
      const item = {
        id: "sync_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
        channel: channel, // "FORM" or "DRIVE"
        url: url,
        payload: payload,
        createdAt: Date.now(),
        retryCount: 0,
        nextRetryTime: Date.now(),
        status: "pending"
      };
      queue.push(item);
      this.saveQueue(queue);

      const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
      if (isOnline) {
        this.flushQueue();
      }
      return item.id;
    },

    flushQueue: async function (forceAll) {
      if (this.isFlushing) return;
      const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
      if (!isOnline) {
        this.notifyListeners();
        return;
      }

      const queue = this.getQueue();
      if (queue.length === 0) {
        this.notifyListeners();
        return;
      }

      this.isFlushing = true;
      this.updateUI("syncing", queue.length);

      const succeededIds = new Set();
      const failedItemsMap = new Map();

      try {
        const now = Date.now();
        for (let i = 0; i < queue.length; i++) {
          const item = queue[i];
          if (!forceAll && item.nextRetryTime && item.nextRetryTime > now) {
            continue;
          }

          const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
          let timeoutId = null;
          if (controller) {
            timeoutId = setTimeout(function () {
              try { controller.abort(); } catch (e) {}
            }, 3500);
          }

          try {
            if (item.channel === "FORM") {
              const bodyParams = new URLSearchParams(item.payload);
              const fetchOpts = {
                method: "POST",
                mode: "no-cors",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: bodyParams.toString()
              };
              if (controller) fetchOpts.signal = controller.signal;
              await fetch(item.url, fetchOpts);
            } else if (item.channel === "DRIVE") {
              // If placeholder, skip real fetch
              if (!item.url.includes("placeholder_drive_uploader")) {
                const fetchOpts = {
                  method: "POST",
                  headers: { "Content-Type": "text/plain;charset=utf-8" },
                  body: JSON.stringify(item.payload)
                };
                if (controller) fetchOpts.signal = controller.signal;
                const res = await fetch(item.url, fetchOpts);
                if (!res.ok) {
                  throw new Error(`HTTP ${res.status}`);
                }
                const data = await res.json();
                if (data && data.success === false) {
                  throw new Error(data.error || "GAS photo upload rejected");
                }
              }
            }
            // Request succeeded
            succeededIds.add(item.id);
          } catch (err) {
            console.warn(`[OfflineSyncManager] Retry failed for ${item.id}:`, err.message);
            item.retryCount = (item.retryCount || 0) + 1;
            // Exponential backoff with jitter: min(2000 * 2^retryCount, 60000) + rand(0..1000)
            const backoff = Math.min(2000 * Math.pow(2, item.retryCount), 60000) + Math.random() * 1000;
            item.nextRetryTime = Date.now() + backoff;
            item.status = "failed";
            failedItemsMap.set(item.id, item);

            // Abort timeout or offline detected: break immediately to release isFlushing lock within 3.5s
            if (err.name === 'AbortError' || err.name === 'TimeoutError' || (typeof navigator !== 'undefined' && !navigator.onLine)) {
              console.warn('[OfflineSyncManager] Abort timeout / offline detected; ending flush early to release lock.');
              break;
            }
          } finally {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
          }
        }

        // Re-read fresh queue from localStorage and filter out only succeeded items
        // to prevent overwriting newly enqueued items while fetch was in-flight
        const freshQueue = this.getQueue();
        const updatedQueue = freshQueue
          .filter(item => !succeededIds.has(item.id))
          .map(item => failedItemsMap.get(item.id) || item);
        this.saveQueue(updatedQueue);
      } finally {
        this.isFlushing = false;
        this.notifyListeners();
      }
    },

    getStatus: function () {
      const queue = this.getQueue();
      const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
      return {
        pendingCount: queue.length,
        isOnline: isOnline,
        isFlushing: this.isFlushing
      };
    },

    subscribe: function (callback) {
      if (typeof callback === 'function') {
        this.listeners.push(callback);
      }
    },

    notifyListeners: function () {
      const status = this.getStatus();
      this.listeners.forEach(function (cb) {
        try { cb(status); } catch (e) {}
      });

      if (!status.isOnline) {
        this.updateUI("offline", status.pendingCount);
      } else if (status.pendingCount === 0) {
        this.updateUI("synced", 0);
      } else if (this.isFlushing) {
        this.updateUI("syncing", status.pendingCount);
      } else {
        this.updateUI("pending", status.pendingCount);
      }
    },

    updateUI: function (state, count) {
      if (typeof document === 'undefined') return;
      
      // 1. Update Header Badges
      const badges = [
        document.getElementById("syncStatusBadge"),
        document.getElementById("queueSyncBadge")
      ];

      badges.forEach(function (badge) {
        if (!badge) return;
        const isClickable = (state === "pending" || state === "offline");
        badge.className = "sync-badge " + state + (isClickable ? " sync-clickable" : "");
        if (state === "synced") {
          badge.innerHTML = `<span class="badge-dot dot-green"></span> 數據已全部同步`;
          badge.title = "所有作答數據已成功同步至雲端";
          badge.style.cursor = "default";
        } else if (state === "syncing") {
          badge.innerHTML = `<span class="badge-spinner"></span> 正在同步 (${count})...`;
          badge.title = `正在同步 ${count} 筆本地作答紀錄至雲端...`;
          badge.style.cursor = "wait";
        } else if (state === "offline") {
          badge.innerHTML = `<span class="badge-dot dot-red"></span> 離線模式 (${count} 待傳送) · 點擊重試 🔄`;
          badge.title = `離線暫存 ${count} 筆紀錄，點擊嘗試重新連線同步`;
          badge.style.cursor = "pointer";
        } else if (state === "pending") {
          badge.innerHTML = `<span class="badge-dot dot-yellow"></span> 發現未同步紀錄 (${count}) · 點擊補發 🔄`;
          badge.title = `發現本地隊列有 ${count} 筆未同步紀錄，點擊立即同步到雲端`;
          badge.style.cursor = "pointer";
        }
      });

      // 2. Update Notification Banner & Action Button (#queueSyncBanner)
      const banner = document.getElementById("queueSyncBanner");
      const btnManual = document.getElementById("btnManualSyncQueue");
      const bannerText = document.getElementById("queueSyncText");
      const btnLabel = document.getElementById("btnManualSyncLabel");
      const btnIcon = document.getElementById("btnManualSyncIcon");
      const bannerIcon = document.getElementById("queueSyncIcon");

      if (banner) {
        if (state === "synced") {
          if (banner.style.display !== "none" && banner.classList.contains("banner-syncing")) {
            banner.className = "queue-sync-banner banner-synced";
            if (bannerIcon) bannerIcon.textContent = "✅";
            if (bannerText) bannerText.innerHTML = "所有離線作答與加分紀錄已成功補發至雲端！";
            if (btnManual) {
              btnManual.disabled = true;
              if (btnIcon) btnIcon.textContent = "✔";
              if (btnLabel) btnLabel.textContent = "已同步完成";
            }
            if (banner.__hideTimeout) clearTimeout(banner.__hideTimeout);
            banner.__hideTimeout = setTimeout(function () {
              banner.style.display = "none";
            }, 3500);
          } else {
            banner.style.display = "none";
          }
        } else if (state === "syncing") {
          if (banner.__hideTimeout) clearTimeout(banner.__hideTimeout);
          banner.style.display = "flex";
          banner.className = "queue-sync-banner banner-syncing";
          if (bannerIcon) bannerIcon.innerHTML = `<span class="badge-spinner"></span>`;
          if (bannerText) bannerText.innerHTML = `正在同步 <strong id="queueSyncCount">${count}</strong> 筆離線紀錄至 Google 雲端...`;
          if (btnManual) {
            btnManual.disabled = true;
            if (btnIcon) btnIcon.textContent = "⏳";
            if (btnLabel) btnLabel.textContent = "同步中...";
          }
        } else if (state === "offline") {
          if (banner.__hideTimeout) clearTimeout(banner.__hideTimeout);
          banner.style.display = "flex";
          banner.className = "queue-sync-banner banner-offline";
          if (bannerIcon) bannerIcon.textContent = "📡";
          if (bannerText) bannerText.innerHTML = `目前設備離線，已有 <strong id="queueSyncCount">${count}</strong> 筆作答紀錄安全暫存於本地`;
          if (btnManual) {
            btnManual.disabled = false;
            if (btnIcon) btnIcon.textContent = "🔄";
            if (btnLabel) btnLabel.textContent = "檢查網絡並重試";
          }
        } else if (state === "pending") {
          if (banner.__hideTimeout) clearTimeout(banner.__hideTimeout);
          banner.style.display = "flex";
          banner.className = "queue-sync-banner banner-pending";
          if (bannerIcon) bannerIcon.textContent = "⚠️";
          if (bannerText) bannerText.innerHTML = `發現本地有 <strong id="queueSyncCount">${count}</strong> 筆未同步的作答與加分紀錄！`;
          if (btnManual) {
            btnManual.disabled = false;
            if (btnIcon) btnIcon.textContent = "🔄";
            if (btnLabel) btnLabel.textContent = "立即手動同步 (flushQueue)";
          }
        }
      }
    }
  };

  // Initialize offline sync listeners if running in browser
  if (typeof window !== 'undefined') {
    OfflineSyncManager.init();
  }

  /**
   * Fast Google Macau Network Probe (R5)
   * Concurrently races lightweight Google 204 endpoints with timeout via AbortController.
   * Supports test bypass hook window.__BYPASS_MACAU_PROBE__ and URL param ?test_bypass_probe=1.
   * 
   * @param {number} timeoutMs Probe timeout in milliseconds (default: 3500ms)
   * @returns {Promise<boolean>} Resolves true if Macau network signal is verified
   */
  async function probeMacauNetwork(timeoutMs) {
    if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
      timeoutMs = 3500;
    }

    if (typeof window !== 'undefined') {
      if (window.__BYPASS_MACAU_PROBE__ === true) {
        return true;
      }
      try {
        if (window.location && window.location.search) {
          const urlParams = new URLSearchParams(window.location.search);
          if (urlParams.get('test_bypass_probe') === '1' || urlParams.get('bypass_macau') === '1') {
            return true;
          }
        }
      } catch (e) {}
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return false;
    }

    return new Promise(function (resolve) {
      var resolved = false;
      function finish(val) {
        if (!resolved) {
          resolved = true;
          resolve(val);
        }
      }

      var timer = setTimeout(function () { finish(false); }, timeoutMs);

      // 1. Bulletproof Image ping (compatible with all mobile Safari / iOS / WebKit)
      if (typeof Image !== 'undefined') {
        try {
          var img = new Image();
          img.onload = function () { clearTimeout(timer); finish(true); };
          img.onerror = function () { clearTimeout(timer); finish(true); };
          img.src = "https://www.google.com/favicon.ico?_t=" + Date.now();
        } catch (e) {}
      }

      // 2. GET fetch with mode: no-cors
      if (typeof fetch === 'function') {
        var endpoints = [
          "https://connectivitycheck.gstatic.com/generate_204",
          "https://www.google.com/generate_204"
        ];
        endpoints.forEach(function (url) {
          try {
            var buster = url + "?_t=" + Date.now() + "_" + Math.random().toString(36).substring(2, 6);
            fetch(buster, {
              method: "GET",
              mode: "no-cors",
              cache: "no-store"
            }).then(function () {
              clearTimeout(timer);
              finish(true);
            }).catch(function () {});
          } catch (e) {}
        });
      }
    });
  }/**
   * Pure JS Synchronous SHA-256 Hash
   * @param {string} ascii 
   * @returns {string} hex digest
   */
  function sha256(ascii) {
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }
    var i, j, result = '';
    var words = [];
    var str = String(ascii || "");
    var asciiBitLength = str.length * 8;
    var hash = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    var k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    for (i = 0; i < str.length; i++) {
      words[i >> 2] |= str.charCodeAt(i) << ((3 - (i % 4)) * 8);
    }
    words[asciiBitLength >> 5] |= 0x80 << (24 - (asciiBitLength % 32));
    words[(((asciiBitLength + 64) >> 9) << 4) + 15] = asciiBitLength;

    for (j = 0; j < words.length; j += 16) {
      var w = words.slice(j, j + 16);
      while (w.length < 16) w.push(0);
      var oldHash = hash.slice(0);

      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15] || 0, w2 = w[i - 2] || 0;
        var a = hash[0], e = hash[4];
        var temp1 = (hash[7]
          + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
          + ((e & hash[5]) ^ (~e & hash[6]))
          + k[i]
          + (w[i] = (i < 16) ? (w[i] || 0) : (
              (w[i - 16] || 0)
              + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
              + (w[i - 7] || 0)
              + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
            ) | 0
          )) | 0;
        var temp2 = ((rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]))) | 0;

        hash = [(temp1 + temp2) | 0, a, hash[1], hash[2], (hash[3] + temp1) | 0, hash[4], hash[5], hash[6]];
      }

      for (i = 0; i < 8; i++) {
        hash[i] = (hash[i] + oldHash[i]) | 0;
      }
    }

    for (i = 0; i < 8; i++) {
      for (j = 3; j >= 0; j--) {
        var b = (hash[i] >> (j * 8)) & 255;
        result += ((b < 16) ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }

  const PASSWORD_SALT_PREFIX = "MATH_SALT_";
  const DEFAULT_STUDENT_PASSWORD = "1234";

  /**
   * Derive salt for student
   */
  function derivePasswordSalt(classID, studentID) {
    const cid = String(classID || "").trim().toUpperCase();
    let sid = String(studentID !== undefined && studentID !== null ? studentID : "").trim();
    if ((cid === "5B" || cid === "4C" || cid === "4D") && (sid === "..." || sid === "99")) {
      sid = "99";
    }
    return `${PASSWORD_SALT_PREFIX}${cid}_${sid}`;
  }

  /**
   * Compute salted password hash
   */
  function hashPassword(password, salt) {
    const s = String(salt || "");
    const p = String(password || "");
    return sha256(`${s}:${p}`);
  }

  function shouldSnapshotOverridePwd(lsRec, snapRec) {
    if (!snapRec || !(snapRec.hash || snapRec.passwordHash)) return false;
    if (!lsRec || !(lsRec.hash || lsRec.passwordHash)) return true;
    if (!lsRec.passwordChanged && snapRec.passwordChanged) return true;
    if (lsRec.passwordChanged && !snapRec.passwordChanged) return false;
    const lsTs = Number(lsRec.updatedAt) || 0;
    const snapTs = Number(snapRec.updatedAt) || 0;
    if (lsTs > 0 && snapTs > lsTs && snapRec.passwordChanged) return true;
    return false;
  }

  /**
   * Get student password record from LocalStorage or Snapshot or generate default (1234, passwordChanged: false)
   */
  function getStudentPasswordRecord(classID, studentID) {
    if (!classID || studentID === undefined || studentID === null) return null;
    const cid = String(classID).trim().toUpperCase();
    let sid = parseInt(studentID, 10);
    if ((cid === "5B" || cid === "4C" || cid === "4D") && (String(studentID).trim() === "..." || sid === 99)) {
      sid = 99;
    }
    if (isNaN(sid)) return null;

    // Validate student existence against roster, teacher account, or admin snapshot
    const rosterStudent = (typeof window !== 'undefined' && window.getStudent)
      ? window.getStudent(cid, sid)
      : ((typeof globalThis !== 'undefined' && globalThis.getStudent) ? globalThis.getStudent(cid, sid) : null);

    const adminPasswords = (typeof window !== 'undefined' && window.ADMIN_STUDENT_PASSWORDS) ||
                           (typeof globalThis !== 'undefined' && globalThis.ADMIN_STUDENT_PASSWORDS) ||
                           (typeof self !== 'undefined' && self.ADMIN_STUDENT_PASSWORDS);

    const snapKey = `${cid}_${sid}`;
    const snapRec = adminPasswords ? adminPasswords[snapKey] : null;

    if (!rosterStudent && !snapRec && !((cid === "5B" || cid === "4C" || cid === "4D") && sid === 99)) {
      return null;
    }

    const key = `math_student_password_${cid}_${sid}`;
    const salt = (snapRec && snapRec.salt) || derivePasswordSalt(cid, sid);
    const snapHash = snapRec && (snapRec.hash || snapRec.passwordHash);
    const defaultHash = snapHash || hashPassword(DEFAULT_STUDENT_PASSWORD, salt);

    let lsRec = null;
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          const parsedHash = parsed && (parsed.hash || parsed.passwordHash);
          if (parsed && parsedHash) {
            lsRec = {
              classID: cid,
              studentID: sid,
              salt: parsed.salt || salt,
              hash: String(parsedHash).toLowerCase(),
              passwordChanged: !!parsed.passwordChanged,
              updatedAt: parsed.updatedAt || 0
            };
          }
        }
      } catch (e) {
        console.warn("[Persistence] Failed to read password record:", e);
      }
    }

    const normalizedSnap = snapHash
      ? {
          classID: cid,
          studentID: sid,
          salt: snapRec.salt || salt,
          hash: String(snapHash).toLowerCase(),
          passwordChanged: !!snapRec.passwordChanged,
          updatedAt: snapRec.updatedAt || 0
        }
      : null;

    if (shouldSnapshotOverridePwd(lsRec, normalizedSnap)) {
      return normalizedSnap;
    }
    if (lsRec) {
      return lsRec;
    }
    if (normalizedSnap) {
      return normalizedSnap;
    }

    // Default password record
    return {
      classID: cid,
      studentID: sid,
      salt: salt,
      hash: defaultHash,
      passwordChanged: false,
      updatedAt: 0
    };
  }

  /**
   * Verify student password
   * @returns {boolean}
   */
  function verifyStudentPassword(classID, studentID, password) {
    const rec = getStudentPasswordRecord(classID, studentID);
    if (!rec) {
      return false;
    }
    const inputStr = String(password !== undefined && password !== null ? password : "").trim();
    if (!inputStr) {
      return false;
    }
    const computedHash = hashPassword(inputStr, rec.salt);
    return computedHash === rec.hash;
  }

  /**
   * Save student password directly (updates LocalStorage and syncs to Sheet via submitFormRecord)
   */
  function saveStudentPassword(classID, studentID, newPassword, passwordChanged) {
    if (!classID || studentID === undefined || studentID === null) return { success: false, reason: "無效的學生資訊", message: "無效的學生資訊" };
    const cid = String(classID).trim().toUpperCase();
    let sid = parseInt(studentID, 10);
    if ((cid === "5B" || cid === "4C" || cid === "4D") && (String(studentID).trim() === "..." || sid === 99)) {
      sid = 99;
    }
    if (isNaN(sid)) return { success: false, reason: "無效的學生資訊", message: "無效的學生資訊" };
    const pwdStr = String(newPassword !== undefined && newPassword !== null ? newPassword : "").trim();

    if (!/^\d+$/.test(pwdStr) || pwdStr.length < 4) {
      return { success: false, reason: "密碼必須為至少 4 位純數字", message: "密碼必須為至少 4 位純數字" };
    }
    if (passwordChanged && pwdStr === DEFAULT_STUDENT_PASSWORD) {
      return { success: false, reason: "新密碼不能與預設密碼 1234 相同", message: "新密碼不能與預設密碼 1234 相同" };
    }

    const salt = derivePasswordSalt(cid, sid);
    const hash = hashPassword(pwdStr, salt);
    const now = Date.now();
    const record = {
      classID: cid,
      studentID: sid,
      salt: salt,
      hash: hash,
      passwordChanged: !!passwordChanged,
      updatedAt: now
    };

    const adminPasswords = (typeof window !== 'undefined' && window.ADMIN_STUDENT_PASSWORDS) ||
                           (typeof globalThis !== 'undefined' && globalThis.ADMIN_STUDENT_PASSWORDS) ||
                           (typeof self !== 'undefined' && self.ADMIN_STUDENT_PASSWORDS);
    if (adminPasswords && typeof adminPasswords === 'object') {
      adminPasswords[`${cid}_${sid}`] = {
        salt: salt,
        hash: hash,
        passwordChanged: !!passwordChanged,
        updatedAt: now
      };
    }

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(`math_student_password_${cid}_${sid}`, JSON.stringify(record));
        // Also update student profile if present
        const profKey = PERSISTENCE_CONFIG.profilePrefix + `${cid}_${sid}`;
        const rawProf = localStorage.getItem(profKey);
        if (rawProf) {
          const profObj = JSON.parse(rawProf);
          profObj.passwordChanged = !!passwordChanged;
          profObj.passwordHash = hash;
          localStorage.setItem(profKey, JSON.stringify(profObj));
        }
      } catch (e) {
        console.warn("[Persistence] Failed to write password to localStorage:", e);
      }
    }

    // Dual persistence Channel: submit password record to Sheet
    submitFormRecord({
      classID: cid,
      studentID: sid,
      dateID: `PWD|HASH:${hash}|SALT:${salt}|CHANGED:${record.passwordChanged ? 1 : 0}|TS:${now}`,
      scoreTag: record.passwordChanged ? "PASSWORD_UPDATE" : "PASSWORD_INIT"
    }).catch(function (e) {
      console.warn("[Persistence] Failed to submit password record to Sheet:", e);
    });

    return { success: true, record: record, reason: "", message: "" };
  }

  /**
   * Update student password with old password verification and rule checks
   */
  function updateStudentPassword(classID, studentID, oldPassword, newPassword) {
    const vRes = verifyStudentPassword(classID, studentID, oldPassword);
    const isValid = (typeof vRes === 'object' && vRes !== null) ? !!vRes.success : !!vRes;
    if (!isValid) {
      return { success: false, reason: "原密碼不正確", message: "原密碼不正確" };
    }
    const newPwdStr = String(newPassword !== undefined && newPassword !== null ? newPassword : "").trim();
    if (!/^\d+$/.test(newPwdStr) || newPwdStr.length < 4) {
      return { success: false, reason: "新密碼必須至少為 4 位純數字", message: "新密碼必須至少為 4 位純數字" };
    }
    if (newPwdStr === DEFAULT_STUDENT_PASSWORD) {
      return { success: false, reason: "新密碼不能與預設密碼 1234 相同", message: "新密碼不能與預設密碼 1234 相同" };
    }
    const oldPwdStr = String(oldPassword !== undefined && oldPassword !== null ? oldPassword : "").trim();
    if (newPwdStr === oldPwdStr) {
      return { success: false, reason: "新密碼不得與原密碼相同", message: "新密碼不得與原密碼相同" };
    }
    return saveStudentPassword(classID, studentID, newPwdStr, true);
  }

  /**
   * Directly set student password without old password check (for testing/admin)
   */
  function setStudentPasswordDirect(classID, studentID, newPassword, passwordChanged) {
    return saveStudentPassword(classID, studentID, newPassword, passwordChanged !== undefined ? passwordChanged : true);
  }

  /**
   * Enhance student facial feature vector via weighted fusion or replacement (R3)
   * Blends candidate vector with existing profile vector and updates timestamp + version
   */
  function enhanceStudentVector(classID, studentID, candidateDescriptor, blendWeight) {
    if (!classID || studentID === undefined || studentID === null || !candidateDescriptor) return null;
    const cid = String(classID).trim().toUpperCase();
    let sid = parseInt(studentID, 10);
    if ((cid === "5B" || cid === "4C" || cid === "4D") && (String(studentID).trim() === "..." || sid === 99)) {
      sid = 99;
    }
    if (isNaN(sid)) return null;
    const candNorm = normalizeVector(candidateDescriptor);
    if (!candNorm || candNorm.length !== 128) return null;

    const prof = getStudentProfile(cid, sid);
    let targetVec = new Float32Array(candNorm);

    if (prof && prof.vector && prof.vector.length === 128) {
      const w = typeof blendWeight === 'number' ? blendWeight : 0.7; // default 70% current, 30% historical
      const blended = new Float32Array(128);
      let norm = 0;
      for (let i = 0; i < 128; i++) {
        const val = (1 - w) * prof.vector[i] + w * candNorm[i];
        blended[i] = val;
        norm += val * val;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < 128; i++) blended[i] /= norm;
        targetVec = blended;
      }
    }

    const newVersion = (prof && prof.version ? Number(prof.version) : 1) + 1;
    const now = Date.now();
    const studentName = prof && prof.name ? prof.name :
      ((typeof window !== 'undefined' && window.getStudentName) ? window.getStudentName(cid, sid) : "");

    saveStudentProfile({
      classID: cid,
      studentID: sid,
      name: studentName,
      vector: targetVec,
      timestamp: now,
      updatedAt: now,
      version: newVersion,
      forceLatest: true
    }, { forceLatest: true });

    // Submit enhanced vector to Google Sheet
    const faceAuth = (typeof globalThis !== 'undefined' && globalThis.FaceAuthModule) ||
                     (typeof window !== 'undefined' && window.FaceAuthModule);
    const serializer = (faceAuth && faceAuth.serializeDescriptorWithTimestamp) ||
                       (typeof window !== 'undefined' && window.serializeDescriptorWithTimestamp);
    if (serializer) {
      submitFormRecord({
        classID: cid,
        studentID: sid,
        dateID: serializer(targetVec, now, newVersion),
        scoreTag: `FACE_UPGRADE_v${newVersion}_${now}`,
        timestamp: now,
        version: newVersion
      }).catch(function (e) {
        console.warn("[Persistence] Failed to submit upgraded vector to Sheet:", e);
      });
    }

    return { vector: targetVec, version: newVersion, timestamp: now };
  }

  /**
   * Initialize default passwords for all 88 students and 5B 99
   */

  /**
   * Load and cache preloaded student face profiles (e.g. from 1010 platform)
   * Ensures instant offline recognition without network roundtrips
   */
  function loadPreloadedProfiles(forceAll) {
    const preloaded = (typeof window !== 'undefined' && window.PRELOADED_STUDENT_FACES) ||
                      (typeof globalThis !== 'undefined' && globalThis.PRELOADED_STUDENT_FACES);
    if (!preloaded) return 0;
    let count = 0;
    for (const k in preloaded) {
      const item = preloaded[k];
      if (!item || !item.classID || !item.studentID || !item.vector) continue;
      const cid = String(item.classID).trim().toUpperCase();
      const sid = parseInt(item.studentID, 10);
      const key = PERSISTENCE_CONFIG.profilePrefix + cid + "_" + sid;
      let existing = null;
      if (typeof localStorage !== 'undefined') {
        try {
          const raw = localStorage.getItem(key);
          if (raw) existing = JSON.parse(raw);
        } catch (e) {}
      }
      const existingTime = existing ? extractTimestamp(existing) : 0;
      const hasValidVec = existing && existing.vector && (existing.vector.length === 128 || (Array.isArray(existing.vector) && existing.vector.length === 128));

      if (!existing || !hasValidVec || forceAll || (item.ts && item.ts > existingTime)) {
        const studentName = item.name || (typeof window !== 'undefined' && window.getStudentName ? window.getStudentName(cid, sid) : `學生 ${sid}`);
        saveStudentProfile({
          classID: cid,
          studentID: sid,
          name: studentName,
          vector: item.vector,
          registeredAt: new Date(item.ts || Date.now()).toISOString(),
          updatedAt: item.ts || Date.now(),
          timestamp: item.ts || Date.now(),
          version: 1,
          forceLatest: true
        });
        count++;
      }
    }
    return count;
  }

  function initDefaultPasswords() {
    let count = 0;
    const roster = (typeof window !== 'undefined' && window.getRoster)
      ? window.getRoster()
      : ((typeof globalThis !== 'undefined' && globalThis.getRoster) ? globalThis.getRoster() : []);

    const adminPasswords = (typeof window !== 'undefined' && window.ADMIN_STUDENT_PASSWORDS) ||
                           (typeof globalThis !== 'undefined' && globalThis.ADMIN_STUDENT_PASSWORDS) ||
                           (typeof self !== 'undefined' && self.ADMIN_STUDENT_PASSWORDS);

    const studentsToInit = roster.map(function (s) {
      return { classID: s.classID, studentID: s.studentID };
    });
    studentsToInit.push({ classID: "5B", studentID: 99 }, { classID: "4C", studentID: 99 }, { classID: "4D", studentID: 99 });

    studentsToInit.forEach(function (s) {
      const cid = String(s.classID).trim().toUpperCase();
      const sid = parseInt(s.studentID, 10);
      const key = `math_student_password_${cid}_${sid}`;
      let parsed = null;
      if (typeof localStorage !== 'undefined') {
        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            const p = JSON.parse(raw);
            const ph = p && (p.hash || p.passwordHash);
            if (p && ph) {
              parsed = {
                salt: p.salt || derivePasswordSalt(cid, sid),
                hash: String(ph).toLowerCase(),
                passwordChanged: !!p.passwordChanged,
                updatedAt: p.updatedAt || 0
              };
            }
          }
        } catch (e) {}
      }
      const snap = adminPasswords ? adminPasswords[`${cid}_${sid}`] : null;
      const snapHash = snap && (snap.hash || snap.passwordHash);
      const normalizedSnap = snapHash
        ? {
            salt: snap.salt || derivePasswordSalt(cid, sid),
            hash: String(snapHash).toLowerCase(),
            passwordChanged: !!snap.passwordChanged,
            updatedAt: snap.updatedAt || 0
          }
        : null;
      if (!parsed || shouldSnapshotOverridePwd(parsed, normalizedSnap)) {
        const salt = (normalizedSnap && normalizedSnap.salt) || derivePasswordSalt(cid, sid);
        const hash = (normalizedSnap && normalizedSnap.hash) || hashPassword(DEFAULT_STUDENT_PASSWORD, salt);
        if (typeof localStorage !== 'undefined') {
          try {
            localStorage.setItem(key, JSON.stringify({
              classID: cid,
              studentID: sid,
              salt: salt,
              hash: hash,
              passwordChanged: (normalizedSnap && !!normalizedSnap.passwordChanged) || false,
              updatedAt: (normalizedSnap && normalizedSnap.updatedAt) || 0
            }));
            count++;
          } catch (e) {}
        }
      }
    });

    return { count: count };
  }

  try {
    initDefaultPasswords();
    loadPreloadedProfiles();
  } catch (e) {}

  return {
    PERSISTENCE_CONFIG: PERSISTENCE_CONFIG,
    saveStudentProfile: saveStudentProfile,
    getStudentProfile: getStudentProfile,
    hasStudentProfile: hasStudentProfile,
    getStudentProfileHistory: getStudentProfileHistory,
    getLatestStudentVector: getLatestStudentVector,
    getAllStudentProfiles: getAllStudentProfiles,
    fetchStudentFromSheet: fetchStudentFromSheet,
    syncAllProfilesFromSheet: syncAllProfilesFromSheet,
    normalizeVector: normalizeVector,
    extractTimestamp: extractTimestamp,
    submitFormRecord: submitFormRecord,
    uploadDrivePhoto: uploadDrivePhoto,
    probeMacauNetwork: probeMacauNetwork,
    OfflineSyncManager: OfflineSyncManager,
    auditAndCleanseProfiles: auditAndCleanseProfiles,
    sha256: sha256,
    hashPassword: hashPassword,
    getStudentPasswordRecord: getStudentPasswordRecord,
    verifyStudentPassword: verifyStudentPassword,
    saveStudentPassword: saveStudentPassword,
    updateStudentPassword: updateStudentPassword,
    setStudentPasswordDirect: setStudentPasswordDirect,
    enhanceStudentVector: enhanceStudentVector,
    initDefaultPasswords: initDefaultPasswords,
    loadPreloadedProfiles: loadPreloadedProfiles
  };
});
