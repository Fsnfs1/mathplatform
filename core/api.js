/**
 * core/api.js
 * Unified backend gateway & ScorePack Adapters (F1, F2, F7, F9, Edge Cases E1, E2, E7).
 * - `postFormEvents(events, options)`: Chunks events into batches of <= 40 (`maxEventsPerFormPost`),
 *   deduplicates by `seq`, signs each batch with `MathCoreCrypto.signSubmission`, and sends via
 *   `navigator.sendBeacon` (`useBeacon: true`) or `fetch(..., { mode: 'no-cors' })` / injectable `transportFn`.
 * - `uploadDrivePhoto({ student, examId, checkPoint, photoType, imageBase64 }, options)`:
 *   Posts to `CONFIG.endpoints.gasDriveUploaderUrl`.
 * - `fetchSheetData(params, options)`: Queries `CONFIG.endpoints.gasSheetReaderUrl` with local snapshot fallback.
 * - ScorePack Adapters (`loadScorePack(packId, student, passcode, options)`):
 *   1. `exam_1113_store` (`exam_1113_t2`) -> `js/exam_1113_scores.js` (`getStudentExam1113Record`)
 *   2. `quiz1023_store` -> `js/quiz1023_encrypted_store.js` (`getStudentQuiz1023Record`)
 *   3. `enc_folder` (`quiz_1030`) -> `quiz_results/index.json` + `decryptEncPaper` (`F4CD_1030_SECRET_`)
 *   4. `sheet_live` (`quiz_1106`) -> live Sheet / local overrides / snapshot
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./config.js'),
      require('./crypto.js'),
      require('./registry.js'),
      require('./storage.js')
    );
  } else {
    root.MathCoreApi = factory(
      root.MathCoreConfig,
      root.MathCoreCrypto,
      root.MathPlatformRegistry,
      root.MathCoreStorage
    );
  }
})(
  typeof globalThis !== 'undefined' ? globalThis : window,
  function (CONFIG, CRYPTO, REGISTRY, STORAGE) {
    'use strict';

    const MAX_BATCH_SIZE =
      (CONFIG && CONFIG.sync && CONFIG.sync.maxEventsPerFormPost) || 40;
    const FORM_URL =
      (CONFIG && CONFIG.endpoints && CONFIG.endpoints.googleFormUrl) || '';
    const FORM_FIELDS = (CONFIG &&
      CONFIG.endpoints &&
      CONFIG.endpoints.formFields) || {
      classID: 'entry.543502435',
      studentID: 'entry.1745113091',
      dateID: 'entry.1972335137',
      score: 'entry.2095507383',
    };
    const DRIVE_URL =
      (CONFIG && CONFIG.endpoints && CONFIG.endpoints.gasDriveUploaderUrl) || '';
    const SHEET_URL =
      (CONFIG && CONFIG.endpoints && CONFIG.endpoints.gasSheetReaderUrl) || '';

    let defaultTransportFn = null;
    const postedSeqHistory = new Set();
    let cachedIndex1030 = null;

    function getSubtleCrypto() {
      if (
        typeof globalThis !== 'undefined' &&
        globalThis.crypto &&
        globalThis.crypto.subtle
      ) {
        return globalThis.crypto.subtle;
      }
      if (typeof require === 'function') {
        const nodeCrypto = require('crypto');
        if (nodeCrypto.webcrypto && nodeCrypto.webcrypto.subtle) {
          return nodeCrypto.webcrypto.subtle;
        }
      }
      throw new Error('WebCrypto subtle API unavailable');
    }

    function setTransportForTest(fn) {
      defaultTransportFn = fn;
    }

    function clearPostedHistoryForTest() {
      postedSeqHistory.clear();
    }

    /**
     * Deduplicates an array of events by `seq` (Edge Case E7) and sorts ascending by `seq`.
     */
    function deduplicateEventsBySeq(events, ignoreAlreadyPosted) {
      if (!Array.isArray(events)) return [];
      const seen = new Set();
      const out = [];
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (!ev || typeof ev !== 'object') continue;
        const seqKey = ev.seq !== undefined && ev.seq !== null ? Number(ev.seq) : null;
        if (seqKey !== null && !isNaN(seqKey)) {
          if (seen.has(seqKey)) continue;
          if (!ignoreAlreadyPosted && postedSeqHistory.has(seqKey)) continue;
          seen.add(seqKey);
        }
        out.push(ev);
      }
      out.sort(function (a, b) {
        return (Number(a.seq) || 0) - (Number(b.seq) || 0);
      });
      return out;
    }

    function chunkArray(arr, chunkSize) {
      const size = Math.max(1, Number(chunkSize) || MAX_BATCH_SIZE);
      const chunks = [];
      for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
      }
      return chunks;
    }

    /**
     * Posts interaction/submission events to Google Form in chunks of at most `maxEventsPerFormPost` (40).
     * Signs each chunk with `MathCoreCrypto.signSubmission`.
     * Supports `useBeacon: true` (`navigator.sendBeacon`) for `pagehide` (Edge Case E1).
     */
    async function postFormEvents(events, options) {
      const opts = options || {};
      const maxChunk = opts.maxEventsPerFormPost || MAX_BATCH_SIZE;
      const deduped = deduplicateEventsBySeq(events, Boolean(opts.allowRepostSeq));

      if (deduped.length === 0) {
        return {
          ok: true,
          batchesSent: 0,
          eventsSent: 0,
          syncedSeqs: [],
          batches: [],
        };
      }

      const chunks = chunkArray(deduped, maxChunk);
      const transport = opts.transportFn || defaultTransportFn;
      const useBeacon = Boolean(opts.useBeacon);
      const syncedSeqs = [];
      const batchPayloads = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const first = chunk[0] || {};
        const classID = String(opts.classID || first.classID || 'UNKNOWN').toUpperCase();
        const studentID = String(opts.studentID || first.studentID || '0');
        const secretKey =
          opts.secretKey ||
          first.secretKey ||
          `${classID}${String(studentID).padStart(2, '0')}-KEY`;

        const strippedEvents = chunk.map(function (e) {
          const copy = Object.assign({}, e);
          delete copy.secretKey;
          return copy;
        });

        const batchCore = {
          v: (CONFIG && CONFIG.version) || '2.0',
          batchIndex: i,
          batchTotal: chunks.length,
          classID: classID,
          studentID: studentID,
          sid: first.sid || `${classID}_${studentID}`,
          mode: opts.mode || first.mode || 'online',
          examId: opts.examId || first.examId || 'general',
          seqStart: strippedEvents[0].seq,
          seqEnd: strippedEvents[strippedEvents.length - 1].seq,
          count: strippedEvents.length,
          ts: Date.now(),
          events: strippedEvents,
        };

        let batchSig = '';
        if (CRYPTO && typeof CRYPTO.signSubmission === 'function') {
          batchSig = await CRYPTO.signSubmission(batchCore, secretKey);
        }
        const signedBatch = Object.assign({}, batchCore, { sig: batchSig });

        const formParams = {
          [FORM_FIELDS.classID]: classID,
          [FORM_FIELDS.studentID]: studentID,
          [FORM_FIELDS.dateID]: `V2_BATCH_${signedBatch.examId}_${signedBatch.seqStart}_${signedBatch.seqEnd}`,
          [FORM_FIELDS.score]: JSON.stringify(signedBatch),
        };

        let sendSuccess = false;
        if (typeof transport === 'function') {
          const res = await transport({
            url: FORM_URL,
            useBeacon: useBeacon,
            formParams: formParams,
            signedBatch: signedBatch,
          });
          sendSuccess = res === undefined ? true : Boolean(res && res.ok !== false);
        } else if (
          useBeacon &&
          typeof globalThis !== 'undefined' &&
          globalThis.navigator &&
          typeof globalThis.navigator.sendBeacon === 'function'
        ) {
          const urlParams = new URLSearchParams(formParams);
          const blob =
            typeof Blob !== 'undefined'
              ? new Blob([urlParams.toString()], {
                  type: 'application/x-www-form-urlencoded',
                })
              : urlParams.toString();
          sendSuccess = globalThis.navigator.sendBeacon(FORM_URL, blob);
        } else if (typeof fetch === 'function') {
          const urlParams = new URLSearchParams(formParams);
          await fetch(FORM_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: urlParams.toString(),
            keepalive: useBeacon,
          });
          sendSuccess = true;
        } else {
          sendSuccess = true;
        }

        if (!sendSuccess) {
          return {
            ok: false,
            batchesSent: i,
            eventsSent: syncedSeqs.length,
            syncedSeqs: syncedSeqs,
            batches: batchPayloads,
            error: 'Batch transport failed at chunk ' + i,
          };
        }

        for (let j = 0; j < strippedEvents.length; j++) {
          const sq = strippedEvents[j].seq;
          if (sq !== undefined && sq !== null) {
            syncedSeqs.push(sq);
            postedSeqHistory.add(Number(sq));
          }
        }
        batchPayloads.push(signedBatch);
      }

      return {
        ok: true,
        batchesSent: chunks.length,
        eventsSent: deduped.length,
        syncedSeqs: syncedSeqs,
        batches: batchPayloads,
      };
    }

    /**
     * Uploads a face photo, signed/dated scratch paper, or handwritten solution photo to Google Drive via GAS.
     * @param {Object} payload - `{ student, examId, checkPoint, photoType: 'face'|'scratch_paper'|'solution', imageBase64, qid }`
     * @param {Object} [options] - `{ transportFn }`
     */
    async function uploadDrivePhoto(payload, options) {
      if (!payload || !payload.imageBase64) {
        throw new Error('uploadDrivePhoto requires imageBase64');
      }
      const opts = options || {};
      const student = payload.student || {};
      const classID = String(student.classID || payload.classID || '').toUpperCase();
      const studentID = String(student.studentID || student.id || payload.studentID || '');
      const studentName = String(student.name || payload.studentName || '');
      const photoType = payload.photoType || 'face';
      const checkPoint = payload.checkPoint || 'start';
      const examId = payload.examId || 'exam';

      const bodyObj = {
        action: 'upload_photo',
        folderId: (CONFIG && CONFIG.endpoints && CONFIG.endpoints.driveFolderId) || '',
        classID: classID,
        studentId: `${classID}_${studentID}`,
        studentID: studentID,
        studentName: studentName,
        examId: examId,
        qId: payload.qid || `${examId}_${photoType}_${checkPoint}`,
        checkPoint: checkPoint,
        photoType: photoType,
        imageBase64: payload.imageBase64,
        ts: Date.now(),
      };

      const transport = opts.transportFn || defaultTransportFn;
      if (typeof transport === 'function') {
        const res = await transport({
          url: DRIVE_URL,
          type: 'drive_upload',
          body: bodyObj,
        });
        return Object.assign(
          { status: 'success', ok: true, photoType: photoType, checkPoint: checkPoint },
          res || {}
        );
      }

      if (typeof fetch === 'function') {
        try {
          const resp = await fetch(DRIVE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(bodyObj),
          });
          if (resp && resp.ok) {
            const data = await resp.json();
            return Object.assign({ ok: true }, data);
          }
        } catch (e) {
          // Queue or return local receipt if offline/restricted
          return {
            ok: false,
            status: 'offline_queued',
            error: e.message || 'Drive upload network error',
            queuedPayload: bodyObj,
          };
        }
      }

      return {
        ok: true,
        status: 'success',
        fileId: 'LOCAL_MOCK_' + Date.now(),
        photoType: photoType,
        checkPoint: checkPoint,
      };
    }

    /**
     * Queries GAS Sheet Reader endpoint with automatic fallback to local snapshots
     * (`window.ADMIN_SNAPSHOT_DATA`, `window.VERIFIED_LEADERBOARD_SNAPSHOT`, or storage overrides).
     */
    async function fetchSheetData(params, options) {
      const opts = options || {};
      const query = params || {};
      const transport = opts.transportFn || defaultTransportFn;

      if (opts.snapshotData) {
        return {
          ok: true,
          source: 'local_snapshot',
          data: opts.snapshotData,
        };
      }

      if (typeof transport === 'function') {
        const res = await transport({
          url: SHEET_URL,
          type: 'sheet_read',
          params: query,
        });
        if (res && res.ok !== false && res.data !== undefined) {
          return res;
        }
      } else if (typeof fetch === 'function' && !opts.useSnapshotOnly) {
        try {
          const qs = new URLSearchParams(query).toString();
          const fullUrl = SHEET_URL + (qs ? '?' + qs : '');
          const resp = await fetch(fullUrl, { method: 'GET', cache: 'no-store' });
          if (resp && resp.ok) {
            const json = await resp.json();
            return { ok: true, source: 'live_sheet', data: json };
          }
        } catch (e) {
          // fallback to local snapshot
        }
      }

      // Fallback to local snapshot or teacher overrides
      const scope = typeof globalThis !== 'undefined' ? globalThis : {};
      const snapshot =
        opts.snapshotData ||
        scope.VERIFIED_LEADERBOARD_SNAPSHOT ||
        scope.ADMIN_SNAPSHOT_DATA ||
        (STORAGE && STORAGE.getItem ? STORAGE.getItem('MP_V2_SHEET_SNAPSHOT', []) : []) ||
        [];

      return {
        ok: true,
        source: 'local_snapshot',
        data: snapshot,
      };
    }

    // =========================================================================
    // ScorePack Adapters (`quiz1023_store`, `enc_folder`, `sheet_live`)
    // =========================================================================

    function ensureQuiz1023StoreLoaded() {
      const scope = typeof globalThis !== 'undefined' ? globalThis : {};
      if (typeof scope.getStudentQuiz1023Record === 'function') {
        return scope.getStudentQuiz1023Record;
      }
      if (typeof require === 'function') {
        try {
          // Ensure ROSTER_DATA is populated on globalThis before loading quiz1023_encrypted_store.js
          if (!scope.ROSTER_DATA) {
            const rosterMod = require('../js/roster.js');
            if (rosterMod && rosterMod.ROSTER_DATA) {
              scope.ROSTER_DATA = rosterMod.ROSTER_DATA;
            }
          }
          const storeMod = require('../js/quiz1023_encrypted_store.js');
          if (storeMod && typeof storeMod.getStudentQuiz1023Record === 'function') {
            return storeMod.getStudentQuiz1023Record;
          }
        } catch (e) {
          // ignore
        }
      }
      return null;
    }

    function ensureExam1113StoreLoaded() {
      const scope = typeof globalThis !== 'undefined' ? globalThis : {};
      if (typeof scope.getStudentExam1113Record === 'function') {
        return scope.getStudentExam1113Record;
      }
      if (typeof require === 'function') {
        try {
          const storeMod = require('../js/exam_1113_scores.js');
          if (storeMod && typeof storeMod.getStudentExam1113Record === 'function') {
            return storeMod.getStudentExam1113Record;
          }
        } catch (e) {
          // ignore
        }
      }
      return null;
    }

    async function loadQuiz1030Index(indexFilePath, options) {
      if (options && Array.isArray(options.indexData)) {
        return options.indexData;
      }
      if (cachedIndex1030 && !(options && options.forceReload)) {
        return cachedIndex1030;
      }
      const relPath = indexFilePath || 'quiz_results/index.json';
      if (typeof require === 'function') {
        try {
          const fs = require('fs');
          const path = require('path');
          const fullPath = path.resolve(__dirname, '..', relPath);
          const raw = fs.readFileSync(fullPath, 'utf8');
          cachedIndex1030 = JSON.parse(raw);
          return cachedIndex1030;
        } catch (e) {
          // fallback to fetch
        }
      }
      if (typeof fetch === 'function') {
        const resp = await fetch(relPath, { cache: 'no-store' });
        if (resp && resp.ok) {
          cachedIndex1030 = await resp.json();
          return cachedIndex1030;
        }
      }
      return [];
    }

    function toArrayBuffer(bufOrUint8) {
      if (!bufOrUint8) throw new Error('Empty encrypted buffer');
      if (bufOrUint8 instanceof ArrayBuffer) {
        return bufOrUint8;
      }
      if (ArrayBuffer.isView(bufOrUint8)) {
        return bufOrUint8.buffer.slice(
          bufOrUint8.byteOffset,
          bufOrUint8.byteOffset + bufOrUint8.byteLength
        );
      }
      throw new Error('Unsupported buffer type for decryptEncPaper');
    }

    /**
     * Decrypts a 1030 `.enc` binary exam paper (`quiz_results/${classID}_${studentID}.enc`).
     * Binary layout: bytes 0..12 = 12-byte AES-GCM IV, bytes 12..end = ciphertext + 16-byte auth tag.
     * Tries SHA-256 raw 256-bit key derivation across candidate salts:
     *   - `F4CD_1030_SECRET_${c}_${s}_${p}`
     *   - `MATH_SALT_${c}_${s}:${p}`
     * and candidate passcodes:
     *   - user-supplied `passcode`
     *   - `${c}${pad2(s)}-KEY` (e.g. `4C01-KEY`)
     *   - `'1234'`
     * Returns decrypted `Uint8Array` (representing `image/jpeg`).
     */
    async function decryptEncPaper(encArrayBuffer, classID, studentID, passcode) {
      const ab = toArrayBuffer(encArrayBuffer);
      if (ab.byteLength < 28) {
        throw new Error('Encrypted paper buffer too short (< 28 bytes)');
      }
      const c = String(classID || '').trim().toUpperCase();
      const sNum = parseInt(studentID, 10);
      const s = isNaN(sNum) ? String(studentID || '').trim() : String(sNum);
      const sPad2 = s.padStart(2, '0');

      const candidatePasscodes = [];
      if (passcode !== undefined && passcode !== null && String(passcode).trim() !== '') {
        candidatePasscodes.push(String(passcode).trim());
        candidatePasscodes.push(String(passcode).trim().toUpperCase());
      }
      candidatePasscodes.push(`${c}${sPad2}-KEY`);
      candidatePasscodes.push(`${c}${s}-KEY`);
      candidatePasscodes.push('1234');

      // Deduplicate passcodes preserving order
      const uniquePasscodes = [];
      for (let i = 0; i < candidatePasscodes.length; i++) {
        if (uniquePasscodes.indexOf(candidatePasscodes[i]) === -1) {
          uniquePasscodes.push(candidatePasscodes[i]);
        }
      }

      const iv = new Uint8Array(ab.slice(0, 12));
      const ciphertext = ab.slice(12);
      const subtle = getSubtleCrypto();
      const encoder = new TextEncoder();

      for (let i = 0; i < uniquePasscodes.length; i++) {
        const p = uniquePasscodes[i];
        const saltCandidates = [
          `F4CD_1030_SECRET_${c}_${s}_${p}`,
          `MATH_SALT_${c}_${s}:${p}`,
          `F4CD_1030_SECRET_${c}_${sPad2}_${p}`,
        ];
        for (let j = 0; j < saltCandidates.length; j++) {
          try {
            const keyHash = await subtle.digest(
              'SHA-256',
              encoder.encode(saltCandidates[j])
            );
            const cryptoKey = await subtle.importKey(
              'raw',
              keyHash,
              { name: 'AES-GCM' },
              false,
              ['decrypt']
            );
            const plainAb = await subtle.decrypt(
              { name: 'AES-GCM', iv: iv },
              cryptoKey,
              ciphertext
            );
            return new Uint8Array(plainAb);
          } catch (e) {
            // Try next salt/passcode candidate
          }
        }
      }

      throw new Error('Failed to decrypt 1030 exam paper: invalid passcode or corrupted file');
    }

    /**
     * Helper to encrypt a buffer using the exact 1030 `F4CD_1030_SECRET_${c}_${s}_${p}` AES-GCM format
     * (useful for testing and offline tools).
     */
    async function encryptEncPaperForTest(plainBytes, classID, studentID, passcode, useAltSalt) {
      const c = String(classID || '').trim().toUpperCase();
      const s = String(parseInt(studentID, 10));
      const p = String(passcode || `${c}${s.padStart(2, '0')}-KEY`).trim();
      const saltStr = useAltSalt
        ? `MATH_SALT_${c}_${s}:${p}`
        : `F4CD_1030_SECRET_${c}_${s}_${p}`;
      const subtle = getSubtleCrypto();
      const encoder = new TextEncoder();
      const keyHash = await subtle.digest('SHA-256', encoder.encode(saltStr));
      const cryptoKey = await subtle.importKey(
        'raw',
        keyHash,
        { name: 'AES-GCM' },
        false,
        ['encrypt']
      );
      const iv = new Uint8Array(12);
      for (let i = 0; i < 12; i++) iv[i] = (i * 17 + 5) & 0xff;
      const input =
        plainBytes instanceof Uint8Array
          ? plainBytes
          : encoder.encode(String(plainBytes));
      const ctAb = await subtle.encrypt({ name: 'AES-GCM', iv: iv }, cryptoKey, input);
      const ctU8 = new Uint8Array(ctAb);
      const combined = new Uint8Array(12 + ctU8.length);
      combined.set(iv, 0);
      combined.set(ctU8, 12);
      return combined.buffer;
    }

    async function loadEncPaperBinary(filePath, options) {
      if (options && options.encArrayBuffer) {
        return options.encArrayBuffer;
      }
      if (typeof require === 'function') {
        try {
          const fs = require('fs');
          const path = require('path');
          const fullPath = path.resolve(__dirname, '..', filePath);
          const buf = fs.readFileSync(fullPath);
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        } catch (e) {
          // fallback to fetch
        }
      }
      if (typeof fetch === 'function') {
        const resp = await fetch(filePath, { cache: 'no-store' });
        if (resp && resp.ok) {
          return await resp.arrayBuffer();
        }
      }
      return null;
    }

    /**
     * Unified ScorePack Loader (`loadScorePack(packId, student, passcode, options)`).
     * Supports:
     *  - `exam_1113_store` (`exam_1113_t2`)
     *  - `quiz1023_store` (`quiz_1023`)
     *  - `enc_folder` (`quiz_1030`)
     *  - `sheet_live` (`quiz_1106`)
     */
    async function loadScorePack(packId, student, passcode, options) {
      const opts = options || {};
      if (!student || !student.classID || student.studentID === undefined) {
        throw new Error('loadScorePack requires student { classID, studentID }');
      }
      const classID = String(student.classID).trim().toUpperCase();
      const studentIDNum = parseInt(student.studentID, 10);
      const studentIDStr = isNaN(studentIDNum)
        ? String(student.studentID).trim()
        : String(studentIDNum);
      const sid = `${classID}_${studentIDStr}`;

      const packDef =
        (REGISTRY &&
          Array.isArray(REGISTRY.scorePacks) &&
          REGISTRY.scorePacks.find(function (p) {
            return p.id === packId;
          })) || {
          id: packId,
          title: packId,
          adapter:
            packId === 'exam_1113_t2'
              ? 'exam_1113_store'
              : packId === 'quiz_1023'
                ? 'quiz1023_store'
                : packId === 'quiz_1030'
                  ? 'enc_folder'
                  : 'sheet_live',
          folder: 'quiz_results',
          indexFile: 'quiz_results/index.json',
        };

      // Check teacher score overrides in storage first (D3 reason-free teacher fine-tuning)
      const overridesMap =
        (STORAGE &&
          typeof STORAGE.getItem === 'function' &&
          STORAGE.getItem('MP_V2_TEACHER_SCORE_OVERRIDES', {})) ||
        {};
      const legacyOverridesMap =
        (STORAGE &&
          typeof STORAGE.getItem === 'function' &&
          STORAGE.getItem('MP_V2_TEACHER_OVERRIDES', {})) ||
        {};
      const correctionBonusMap =
        (STORAGE &&
          typeof STORAGE.getItem === 'function' &&
          STORAGE.getItem('MP_V2_CORRECTION_BONUSES', {})) ||
        {};
      const overrideKey = `${packDef.id}:${sid}`;
      const legacyKey = `${packDef.id}_${sid}`;
      let teacherOverride = overridesMap[overrideKey] || null;
      if (!teacherOverride && legacyOverridesMap[legacyKey] !== undefined) {
        const numVal = Number(legacyOverridesMap[legacyKey]);
        if (!isNaN(numVal)) {
          teacherOverride = { newScore: numVal };
        }
      }

      if (packDef.adapter === 'exam_1113_store') {
        const getRec = ensureExam1113StoreLoaded();
        if (typeof getRec !== 'function' && !teacherOverride) {
          return {
            ok: false,
            packId: packDef.id,
            title: packDef.title,
            error: 'exam_1113_scores not loaded',
          };
        }
        const rec =
          typeof getRec === 'function'
            ? getRec({
                classID: classID,
                studentID: studentIDNum,
                name: student.name || '',
              })
            : null;
        const maxCorrectionBonus =
          packDef.maxCorrectionBonus !== undefined ? Number(packDef.maxCorrectionBonus) : 5;
        const capScore = packDef.capScore !== undefined ? Number(packDef.capScore) : 120;
        const baseScore =
          teacherOverride && typeof teacherOverride.newScore === 'number'
            ? teacherOverride.newScore
            : rec && rec.score !== undefined && rec.score !== null
              ? Number(rec.score)
              : null;
        const rawCorr =
          correctionBonusMap[overrideKey] !== undefined
            ? Number(correctionBonusMap[overrideKey])
            : correctionBonusMap[legacyKey] !== undefined
              ? Number(correctionBonusMap[legacyKey])
              : rec && rec.correctionBonus !== undefined
                ? Number(rec.correctionBonus)
                : 0;
        const correctionBonus = Math.max(
          0,
          Math.min(isNaN(rawCorr) ? 0 : rawCorr, maxCorrectionBonus)
        );
        const found = baseScore !== null;

        return {
          ok: true,
          found: found,
          packId: packDef.id,
          title: packDef.title,
          adapter: 'exam_1113_store',
          packType: packDef.packType || 'major_exam',
          bonusMode: packDef.bonusMode || 'correction',
          maxCorrectionBonus: maxCorrectionBonus,
          capScore: capScore,
          classID: (rec && rec.classID) || classID,
          studentID: (rec && rec.studentID) || studentIDNum,
          name: (rec && rec.name) || student.name || '',
          score: baseScore,
          origScore: rec && rec.score !== undefined ? Number(rec.score) : null,
          newTotal: baseScore,
          origTotal: rec && rec.score !== undefined ? Number(rec.score) : null,
          correctionBonus: correctionBonus,
          teacherAdjusted: Boolean(teacherOverride),
          record: found
            ? Object.assign({}, rec || {}, {
                classID: (rec && rec.classID) || classID,
                studentID: (rec && rec.studentID) || studentIDNum,
                name: (rec && rec.name) || student.name || '',
                score: baseScore,
                newTotal: baseScore,
                origTotal: rec && rec.score !== undefined ? Number(rec.score) : baseScore,
                correctionBonus: correctionBonus,
                maxCorrectionBonus: maxCorrectionBonus,
                capScore: capScore,
              })
            : null,
          raw: rec,
        };
      }

      if (packDef.adapter === 'quiz1023_store') {
        const getRec = ensureQuiz1023StoreLoaded();
        if (typeof getRec !== 'function') {
          return {
            ok: false,
            packId: packDef.id,
            title: packDef.title,
            error: 'quiz1023_encrypted_store not loaded',
          };
        }
        const rec = getRec({
          classID: classID,
          studentID: studentIDNum,
          name: student.name || '',
        });
        if (!rec) {
          return {
            ok: false,
            packId: packDef.id,
            title: packDef.title,
            found: false,
            score: null,
          };
        }
        const baseScore =
          teacherOverride && typeof teacherOverride.newScore === 'number'
            ? teacherOverride.newScore
            : rec.newTotal;
        return {
          ok: true,
          found: true,
          packId: packDef.id,
          title: packDef.title,
          adapter: 'quiz1023_store',
          classID: rec.classID || classID,
          studentID: rec.studentID || studentIDNum,
          name: rec.name || student.name || '',
          score: baseScore,
          origScore: rec.origTotal,
          newTotal: baseScore,
          origTotal: rec.origTotal,
          details: rec.details || [],
          teacherAdjusted: Boolean(teacherOverride),
          record: Object.assign({}, rec, { score: baseScore, newTotal: baseScore }),
          raw: rec,
        };
      }

      if (packDef.adapter === 'enc_folder') {
        const indexList = await loadQuiz1030Index(packDef.indexFile, opts);
        const entry =
          (Array.isArray(indexList) &&
            indexList.find(function (item) {
              return (
                String(item.classID).trim().toUpperCase() === classID &&
                String(parseInt(item.studentID, 10)) === studentIDStr
              );
            })) ||
          null;

        if (!entry) {
          return {
            ok: false,
            found: false,
            packId: packDef.id,
            title: packDef.title,
            adapter: 'enc_folder',
            score: null,
          };
        }

        const finalScore =
          teacherOverride && typeof teacherOverride.newScore === 'number'
            ? teacherOverride.newScore
            : Number(entry.score);

        const result = {
          ok: true,
          found: true,
          packId: packDef.id,
          title: packDef.title,
          adapter: 'enc_folder',
          classID: classID,
          studentID: studentIDNum,
          name: entry.name || student.name || '',
          score: finalScore,
          origScore: Number(entry.score),
          timestamp: entry.timestamp || '',
          file: entry.file || `${classID}_${studentIDStr}.enc`,
          folder: packDef.folder || 'quiz_results',
          teacherAdjusted: Boolean(teacherOverride),
          record: Object.assign({}, entry, { score: finalScore, newTotal: finalScore }),
          decryptedImageBytes: null,
          decryptedMimeType: 'image/jpeg',
        };

        if (opts.decryptPaper && passcode) {
          const folder = packDef.folder || 'quiz_results';
          const encPath = `${folder}/${result.file}`;
          const encAb = await loadEncPaperBinary(encPath, opts);
          if (encAb) {
            result.decryptedImageBytes = await decryptEncPaper(
              encAb,
              classID,
              studentIDStr,
              passcode
            );
          }
        }

        return result;
      }

      // Default: `sheet_live` adapter (e.g., `quiz_1106`)
      const sheetRes = await fetchSheetData(
        { packId: packDef.id, classID: classID, studentID: studentIDStr },
        opts
      );
      const rows = Array.isArray(sheetRes.data)
        ? sheetRes.data
        : sheetRes.data && Array.isArray(sheetRes.data.rows)
          ? sheetRes.data.rows
          : [];

      const matchedRow =
        rows.find(function (r) {
          if (!r) return false;
          const rClass = String(r.classID || r.class || '').trim().toUpperCase();
          const rId = String(parseInt(r.studentID || r.id, 10));
          const rPack = r.packId || r.examId || packDef.id;
          return rClass === classID && rId === studentIDStr && (!r.packId || rPack === packDef.id);
        }) || null;

      const rawScore = matchedRow
        ? Number(matchedRow.score !== undefined ? matchedRow.score : matchedRow.rawScore || 0)
        : opts.defaultScore !== undefined
          ? Number(opts.defaultScore)
          : null;

      const effectiveScore =
        teacherOverride && typeof teacherOverride.newScore === 'number'
          ? teacherOverride.newScore
          : rawScore;

      return {
        ok: true,
        found: matchedRow !== null || teacherOverride !== null || opts.defaultScore !== undefined,
        packId: packDef.id,
        title: packDef.title,
        adapter: 'sheet_live',
        classID: classID,
        studentID: studentIDNum,
        name: (matchedRow && matchedRow.name) || student.name || '',
        score: effectiveScore,
        origScore: rawScore,
        teacherAdjusted: Boolean(teacherOverride),
        source: sheetRes.source,
        record: matchedRow || effectiveScore !== null ? Object.assign({}, matchedRow || {}, { score: effectiveScore, newTotal: effectiveScore }) : null,
        raw: matchedRow,
      };
    }

    return {
      postFormEvents: postFormEvents,
      uploadDrivePhoto: uploadDrivePhoto,
      fetchSheetData: fetchSheetData,
      loadScorePack: loadScorePack,
      decryptEncPaper: decryptEncPaper,
      encryptEncPaperForTest: encryptEncPaperForTest,
      deduplicateEventsBySeq: deduplicateEventsBySeq,
      setTransportForTest: setTransportForTest,
      clearPostedHistoryForTest: clearPostedHistoryForTest,
    };
  }
);
