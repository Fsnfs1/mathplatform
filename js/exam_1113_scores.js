/**
 * exam_1113_scores.js
 * Static Score Store for 1113 數學大測二 (4D)
 * UMD module supporting Browser globals, AMD, and Node.js CommonJS.
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var mod = factory();
    root.Exam1113ScoresModule = mod;
    root.EXAM_1113_SCORES = mod.EXAM_1113_SCORES;
    root.getStudentExam1113Record = mod.getStudentExam1113Record;
    root.getAllExam1113Records = mod.getAllExam1113Records;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RAW_RECORDS = [
    { classID: '4D', studentID: 1, name: '洪佳佳', score: 89 },
    { classID: '4D', studentID: 2, name: '王偉德', score: 48 },
    { classID: '4D', studentID: 3, name: '王煜鑫', score: 50 },
    { classID: '4D', studentID: 4, name: '甘俊誠', score: 67 },
    { classID: '4D', studentID: 5, name: '余浩賢', score: 70 },
    { classID: '4D', studentID: 6, name: '李青霞', score: 62 },
    { classID: '4D', studentID: 7, name: '李語鵑', score: 47 },
    { classID: '4D', studentID: 8, name: '李樂瞳', score: 61 },
    { classID: '4D', studentID: 9, name: '李穎欣', score: 64 },
    { classID: '4D', studentID: 10, name: '李臻斌', score: 62 },
    { classID: '4D', studentID: 11, name: '周梓霖', score: 14 },
    { classID: '4D', studentID: 13, name: '施舒晨', score: 70 },
    { classID: '4D', studentID: 14, name: '徐芷瑤', score: 60 },
    { classID: '4D', studentID: 15, name: '翁淮洋', score: 74 },
    { classID: '4D', studentID: 17, name: '張博聰', score: 63 },
    { classID: '4D', studentID: 18, name: '曾浚恩', score: 19 },
    { classID: '4D', studentID: 19, name: '黃悅軒', score: 56 },
    { classID: '4D', studentID: 20, name: '黃梓建', score: 46 },
    { classID: '4D', studentID: 21, name: '黃嫣然', score: 58 },
    { classID: '4D', studentID: 23, name: '劉付穎', score: 63 },
    { classID: '4D', studentID: 24, name: '劉泳欣', score: 49 },
    { classID: '4D', studentID: 25, name: '鄭佩芝', score: 45 },
    { classID: '4D', studentID: 26, name: '鄭東沅', score: 68 },
    { classID: '4D', studentID: 27, name: '盧肇琪', score: 69 },
    { classID: '4D', studentID: 28, name: '賴君華', score: 41 },
    { classID: '4D', studentID: 29, name: '譚佩泳', score: 68 },
    { classID: '4D', studentID: 30, name: '鄭梓浩', score: 9 },
    { classID: '4D', studentID: 31, name: '鄭國樺', score: 31 }
  ];

  var EXAM_1113_SCORES = {};
  var NAME_INDEX = {};

  RAW_RECORDS.forEach(function (r) {
    var entry = {
      packId: 'exam_1113_t2',
      title: '1113 數學大測二',
      classID: r.classID,
      studentID: r.studentID,
      name: r.name,
      score: r.score,
      rawScore: r.score,
      origTotal: r.score,
      newTotal: r.score,
      correctionBonus: 0,
      maxCorrectionBonus: 5,
      capScore: 120
    };
    EXAM_1113_SCORES[r.classID + '_' + r.studentID] = entry;
    NAME_INDEX[r.classID + '_' + r.name] = entry;
  });

  function cloneRecord(rec) {
    if (!rec) return null;
    return {
      packId: rec.packId,
      title: rec.title,
      classID: rec.classID,
      studentID: rec.studentID,
      name: rec.name,
      score: rec.score,
      rawScore: rec.rawScore,
      origTotal: rec.origTotal,
      newTotal: rec.newTotal,
      correctionBonus: rec.correctionBonus,
      maxCorrectionBonus: rec.maxCorrectionBonus,
      capScore: rec.capScore
    };
  }

  function getStudentExam1113Record(student) {
    if (!student || typeof student !== 'object') return null;
    var cls = String(student.classID || student.class || '').trim().toUpperCase();
    var rawId = student.studentID !== undefined ? student.studentID : student.id;
    var idNum = parseInt(rawId, 10);
    if (cls && !isNaN(idNum)) {
      var byKey = EXAM_1113_SCORES[cls + '_' + idNum];
      if (byKey) return cloneRecord(byKey);
    }
    var name = String(student.name || '').trim();
    if (cls && name && NAME_INDEX[cls + '_' + name]) {
      return cloneRecord(NAME_INDEX[cls + '_' + name]);
    }
    return null;
  }

  function getAllExam1113Records(classID) {
    var norm = classID ? String(classID).trim().toUpperCase() : '';
    return Object.keys(EXAM_1113_SCORES)
      .map(function (k) { return EXAM_1113_SCORES[k]; })
      .filter(function (r) { return !norm || r.classID === norm; })
      .map(cloneRecord);
  }

  return {
    EXAM_1113_SCORES: EXAM_1113_SCORES,
    getStudentExam1113Record: getStudentExam1113Record,
    getAllExam1113Records: getAllExam1113Records
  };
});
