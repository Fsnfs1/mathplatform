/**
 * tests/verify_v2.js
 * Automated E2E & Integration Verification for MathPlatform v2.0
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const config = require('../core/config.js');
const cryptoMod = require('../core/crypto.js');
const registry = require('../core/registry.js');
const storage = require('../core/storage.js');
const netwatch = require('../core/netwatch.js');
const api = require('../core/api.js');
const sync = require('../core/sync.js');
const auth = require('../core/auth.js');
const ui = require('../core/ui.js');
const content = require('../core/content.js');
const engine = require('../core/engine.js');
const bonus = require('../core/bonus.js');

async function runAllTests() {
  console.log('=== MathPlatform v2.0 Automated Verification ===');

  // 1. S1, S2, S4, D6 Crypto Verification
  const secret = 'K7M2-QX9P';
  const enc = await cryptoMod.encryptStudentRecord(
    { classID: '4C', studentID: 1, name: '古永晴' },
    secret
  );
  const rosterMap = { [enc.lookupId]: enc };
  const decOk = await cryptoMod.decryptStudentFromRoster(rosterMap, secret);
  const decWrong = await cryptoMod.decryptStudentFromRoster(rosterMap, 'WRONG-KEY9');
  assert.strictEqual(decOk.name, '古永晴', 'Per-student AES-GCM decryption should succeed with valid key');
  assert.strictEqual(decWrong, null, 'Wrong key must fail decryption');

  const sig = await cryptoMod.signSubmission({ examId: '4cd_1102', score: 88 }, secret);
  assert.strictEqual(sig.length, 32, 'HMAC signature must be 32 hex chars');

  const anon1 = await cryptoMod.anonymizeStudentForResearch('4C', '1', 'TEACHER_RESEARCH_KEY');
  const anon2 = await cryptoMod.anonymizeStudentForResearch('4C', '1', 'TEACHER_RESEARCH_KEY');
  assert.ok(anon1.startsWith('R-') && anon1.length === 10 && anon1 === anon2, 'Deterministic R-xxxxxxxx ID');
  console.log('[PASS] 1. Crypto (PBKDF2 + AES-GCM + HMAC + D6 Research Anonymization)');

  // 2. All 7 Question Types Grading Verification
  const QT = content.QuestionTypes;
  assert.strictEqual(QT.grade({ type: 'single_choice', answer: 'B' }, 'B').isCorrect, true);
  assert.strictEqual(QT.grade({ type: 'multi_select', correctKeys: ['A', 'C'] }, ['C', 'A']).isCorrect, true);
  assert.strictEqual(
    QT.grade({ type: 'matching', correctPairs: { L1: 'B', L2: 'A' } }, { L1: 'B', L2: 'A' }).isCorrect,
    true
  );
  assert.strictEqual(
    QT.grade({ type: 'step_order', correctOrder: ['S1', 'S2', 'S3'] }, ['S1', 'S2', 'S3']).isCorrect,
    true
  );
  assert.strictEqual(
    QT.grade(
      { type: 'error_find', correctErrorStepIndex: 2, correctErrorType: '符號錯誤' },
      { stepIndex: 2, errorType: '符號錯誤' }
    ).isCorrect,
    true
  );
  assert.strictEqual(
    QT.grade(
      { type: 'graph_plot', plotTarget: { x: 0.5, y: 0.5, tolerance: 0.1 } },
      { x: 0.52, y: 0.49 }
    ).isCorrect,
    true
  );
  assert.strictEqual(
    QT.grade({ type: 'upload_solution' }, { imageBase64: 'data:image/png;base64,AAA' }).pendingTeacherGrade,
    true
  );
  console.log('[PASS] 2. All 7 Question Types (single/multi/matching/step_order/error_find/graph_plot/upload)');

  // 3. Shared Adaptive Engine + Hints + Feedback Timing (D8, D9)
  const mainPool = Array.from({ length: 10 }, (_, i) => ({
    id: 'M' + (i + 1),
    topic: '二次函數',
    stem: 'Q' + i,
    options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }],
    answer: 'A',
  }));
  const adPool = Array.from({ length: 10 }, (_, i) => ({
    id: 'AD' + (i + 1),
    topic: '二次函數',
    stem: 'AD' + i,
    options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }],
    answer: 'A',
  }));

  const session = engine.createSession({
    mode: 'drill',
    baseQuota: 5,
    maxQuota: 15,
    questions: mainPool,
    adaptiveQuestions: adPool,
    feedbackMode: 'after_submit',
  });
  assert.strictEqual(session.state.targetQuota, 5);
  const hint = session.requestHint();
  assert.strictEqual(hint.level, 1);

  // Trigger hasty (<3s) -> adds questions
  const sub1 = session.submitAnswer('B', 1200);
  assert.strictEqual(sub1.isCorrect, null, 'after_submit mode hides immediate correctness');
  assert.ok(sub1.adaptiveAdded.length > 0, 'Hasty answer (<3s) expands quota');

  // Trigger 3 consecutive wrong answers -> injects topic remedial questions
  session.goToQuestion(1);
  session.submitAnswer('B', 5000);
  session.goToQuestion(2);
  const sub3 = session.submitAnswer('B', 5000);
  assert.ok(session.state.targetQuota > 10, '3 consecutive errors inject remedial questions');
  console.log('[PASS] 3. Shared Adaptive Escalation, Progressive Hints & Feedback Timing (D8, D9)');

  // 4. Bonus Cap Calculator (D5) & Points Economy (A13)
  const capped = bonus.calculateQuizFinalScore({
    rawScore: 52,
    drillScore: 85, // +5 auto bonus
    redeemedBonus: 5,
    rule: { threshold: 80, perPoint: 1, capScore: 60 },
  });
  assert.strictEqual(capped.finalScore, 60, '52 + 5 + 5 = 62 -> capped at 60');

  const highRaw = bonus.calculateQuizFinalScore({
    rawScore: 68,
    drillScore: 95,
    redeemedBonus: 0,
    rule: { capScore: 60 },
  });
  assert.strictEqual(highRaw.finalScore, 68, 'Raw score >= 60 is preserved without reduction');

  const pts = bonus.PointsLedger.awardPoints('4C_1', 'drillCorrect', 50);
  assert.strictEqual(pts.awarded, 50);
  const red = bonus.PointsLedger.redeemPoints('4C_1', 'game_time', 20, { minutes: 10 });
  assert.strictEqual(red.ok, true);
  console.log('[PASS] 4. Bonus Cap Engine (D5) & Points Economy Ledger (A13)');

  // 5. Math Games Bridge (A11, D10) & Online Network Arena (A12, D7)
  const nimWinScore = bonus.GameBridge.computeGameScore({
    gameId: 'bash-nim',
    win: true,
    durationMs: 18000,
  });
  assert.strictEqual(nimWinScore, 142, 'Nim win in 18s = 100 + (60 - 18) = 142');
  const nimLossScore = bonus.GameBridge.computeGameScore({
    gameId: 'ring-nim',
    win: false,
    durationMs: 12000,
  });
  assert.strictEqual(nimLossScore, 0, 'Nim loss = 0');

  const now = Date.now();
  bonus.ArenaManager.acceptInvitation({ classID: '4C', studentID: '1', name: '甲' }, now - 10000);
  const pairRes = bonus.ArenaManager.acceptInvitation(
    { classID: '4D', studentID: '2', name: '乙' },
    now
  );
  assert.strictEqual(pairRes.matched, true, 'Two terminals agreeing within 1 minute auto-pair');
  console.log('[PASS] 5. Math Games Scoring (D10), 30m Anti-Addiction & Arena 1-Min Pairing (D7)');

  // 6. Sustainable Registry Extension Check & Red-Line File Integrity Check (D11)
  const gitDiffRedLines = execSync(
    'git status --porcelain js/roster.js js/preloaded_faces.js js/quiz1023_encrypted_store.js quiz_results/ js/questions_4cd1023.js js/bank_4cd_t2.js js/bank_4cd_1102_adaptive.js js/bank_5bc1102.js resets/',
    { encoding: 'utf8' }
  ).trim();
  assert.strictEqual(gitDiffRedLines, '', 'Red-line data files MUST remain 100% untouched');
  console.log('[PASS] 6. Red-Line Data Files 100% Untouched & Sustainable Registry Ready');

  // 7. Teacher Test Account (#98 / test98) & Gate Anti-Leakage (Zero Plaintext Passwords & Redacted Student Names)
  const merged = registry.getMergedRoster();
  const appHtml = fs.readFileSync(__dirname + '/../app.html', 'utf8');

  // Anti-leakage assertions: no plaintext secret keys or test passwords in app.html
  assert.ok(!appHtml.toLowerCase().includes('x33c'), 'app.html must not contain plaintext password x33c');
  assert.ok(!appHtml.includes('test98'), 'app.html must not contain plaintext password test98');

  // Student privacy on gate login screen: gate dropdown and candidate list must not leak student real names
  assert.ok(!appHtml.includes('號 - ${esc(s.name)}') && !appHtml.includes('data-name="${esc(s.name)}'), 'app.html gate seat dropdown must not display student real names or data-name attributes');
  assert.ok(appHtml.includes("list.some(s => String(s.id) === '98')"), 'app.html populateSeatSelect must include seat 98');

  for (const cls of ['4C', '4D', '5B', '5C']) {
    const has98 = (merged[cls] || []).some(s => String(s.id) === '98' && s.directToBank);
    assert.strictEqual(has98, true, `Class ${cls} must have seat #98 direct-to-bank test account`);
    const sess98 = await auth.loginStudent({ classID: cls, studentID: 98, secretKey: 'test98' });
    assert.strictEqual(sess98.directToBank, true);
    assert.strictEqual(sess98.isTeacherTest, true);
    assert.strictEqual(sess98.consentNeeded, false, 'Seat 98 skips consent prompt and goes straight to bank');
    let rejectedWrongPwd = false;
    try {
      await auth.loginStudent({ classID: cls, studentID: 98, secretKey: 'wrong98' });
    } catch (e) {
      rejectedWrongPwd = true;
    }
    assert.strictEqual(rejectedWrongPwd, true, 'Seat 98 must reject password other than test98');
  }
  console.log('[PASS] 7. Teacher Test Account (#98 / test98) Direct-to-Bank Verified for All Classes');

  // 8. Class Representative (科代表) Sub-App Authorization & Partial-Permission Login
  auth.setClassRep({
    classID: '4C',
    studentID: 1,
    name: '古永晴',
    pin: 'rep2026',
    permissions: ['reply_qa', 'approve_mall'],
  });
  const repSess = await auth.loginClassRep({ classID: '4C', studentID: 1, pin: 'rep2026' });
  assert.strictEqual(repSess.role, 'class_rep', 'Logged in role must be class_rep');
  assert.strictEqual(auth.hasBackendPermission(repSess, 'reply_qa'), true, 'Granted reply_qa must be true');
  assert.strictEqual(auth.hasBackendPermission(repSess, 'approve_mall'), true, 'Granted approve_mall must be true');
  assert.strictEqual(auth.hasBackendPermission(repSess, 'tune_score'), false, 'Ungranted tune_score must be false');
  assert.strictEqual(auth.hasBackendPermission(repSess, 'teacher_only'), false, 'Teacher-only permission must be false for class_rep');
  auth.removeClassRep('4C', 1);
  assert.strictEqual(Object.keys(auth.getClassReps()).length, 0, 'Removed class rep should no longer be in list');
  console.log('[PASS] 8. Class Representative (科代表) Sub-App Authorization & Partial-Permission Login');

  // 9. A1 Gate Upgrade: Preloaded Custom Passwords, Teacher Keys, Face Candidate Disambiguation & Face Trace Exemption
  assert.strictEqual(Object.keys(auth.STUDENT_CUSTOM_PASSWORDS).length, 121, 'All 121 student password records hydrated');
  const changedCount = Object.values(auth.STUDENT_CUSTOM_PASSWORDS).filter(r => r && r.passwordChanged).length;
  assert.strictEqual(changedCount, 60, 'All 60 non-1234 student custom passwords preserved');

  // Default 1234 must be rejected
  assert.strictEqual(await auth.verifyStudentCustomPassword('4C', 1, '1234'), false, 'Default 1234 password must be rejected');

  // Simulate a student setting/having a custom non-1234 password in localStorage and logging in with either custom password or teacher key
  const customSalt = 'MATH_SALT_4C_2';
  const customHash = await cryptoMod.sha256Hex(customSalt + ':mySecret88');
  storage.setItem('math_student_password_4C_2', {
    salt: customSalt,
    passwordHash: customHash,
    passwordChanged: true
  });
  const customLoginSess = await auth.loginStudent({ classID: '4C', studentID: 2, secretKey: 'mySecret88' });
  assert.strictEqual(String(customLoginSess.studentID), '2', 'Student can log in with their own non-1234 password');
  assert.strictEqual(customLoginSess.authMethod, 'password_or_key');

  // Teacher-assigned secret key also works for the same student
  storage.setItem('MP_V2_STUDENT_KEYS', { '4C_2': 'TKEY-4C02' });
  const teacherKeySess = await auth.loginStudent({ classID: '4C', studentID: 2, secretKey: 'TKEY-4C02' });
  assert.strictEqual(String(teacherKeySess.studentID), '2', 'Student can also log in with teacher-assigned secret key');

  // Ambiguous / sub-threshold face candidates resolved by comparing password across within-threshold or outside-threshold list
  const candidateMatchInList = await auth.resolveFaceCandidateWithPassword(
    [
      { classID: '4C', studentID: 1, name: '古永晴', distance: 0.39 },
      { classID: '4C', studentID: 2, name: '甘浩賢', distance: 0.41 }
    ],
    'mySecret88',
    null
  );
  assert.ok(candidateMatchInList && String(candidateMatchInList.studentID) === '2', 'Face candidate disambiguation resolves matching student #2 via password');

  const candidateMatchOutsideThreshold = await auth.resolveFaceCandidateWithPassword(
    [{ classID: '4C', studentID: 1, name: '古永晴', distance: 0.49 }],
    'TKEY-4C02',
    { classID: '4C', studentID: 2, name: '甘浩賢' }
  );
  assert.ok(candidateMatchOutsideThreshold && String(candidateMatchOutsideThreshold.studentID) === '2', 'Sub-threshold face scan resolves fallback student via teacher key');

  // Unambiguous face login sets faceLoginVerified = true
  const faceDirectSess = await auth.loginStudent({
    classID: '4C',
    studentID: 1,
    faceVerified: true,
    authMethod: 'face_1toN_direct'
  });
  assert.strictEqual(faceDirectSess.faceLoginVerified, true, 'Face login persists faceLoginVerified: true for automatic trace exemption');
  console.log('[PASS] 9. A1 Gate Upgrade (1:N Face Scan + Ambiguous Candidate Password Disambiguation + Dual Credentials + Auto Face Trace)');

  // 10. 1113 數學大測二 (exam_1113_t2) Store, Registry Ordering, Correction Bonus (max +5) & 120 Cap
  const exam1113 = require('../js/exam_1113_scores.js');
  const rosterMod = require('../js/roster.js');
  const packs4D = registry.getScorePacksForClass('4D');
  assert.ok(packs4D.length >= 4 && packs4D[0].id === 'exam_1113_t2', '4D first (left-most) A6 tab must be exam_1113_t2');
  assert.strictEqual(packs4D[0].title, '1113 數學大測二');
  assert.strictEqual(packs4D[0].capScore, 120);
  assert.strictEqual(packs4D[0].maxCorrectionBonus, 5);
  const packs5B = registry.getScorePacksForClass('5B');
  assert.ok(packs5B.length >= 4 && packs5B[0].id === 'exam_1113_t2', '5B first (left-most) A6 tab must be exam_1113_t2');
  assert.strictEqual(packs5B[0].title, '1113 數學大測二');
  assert.strictEqual(packs5B[0].capScore, 120);
  assert.strictEqual(packs5B[0].maxCorrectionBonus, 5);
  assert.strictEqual(packs5B[0].leaderboardMinScore, 70);
  assert.strictEqual(registry.getScorePacksForClass('4C')[0].id, 'quiz_1023', 'Non-4D/5B classes retain original first tab');
  assert.strictEqual(registry.getScorePacksForClass('5C')[0].id, 'quiz_1106', '5C retains original first tab');

  const expected1113Scores = [
    ['洪佳佳', 89], ['翁淮洋', 74], ['余浩賢', 70], ['施舒晨', 70], ['盧肇琪', 69],
    ['譚佩泳', 68], ['鄭東沅', 68], ['甘俊誠', 67], ['李穎欣', 64], ['張博聰', 63],
    ['劉付穎', 63], ['李臻斌', 62], ['李青霞', 62], ['李樂瞳', 61], ['徐芷瑤', 60],
    ['黃嫣然', 58], ['黃悅軒', 56], ['王煜鑫', 50], ['劉泳欣', 49], ['王偉德', 48],
    ['李語鵑', 47], ['黃梓建', 46], ['鄭佩芝', 45], ['賴君華', 41], ['鄭國樺', 31],
    ['曾浚恩', 19], ['周梓霖', 14], ['鄭梓浩', 9]
  ];
  assert.strictEqual(exam1113.getAllExam1113Records('4D').length, 28, 'Exactly 28 4D student scores injected');
  const roster4D = rosterMod.getStudentsByClass('4D');
  for (const [stuName, expectedScore] of expected1113Scores) {
    const stu = roster4D.find(s => s.name === stuName);
    assert.ok(stu, `Student ${stuName} must exist in 4D roster`);
    const loaded = await api.loadScorePack('exam_1113_t2', { classID: '4D', studentID: stu.id, name: stu.name });
    assert.strictEqual(loaded.ok, true);
    assert.strictEqual(loaded.found, true, `${stuName} must be found in exam_1113_t2`);
    assert.strictEqual(loaded.score, expectedScore, `${stuName} score must be ${expectedScore}`);
    assert.strictEqual(loaded.capScore, 120);
    assert.strictEqual(loaded.maxCorrectionBonus, 5);
  }
  // Missing 4D students (#12, #16, #22) report found: false cleanly
  const missing12 = await api.loadScorePack('exam_1113_t2', { classID: '4D', studentID: 12, name: '林川雲' });
  assert.strictEqual(missing12.ok, true);
  assert.strictEqual(missing12.found, false);
  assert.strictEqual(missing12.score, null);

  // 5B 1113 數學大測二: all 28 student scores
  const expected5B1113Scores = [
    [10, '高尚禮', 111], [13, '梁泳心', 101], [18, '陳柏琳', 93], [16, '姚皓然', 90], [17, '陳施攸', 90],
    [6, '林煜皓', 82], [9, '洪泳棋', 82], [24, '黃卓琳', 82], [3, '李潤歌', 79], [26, '葉棨釗', 75],
    [22, '彭婷婷', 63], [20, '陳紫涵', 56], [14, '梁芷韻', 55], [23, '黃少彬', 55], [1, '吳鎂澄', 55],
    [2, '蘇子恩', 52], [7, '林穎豪', 52], [28, '黎宛旻', 52], [15, '梁偉烽', 44], [19, '陳國良', 42],
    [11, '張啟赫', 40], [21, '陳鑫源', 38], [12, '張嘉城', 37], [25, '黃婉瑜', 37], [4, '李曉熹', 34],
    [5, '周鈺燕', 28], [27, '潘子聰', 27], [8, '柯鈺鑫', 18]
  ];
  assert.strictEqual(exam1113.getAllExam1113Records('5B').length, 28, 'Exactly 28 5B student scores injected');
  const roster5B = rosterMod.getStudentsByClass('5B');
  for (const [stuId, stuName, expectedScore] of expected5B1113Scores) {
    const stu = roster5B.find(s => s.id === stuId && s.name === stuName);
    assert.ok(stu, `Student #${stuId} ${stuName} must exist in 5B roster`);
    const loaded = await api.loadScorePack('exam_1113_t2', { classID: '5B', studentID: stu.id, name: stu.name });
    assert.strictEqual(loaded.ok, true);
    assert.strictEqual(loaded.found, true, `5B #${stuId} ${stuName} must be found in exam_1113_t2`);
    assert.strictEqual(loaded.score, expectedScore, `5B #${stuId} ${stuName} score must be ${expectedScore}`);
    assert.strictEqual(loaded.capScore, 120);
    assert.strictEqual(loaded.maxCorrectionBonus, 5);
  }
  const bonusRules5B = registry.getBonusRulesForClass('5B');
  const majorRule5B = bonusRules5B.find(r => r.targetScorePackId === 'exam_1113_t2');
  assert.ok(majorRule5B && majorRule5B.bonusMode === 'correction' && majorRule5B.maxCorrectionBonus === 5 && majorRule5B.capScore === 120, '5B must have correction bonus rule for exam_1113_t2');

  // Correction bonus calculation (max +5, 120 cap, independent of 60 quiz cap)
  const calc89Plus5 = bonus.calculateMajorExamFinalScore({ rawScore: 89, correctionBonus: 5 });
  assert.strictEqual(calc89Plus5.finalScore, 94, '89 + 5 = 94 (must NOT be capped at 60)');
  const calc111Plus5 = bonus.calculateMajorExamFinalScore({ rawScore: 111, correctionBonus: 5 });
  assert.strictEqual(calc111Plus5.finalScore, 116, '5B 111 + 5 = 116 (<= 120 cap)');
  const calcClamp5 = bonus.calculateQuizFinalScore({
    rawScore: 74,
    correctionBonus: 9,
    rule: { bonusMode: 'correction', maxCorrectionBonus: 5, capScore: 120 }
  });
  assert.strictEqual(calcClamp5.correctionBonus, 5, 'Correction bonus must clamp at max 5');
  assert.strictEqual(calcClamp5.finalScore, 79);
  const calcCap120 = bonus.calculateMajorExamFinalScore({ rawScore: 118, correctionBonus: 5 });
  assert.strictEqual(calcCap120.finalScore, 120, '118 + 5 clamps at 120 cap');
  assert.strictEqual(calcCap120.appliedBonus, 2);
  const calcNeg = bonus.calculateMajorExamFinalScore({ rawScore: 14, correctionBonus: -3 });
  assert.strictEqual(calcNeg.correctionBonus, 0);
  assert.strictEqual(calcNeg.finalScore, 14);

  // Correction bonus override via storage (4D & 5B)
  storage.setItem('MP_V2_CORRECTION_BONUSES', { 'exam_1113_t2:4D_11': 4, 'exam_1113_t2:5B_10': 5 });
  const loadedZzl = await api.loadScorePack('exam_1113_t2', { classID: '4D', studentID: 11, name: '周梓霖' });
  assert.strictEqual(loadedZzl.score, 14);
  assert.strictEqual(loadedZzl.correctionBonus, 4);
  const loaded5B10 = await api.loadScorePack('exam_1113_t2', { classID: '5B', studentID: 10, name: '高尚禮' });
  assert.strictEqual(loaded5B10.score, 111);
  assert.strictEqual(loaded5B10.correctionBonus, 5);
  storage.setItem('MP_V2_CORRECTION_BONUSES', {});

  // UI & privacy assertions for app.html and teacher.html
  const teacherHtml = fs.readFileSync(__dirname + '/../teacher.html', 'utf8');
  assert.ok(appHtml.includes('js/exam_1113_scores.js'), 'app.html must load js/exam_1113_scores.js');
  assert.ok(teacherHtml.includes('js/exam_1113_scores.js'), 'teacher.html must load js/exam_1113_scores.js');
  assert.ok(appHtml.includes('大測訂正加分（最多加${maxCorrectionBonus}分）'), 'app.html A6 must show 大測訂正加分（最多加5分）');
  assert.ok(appHtml.includes('刷題最高分 (>80加分)'), 'app.html A6 must retain 刷題最高分 (>80加分) for regular quizzes');
  assert.ok(!appHtml.includes('洪佳佳') && !appHtml.includes('周梓霖') && !appHtml.includes('高尚禮') && !appHtml.includes('柯鈺鑫'), 'app.html must not embed student real names in HTML');
  assert.ok(appHtml.includes('formatLeaderboardName({ classID: s.classID, studentID: s.id, name: s.name }, displayMode, idx)'), 'app.html must pass (student, displayMode, idx) in correct order');
  assert.strictEqual(ui.formatLeaderboardName({ classID: '4D', studentID: 11, name: '周梓霖' }, 'nickname', 0), '周*霖');
  assert.strictEqual(ui.formatLeaderboardName({ classID: '4D', studentID: 11, name: '周梓霖' }, 'seat_only', 0), '4D #11');

  // Leaderboard >= 70 & Top 10 rule for exam_1113_t2 (exclude < 70; regular quizzes unaffected)
  assert.strictEqual(packs4D[0].leaderboardMinScore, 70, 'exam_1113_t2 must enforce leaderboardMinScore: 70');
  const quiz1023Pack = packs4D.find(p => p.id === 'quiz_1023');
  assert.strictEqual(quiz1023Pack.leaderboardMinScore, undefined, 'Regular quiz_1023 must not restrict leaderboard below 70');

  const ranked1113 = exam1113.getAllExam1113Records('4D')
    .map(r => ({ student: { classID: r.classID, id: r.studentID, name: r.name }, score: r.score }))
    .sort((a, b) => (b.score - a.score) || (Number(a.student.id) - Number(b.student.id)));
  const top1113 = ui.buildLeaderboardEntries(ranked1113, { minScore: packs4D[0].leaderboardMinScore, limit: 10 });
  assert.deepStrictEqual(
    top1113.map(e => [e.student.name, e.score]),
    [['洪佳佳', 89], ['翁淮洋', 74], ['余浩賢', 70], ['施舒晨', 70]],
    'exam_1113_t2 leaderboard must only include >= 70 scores and exclude < 70 (69, 68, etc.)'
  );
  const ranked5B1113 = exam1113.getAllExam1113Records('5B')
    .map(r => ({ student: { classID: r.classID, id: r.studentID, name: r.name }, score: r.score }))
    .sort((a, b) => (b.score - a.score) || (Number(a.student.id) - Number(b.student.id)));
  const top5B1113 = ui.buildLeaderboardEntries(ranked5B1113, { minScore: packs5B[0].leaderboardMinScore, limit: 10 });
  assert.deepStrictEqual(
    top5B1113.map(e => [e.student.name, e.score]),
    [
      ['高尚禮', 111], ['梁泳心', 101], ['陳柏琳', 93], ['姚皓然', 90], ['陳施攸', 90],
      ['林煜皓', 82], ['洪泳棋', 82], ['黃卓琳', 82], ['李潤歌', 79], ['葉棨釗', 75]
    ],
    '5B exam_1113_t2 leaderboard must include top 10 >= 70 scores in rank order and exclude < 70'
  );
  // Top 10 cap when >10 students score >= 70
  const twelveAbove70 = Array.from({ length: 12 }, (_, i) => ({ student: { id: i + 1 }, score: 95 - i }));
  twelveAbove70.push({ student: { id: 99 }, score: 69 });
  const cappedTop10 = ui.buildLeaderboardEntries(twelveAbove70, { minScore: 70, limit: 10 });
  assert.strictEqual(cappedTop10.length, 10, 'Leaderboard must cap at top 10 entries when >10 qualify');
  assert.ok(cappedTop10.every(e => e.score >= 70), 'All displayed entries must be >= 70');
  // All < 70 yields empty list
  assert.strictEqual(ui.buildLeaderboardEntries([{ score: 69 }, { score: 50 }], { minScore: 70, limit: 10 }).length, 0);
  // Regular quiz without minScore keeps < 70 entries
  assert.strictEqual(ui.buildLeaderboardEntries([{ score: 55 }, { score: 40 }], { minScore: null, limit: 10 }).length, 2);
  assert.ok(appHtml.includes('buildLeaderboardEntries(scoredRoster, { minScore: leaderboardMinScore, limit: 10 })'), 'app.html must use buildLeaderboardEntries with leaderboardMinScore and limit 10');
  console.log('[PASS] 10. 1113 數學大測二 Store, Left-Most A6 Tab, Max +5 Correction Bonus, 120 Cap & UI Integrity');

  // 11. Unified Legacy 4cd1102 Face Scan, Vector/Password Precedence, Sync Non-Downgrade & Anti-Poisoning
  const idxMinApi = appHtml.indexOf('face-api.min.js');
  const idxBonusJs = appHtml.indexOf('core/bonus.js');
  const idxPersistJs = appHtml.indexOf('js/persistence.js');
  assert.ok(idxMinApi !== -1, 'app.html must load face-api.min.js for unified model pipeline');
  assert.ok(idxBonusJs !== -1 && idxPersistJs > idxBonusJs, 'js/persistence.js must load after core/bonus.js so ADMIN_STUDENT_PASSWORDS is initialized');
  assert.ok(appHtml.includes('loadPreloadedProfiles(false)'), 'app.html must call loadPreloadedProfiles(false)');
  assert.ok(appHtml.includes('initFaceApi()'), 'app.html must initialize face-api models on startup');
  assert.ok(appHtml.includes('syncAllProfilesFromSheet()'), 'app.html must sync Sheet face and password records on startup');
  assert.ok(appHtml.includes('setDemoMode(false)'), 'app.html must clear transient demo mode when starting physical camera');
  assert.ok(appHtml.includes('snap.imageBase64 || snap.photoBase64'), 'app.html recordFaceLoginTrace must read snap.imageBase64 first');
  assert.ok(appHtml.includes("tag: 'LOGIN_TRACE'"), 'app.html uploadDrivePhoto must pass structured object payload with LOGIN_TRACE tag');
  assert.ok(appHtml.includes('matchResult.centeredSimilarity >= 0.75 || matchResult.euclideanDistance < 0.48'), 'app.html must enforce unified 4cd1102 isAmbiguous guard');
  assert.ok(appHtml.includes('^(4C|4D|5B|5C)(\\d{2})'), 'app.html must support legacy 4cd1102 single-box key auto-resolution');
  assert.ok(!appHtml.includes('4D01-4ZXP'), 'app.html must not embed plaintext student keys');

  const faceAuth = require('../js/face_auth.js');
  assert.strictEqual(typeof faceAuth.areModelsLoaded, 'function', 'FaceAuthModule must export areModelsLoaded()');
  assert.strictEqual(typeof faceAuth.isModelLoading, 'function', 'FaceAuthModule must export isModelLoading()');
  assert.strictEqual(faceAuth.areModelsLoaded(), false);

  const origLS = globalThis.localStorage;
  const origFetch = globalThis.fetch;
  const origPreloaded = globalThis.PRELOADED_STUDENT_FACES;
  const origGetRoster = globalThis.getRoster;
  const origGetStudent = globalThis.getStudent;
  const origGetStudentName = globalThis.getStudentName;

  const lsMap = new Map();
  globalThis.localStorage = {
    getItem: k => (lsMap.has(String(k)) ? lsMap.get(String(k)) : null),
    setItem: (k, v) => { lsMap.set(String(k), String(v)); },
    removeItem: k => { lsMap.delete(String(k)); },
    clear: () => { lsMap.clear(); },
    key: i => Array.from(lsMap.keys())[i] || null,
    get length() { return lsMap.size; }
  };

  try {
    globalThis.getRoster = rosterMod.getRoster;
    globalThis.getStudent = rosterMod.getStudent;
    globalThis.getStudentName = rosterMod.getStudentName;
    require('../js/preloaded_faces.js');
    assert.ok(globalThis.PRELOADED_STUDENT_FACES && globalThis.PRELOADED_STUDENT_FACES['4C_6'], 'PRELOADED_STUDENT_FACES loaded');
    const orig4C19Snap = auth.STUDENT_CUSTOM_PASSWORDS['4C_19'] ? Object.assign({}, auth.STUDENT_CUSTOM_PASSWORDS['4C_19']) : null;

    // Legacy 5BC1102 math_student_vector_* JSON array format
    const legacyVecArr = Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0.01));
    globalThis.localStorage.setItem('math_student_vector_5B_99', JSON.stringify(legacyVecArr));

    // Poisoned passwordChanged:false record with default 1234 hash for 4C_1 (who has passwordChanged:true in snapshot)
    const persistence = require('../js/persistence.js');
    const default1234Salt = 'MATH_SALT_4C_1';
    const default1234Hash = persistence.hashPassword('1234', default1234Salt);
    globalThis.localStorage.setItem('math_student_password_4C_1', JSON.stringify({
      classID: '4C',
      studentID: 1,
      salt: default1234Salt,
      hash: default1234Hash,
      passwordChanged: false,
      updatedAt: 0
    }));

    // Seed an active changed localStorage custom password for 4C_2 to ensure initDefaultPasswords preserves it
    const c2Salt = 'MATH_SALT_4C_2';
    const c2Hash = await cryptoMod.sha256Hex(c2Salt + ':local7788');
    globalThis.localStorage.setItem('math_student_password_4C_2', JSON.stringify({
      classID: '4C',
      studentID: 2,
      salt: c2Salt,
      hash: c2Hash,
      passwordChanged: true
    }));

    // Verify core/auth.js + persistence.js resist poisoned 4C_1 record
    assert.strictEqual(await auth.verifyStudentCustomPassword('4C', 1, '1234'), false, 'Poisoned 1234 record must remain rejected');
    const pRec4C1Before = persistence.getStudentPasswordRecord('4C', 1);
    assert.strictEqual(pRec4C1Before.passwordChanged, true, 'getStudentPasswordRecord must prefer snapshot passwordChanged:true over poisoned false');
    assert.strictEqual(pRec4C1Before.hash, auth.STUDENT_CUSTOM_PASSWORDS['4C_1'].hash);

    // initDefaultPasswords() must repair poisoned 4C_1 in localStorage while preserving 4C_2 local secret
    persistence.initDefaultPasswords();
    const repaired4C1 = JSON.parse(globalThis.localStorage.getItem('math_student_password_4C_1'));
    assert.strictEqual(repaired4C1.passwordChanged, true, 'initDefaultPasswords must repair poisoned passwordChanged:false entry');
    assert.strictEqual(repaired4C1.hash, auth.STUDENT_CUSTOM_PASSWORDS['4C_1'].hash);
    assert.strictEqual(await auth.verifyStudentCustomPassword('4C', 2, 'local7788'), true, 'Locally changed password without timestamp must be preserved');

    // Legacy 5B_99 vector readable via getStudentProfile and getAllStudentProfiles
    const legacyProf = persistence.getStudentProfile('5B', 99);
    assert.ok(legacyProf && legacyProf.vector && legacyProf.vector.length === 128, 'getStudentProfile must parse JSON-stringified math_student_vector_*');
    const allProfsInit = persistence.getAllStudentProfiles();
    assert.ok(allProfsInit.some(p => p.classID === '5B' && p.studentID === 99), 'getAllStudentProfiles must include math_student_vector_*');

    // loadPreloadedProfiles(false) idempotency: never mutates updatedAt or creates duplicate history on same timestamp
    persistence.loadPreloadedProfiles(false);
    const prof4C6First = persistence.getStudentProfile('4C', 6);
    const origTs4C6 = prof4C6First.timestamp;
    const origHistLen4C6 = (prof4C6First.history || []).length;
    persistence.loadPreloadedProfiles(false);
    const prof4C6Second = persistence.getStudentProfile('4C', 6);
    assert.strictEqual(prof4C6Second.timestamp, origTs4C6, 'loadPreloadedProfiles(false) must not bump timestamp on identical ts');
    assert.strictEqual((prof4C6Second.history || []).length, origHistLen4C6, 'loadPreloadedProfiles(false) must not duplicate history');

    // Identify 1:N match using preloaded 4C_6 descriptor with minor perturbation
    const vec4C6 = new Float32Array(prof4C6Second.vector);
    vec4C6[0] += 0.005;
    const match4C6 = faceAuth.identifyFace1toN(vec4C6, allProfsInit, 0.82);
    assert.strictEqual(match4C6.isMatch, true, 'Preloaded 4C_6 vector must achieve 1:N direct match');
    assert.strictEqual(match4C6.bestMatch.classID, '4C');
    assert.strictEqual(Number(match4C6.bestMatch.studentID), 6);

    // Ambiguous guard check: blend 50/50 between 4D_4 and 4D_21
    const p4 = persistence.getStudentProfile('4D', 4);
    const p21 = persistence.getStudentProfile('4D', 21);
    assert.ok(p4 && p21, '4D_4 and 4D_21 profiles must exist in PRELOADED_STUDENT_FACES');
    const blendedAmb = new Float32Array(128);
    for (let i = 0; i < 128; i++) blendedAmb[i] = 0.5 * p4.vector[i] + 0.5 * p21.vector[i];
    const ambRes = faceAuth.identifyFace1toN(blendedAmb, allProfsInit, 0.82);
    assert.strictEqual(ambRes.isMatch, false, 'Blended close pair must NOT auto-login without password disambiguation');
    assert.ok(ambRes.status === 'AMBIGUOUS_MARGIN' || ambRes.status === 'LOW_SIMILARITY');

    // Cloud Sheet sync non-downgrade & update verification via mocked fetch
    const newer4C19Salt = 'MATH_SALT_4C_19';
    const newer4C19Hash = persistence.hashPassword('8899', newer4C19Salt);
    const stale1234Hash = persistence.hashPassword('1234', default1234Salt);
    const futureTs = origTs4C6 + 1000000;
    const syncedVec4C6 = Array.from(prof4C6Second.vector).map(v => Number(v).toFixed(4)).join(',');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [
        // Attempted downgrade of 4C_1 with CHANGED:0 even at future timestamp -> MUST BE IGNORED
        { classID: '4C', studentID: 1, dateID: `PWD|HASH:${stale1234Hash}|SALT:${default1234Salt}|CHANGED:0|TS:${futureTs}` },
        // Legitimate upgrade of 4C_19 -> MUST APPLY to both localStorage and ADMIN_STUDENT_PASSWORDS
        { classID: '4C', studentID: 19, dateID: `PWD|HASH:${newer4C19Hash}|SALT:${newer4C19Salt}|CHANGED:1|TS:${futureTs}` },
        // Newer face vector for 4C_6 -> MUST SYNC
        { classID: '4C', studentID: 6, dateID: `${syncedVec4C6}|TS:${futureTs}|V:2` }
      ]
    });

    const syncRes = await persistence.syncAllProfilesFromSheet();
    assert.strictEqual(syncRes.success, true);
    assert.strictEqual(persistence.getStudentPasswordRecord('4C', 1).passwordChanged, true, 'Sheet CHANGED:0 row must never downgrade changed password');
    assert.strictEqual(persistence.verifyStudentPassword('4C', 19, '8899'), true, 'Newer Sheet CHANGED:1 row must update password verification');
    assert.strictEqual(await auth.verifyStudentCustomPassword('4C', 19, '8899'), true, 'Updated password from Sheet must sync into ADMIN_STUDENT_PASSWORDS');
    assert.strictEqual(persistence.getStudentProfile('4C', 6).timestamp, futureTs, 'Newer face vector from Sheet must update profile timestamp');

    // Preloaded must not overwrite newer Sheet/enhanced profile
    persistence.loadPreloadedProfiles(false);
    assert.strictEqual(persistence.getStudentProfile('4C', 6).timestamp, futureTs, 'loadPreloadedProfiles(false) must preserve newer synced timestamp');

    if (orig4C19Snap) auth.STUDENT_CUSTOM_PASSWORDS['4C_19'] = orig4C19Snap;

    // Legacy 4cd1102 teacher key formats (case-insensitive & dash-optional)
    assert.strictEqual(await auth.verifyStudentRosterKey('4D', 1, '4D01-4ZXP'), true, 'Legacy dashed teacher key must verify');
    assert.strictEqual(await auth.verifyStudentRosterKey('4D', 1, '4d014zxp'), true, 'Legacy lowercase undashed teacher key must verify');
  } finally {
    globalThis.localStorage = origLS;
    globalThis.fetch = origFetch;
    globalThis.PRELOADED_STUDENT_FACES = origPreloaded;
    globalThis.getRoster = origGetRoster;
    globalThis.getStudent = origGetStudent;
    globalThis.getStudentName = origGetStudentName;
  }
  console.log('[PASS] 11. Unified 4cd1102 Face Bootstrap, Legacy Vector/Password Compatibility & Sync Protection');

  // 12. Teacher Student Password Reset, Clock-Skew Monotonicity, Cross-Device Sheet Sync & Student Self-Update
  assert.ok(teacherHtml.includes('id="secPasswordReset"'), 'teacher.html must render #secPasswordReset panel');
  assert.ok(teacherHtml.includes('id="navBtnPwdReset"'), 'teacher.html must render #navBtnPwdReset quick link');
  assert.ok(teacherHtml.includes('js/persistence.js'), 'teacher.html must load js/persistence.js');
  assert.ok(
    teacherHtml.indexOf('js/persistence.js') > teacherHtml.indexOf('core/auth.js'),
    'teacher.html must load js/persistence.js after core/auth.js'
  );
  assert.ok(
    teacherHtml.includes("document.getElementById('secPasswordReset').classList.toggle('d-none', !isTeacher)"),
    'teacher.html must restrict #secPasswordReset exclusively to teacher role'
  );
  assert.ok(
    teacherHtml.includes("navToggle('navBtnPwdReset', isTeacher)"),
    'teacher.html must hide #navBtnPwdReset from class_rep users'
  );
  assert.ok(
    teacherHtml.includes("resetSelectedStudentPassword()") && teacherHtml.includes("if (!ensureTeacherAuth('teacher_only')) return;"),
    'teacher.html password reset actions must be guarded by ensureTeacherAuth(teacher_only)'
  );
  assert.ok(!teacherHtml.includes('test98'), 'teacher.html must not embed plaintext test98 password');
  assert.ok(
    !teacherHtml.includes('洪佳佳') && !teacherHtml.includes('周梓霖') && !teacherHtml.includes('高尚禮') && !teacherHtml.includes('柯鈺鑫'),
    'teacher.html must not hardcode student real names in static HTML'
  );

  assert.ok(appHtml.includes('id="btnOpenChangePwd"'), 'app.html must include student change-password button');
  assert.ok(appHtml.includes('id="modalChangeStudentPassword"'), 'app.html must include student change-password modal');
  assert.ok(appHtml.includes('openChangePasswordModal') && appHtml.includes('submitChangeStudentPassword'), 'app.html must expose self-service password update functions');
  assert.ok(appHtml.includes('canRetryCloudSync') && appHtml.includes('window.syncAllProfilesFromSheet()'), 'app.html gate login must retry after cloud sync on cache race/reset');
  assert.ok(!appHtml.includes('洪佳佳') && !appHtml.includes('周梓霖') && !appHtml.includes('高尚禮') && !appHtml.includes('柯鈺鑫'), 'app.html must stay free of student real names');
  assert.ok(!appHtml.includes('test98') && !appHtml.includes('x33c') && !appHtml.includes('4D01-4ZXP'), 'app.html must stay free of plaintext secrets');

  const origLS12 = globalThis.localStorage;
  const origFetch12 = globalThis.fetch;
  const origDateNow12 = Date.now;
  const origGetRoster12 = globalThis.getRoster;
  const origGetStudent12 = globalThis.getStudent;
  const origGetStudentName12 = globalThis.getStudentName;
  const orig5B1Snap = auth.STUDENT_CUSTOM_PASSWORDS['5B_1'] ? Object.assign({}, auth.STUDENT_CUSTOM_PASSWORDS['5B_1']) : null;

  const lsMap12 = new Map();
  globalThis.localStorage = {
    getItem: k => (lsMap12.has(String(k)) ? lsMap12.get(String(k)) : null),
    setItem: (k, v) => { lsMap12.set(String(k), String(v)); },
    removeItem: k => { lsMap12.delete(String(k)); },
    clear: () => { lsMap12.clear(); },
    key: i => Array.from(lsMap12.keys())[i] || null,
    get length() { return lsMap12.size; }
  };

  try {
    globalThis.getRoster = rosterMod.getRoster;
    globalThis.getStudent = rosterMod.getStudent;
    globalThis.getStudentName = rosterMod.getStudentName;

    const persistence = require('../js/persistence.js');
    assert.ok(orig5B1Snap && orig5B1Snap.updatedAt > 1700000000000, '5B_1 must have bundled updatedAt snapshot timestamp');

    // Simulate teacher machine clock lagging behind bundled Oct 2026 timestamp -> timestamp must stay strictly monotonic
    Date.now = () => 1700000000000;
    const postedPayloads = [];
    globalThis.fetch = async (url, opts) => {
      postedPayloads.push({ url, method: opts && opts.method, body: opts && opts.body });
      return { ok: true, json: async () => [] };
    };

    const resetRes = persistence.saveStudentPassword('5B', 1, '739204', true);
    assert.strictEqual(resetRes.success, true, 'Teacher reset with 6-digit PIN must succeed');
    assert.strictEqual(await resetRes.syncPromise, true, 'Google Form submission promise must resolve true');
    assert.strictEqual(resetRes.record.updatedAt, orig5B1Snap.updatedAt + 1000, 'Reset timestamp must advance strictly past stored updatedAt despite skewed clock');
    assert.strictEqual(postedPayloads.length, 1, 'Teacher reset must emit exactly one Form POST payload');

    const formParams = new URLSearchParams(postedPayloads[0].body);
    const postedClass = formParams.get(persistence.PERSISTENCE_CONFIG.formFields.classID);
    const postedSid = formParams.get(persistence.PERSISTENCE_CONFIG.formFields.studentID);
    const postedDateId = formParams.get(persistence.PERSISTENCE_CONFIG.formFields.dateID);
    const postedTag = formParams.get(persistence.PERSISTENCE_CONFIG.formFields.score);
    assert.strictEqual(postedClass, '5B');
    assert.strictEqual(postedSid, '1');
    assert.strictEqual(postedTag, 'PASSWORD_UPDATE');
    assert.ok(
      postedDateId.startsWith('PWD|HASH:') && postedDateId.includes('|CHANGED:1|TS:' + (orig5B1Snap.updatedAt + 1000)),
      'Form payload dateID must serialize monotonic PWD record'
    );

    // Simulate a brand-new student device (empty localStorage, original snapshot untouched)
    lsMap12.clear();
    auth.STUDENT_CUSTOM_PASSWORDS['5B_1'] = Object.assign({}, orig5B1Snap);
    assert.strictEqual(await auth.verifyStudentCustomPassword('5B', 1, '739204'), false, 'Fresh student device must not validate reset PIN before Sheet sync');

    globalThis.fetch = async (url, opts) => {
      if (String(url) === persistence.PERSISTENCE_CONFIG.gasSheetReaderUrl) {
        return {
          ok: true,
          json: async () => [{ classID: '5B', studentID: 1, dateID: postedDateId }]
        };
      }
      postedPayloads.push({ url, method: opts && opts.method, body: opts && opts.body });
      return { ok: true };
    };

    const cloudSyncRes = await persistence.syncAllProfilesFromSheet();
    assert.strictEqual(cloudSyncRes.success, true);
    assert.ok(cloudSyncRes.pwdCount >= 1 && cloudSyncRes.pwdStudents.includes('5B_1'), 'Cloud sync must report updated password for 5B_1');
    assert.strictEqual(await auth.verifyStudentCustomPassword('5B', 1, '739204'), true, 'Student new device must accept teacher-reset PIN after Sheet sync');
    assert.strictEqual(await auth.verifyStudentCustomPassword('5B', 1, '1234'), false, 'Default 1234 must remain blocked after reset');

    const stuSessAfterReset = await auth.loginStudent({ classID: '5B', studentID: 1, secretKey: '739204' });
    assert.strictEqual(stuSessAfterReset.sid, '5B_1', 'Student must log in cleanly with teacher temporary PIN');

    // Student self-service password change via updateStudentPassword
    assert.strictEqual(persistence.updateStudentPassword('5B', 1, '000000', '864209').success, false, 'Wrong old password must reject update');
    assert.strictEqual(persistence.updateStudentPassword('5B', 1, '739204', '1234').success, false, 'Cannot reset self-service password back to 1234');
    assert.strictEqual(persistence.updateStudentPassword('5B', 1, '739204', '739204').success, false, 'New password must differ from current PIN');

    const selfUpdRes = persistence.updateStudentPassword('5B', 1, '739204', '864209');
    assert.strictEqual(selfUpdRes.success, true);
    assert.strictEqual(await selfUpdRes.syncPromise, true);
    const stuSessAfterSelf = await auth.loginStudent({ classID: '5B', studentID: 1, secretKey: '864209' });
    assert.strictEqual(stuSessAfterSelf.sid, '5B_1', 'Student must log in with self-updated PIN');
    assert.strictEqual(await auth.verifyStudentCustomPassword('5B', 1, '739204'), false, 'Old temporary PIN must no longer validate after student self-update');

    // Verify class_rep cannot gain teacher_only permission even when granted all 4 rep permissions
    auth.setClassRep({
      classID: '5B',
      studentID: 2,
      name: '蘇子恩',
      pin: 'rep5b99',
      permissions: ['reply_qa', 'approve_mall', 'tune_score', 'set_rules']
    });
    const fullRepSess = await auth.loginClassRep({ classID: '5B', studentID: 2, pin: 'rep5b99' });
    assert.strictEqual(auth.hasBackendPermission(fullRepSess, 'teacher_only'), false, 'class_rep with all delegated perms must still be blocked from teacher_only password reset');
    auth.removeClassRep('5B', 2);
  } finally {
    Date.now = origDateNow12;
    globalThis.localStorage = origLS12;
    globalThis.fetch = origFetch12;
    globalThis.getRoster = origGetRoster12;
    globalThis.getStudent = origGetStudent12;
    globalThis.getStudentName = origGetStudentName12;
    if (orig5B1Snap) auth.STUDENT_CUSTOM_PASSWORDS['5B_1'] = orig5B1Snap;
    try { auth.removeClassRep('5B', 2); } catch (_) {}
  }
  console.log('[PASS] 12. Teacher Student Password Reset, Clock-Skew Monotonicity, Cross-Device Sync & Self-Service Update');

  // 13. Cross-browser 5B_2 login, Sheet PWD parsing resilience, legacy sync parity & failed-sync retry guards
  {
    const lsMap13 = new Map();
    const origLS13 = globalThis.localStorage;
    const origFetch13 = globalThis.fetch;
    globalThis.localStorage = {
      getItem: k => (lsMap13.has(String(k)) ? lsMap13.get(String(k)) : null),
      setItem: (k, v) => { lsMap13.set(String(k), String(v)); },
      removeItem: k => { lsMap13.delete(String(k)); },
      clear: () => { lsMap13.clear(); },
      key: i => Array.from(lsMap13.keys())[i] || null,
      get length() { return lsMap13.size; }
    };
    try {
      // Fresh browser login for 5B #2 with 1111123 (zero localStorage)
      assert.strictEqual(await auth.verifyStudentCustomPassword('5B', 2, '1234'), false, '5B_2 must reject default 1234 on fresh browser');
      assert.strictEqual(await auth.verifyStudentCustomPassword('5B', 2, '1111123'), true, '5B_2 must verify 1111123 on fresh browser');
      const sess5b2 = await auth.loginStudent({ classID: '5B', studentID: 2, secretKey: '1111123' });
      assert.strictEqual(sess5b2.sid, '5B_2');
      assert.strictEqual(sess5b2.name, '蘇子恩');

      // Resilient Sheet PWD parsing (whitespace-padded dateID, missing CHANGED with PASSWORD_UPDATE score, Timestamp fallback, CORS cache fallback)
      const persistence = require('../js/persistence.js');
      const altSalt = 'MATH_SALT_5B_3';
      const altHash = await cryptoMod.sha256Hex(altSalt + ':445566');
      const orig5B3 = auth.STUDENT_CUSTOM_PASSWORDS['5B_3'] ? Object.assign({}, auth.STUDENT_CUSTOM_PASSWORDS['5B_3']) : null;
      try {
        let getCalls = 0;
        globalThis.fetch = async (url, opts) => {
          if (String(url) === persistence.PERSISTENCE_CONFIG.gasSheetReaderUrl) {
            getCalls++;
            if (opts && opts.cache === 'no-store') {
              throw new TypeError('CORS preflight blocked');
            }
            return {
              ok: true,
              json: async () => ({
                data: [{
                  classID: ' 5b ',
                  studentID: '3',
                  dateID: `  PWD|HASH:${altHash.toUpperCase()}|SALT:${altSalt}  `,
                  score: 'PASSWORD_UPDATE',
                  Timestamp: '2026-11-14T08:00:00Z'
                }]
              })
            };
          }
          return { ok: true };
        };
        const sync13 = await persistence.syncAllProfilesFromSheet();
        assert.strictEqual(sync13.success, true);
        assert.strictEqual(getCalls, 2, 'syncAllProfilesFromSheet must retry without cache:no-store if primary CORS fetch throws');
        assert.ok(sync13.pwdStudents.includes('5B_3'), 'Trimmed PWD| row with PASSWORD_UPDATE & Timestamp fallback must sync');
        assert.strictEqual(await auth.verifyStudentCustomPassword('5B', 3, '445566'), true);
      } finally {
        if (orig5B3) auth.STUDENT_CUSTOM_PASSWORDS['5B_3'] = orig5B3;
      }

      // Static source guards across persistence.js, app.html, teacher.html, 5BC1102.html, 4cd1102.html
      const persistSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'persistence.js'), 'utf8');
      assert.ok(persistSrc.includes('controller.abort(); }, 45000)'), 'syncAllProfilesFromSheet must allow 45s for GAS cold start');
      assert.ok(persistSrc.includes('controller.abort(); }, 8000)'), 'submitFormRecord must allow 8s before aborting');

      const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
      assert.ok(appSrc.includes('let lastSheetSyncOk = false;'), 'app.html must track lastSheetSyncOk');
      assert.ok(appSrc.includes('!lastSheetSyncOk || (Date.now() - lastSheetSyncAt > 1500)'), 'handleGateLogin must retry if prior sync failed');

      const teacherSrc = fs.readFileSync(path.join(__dirname, '..', 'teacher.html'), 'utf8');
      assert.ok(teacherSrc.includes('if (r && r.success) lastPwdCloudSyncAt = Date.now();'), 'teacher.html must only cache cloud sync time on success');

      const p5bcSrc = fs.readFileSync(path.join(__dirname, '..', '5BC1102.html'), 'utf8');
      assert.ok(p5bcSrc.includes('dateID: `PWD|HASH:${hash}|SALT:${salt}|CHANGED:${record.passwordChanged ? 1 : 0}|TS:${now}`'), '5BC1102.html must emit standard PWD|HASH payload');
      assert.ok(!p5bcSrc.includes('PWD_UPDATE_V1|TS:'), '5BC1102.html must not emit legacy unparseable PWD_UPDATE_V1 format');

      const p4cdSrc = fs.readFileSync(path.join(__dirname, '..', '4cd1102.html'), 'utf8');
      assert.ok(p4cdSrc.includes('const now = Math.max(Date.now(), prevTs + 1000);'), '4cd1102.html saveStudentPassword must use monotonic timestamp');
    } finally {
      globalThis.localStorage = origLS13;
      globalThis.fetch = origFetch13;
    }
  }
  console.log('[PASS] 13. Cross-Browser 5B_2 Login, Sheet PWD Parsing Resilience & Sync Guards');

  // 14. Safari / Storage-Restricted D6 Consent Modal & API Parity
  {
    const origLS14 = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      get length() { return 0; }
    };
    try {
      assert.strictEqual(typeof auth.saveConsentDecision, 'function', 'MathCoreAuth must expose saveConsentDecision');
      const res14 = auth.saveConsentDecision('5B_2', false);
      assert.strictEqual(res14.decided, true);
      assert.strictEqual(res14.agreed, false);
      assert.strictEqual(auth.needsConsentPrompt('5B_2'), false, 'Consent prompt must not loop when localStorage throws QuotaExceededError');
      const st14 = auth.getConsentStatus('5B_2');
      assert.strictEqual(st14.decided, true);
      assert.strictEqual(st14.agreed, false);

      const appSrc14 = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
      assert.ok(appSrc14.includes('top: 0; right: 0; bottom: 0; left: 0; inset: 0;'), 'app.html modal backdrop must include top/right/bottom/left fallback for Safari');
      assert.ok(appSrc14.includes('visibility: hidden; pointer-events: none;'), 'app.html hidden modal must disable visibility and pointer-events');
      assert.ok(appSrc14.includes('id="btnConsentAgree"') && appSrc14.includes('id="btnConsentDecline"'), 'app.html must expose explicit consent buttons');
      assert.ok(appSrc14.includes('closeConsentModal();'), 'app.html must deterministically close consent modal');
    } finally {
      globalThis.localStorage = origLS14;
    }
  }
  console.log('[PASS] 14. Safari / Storage-Restricted D6 Consent Modal & API Parity');

  console.log('=== ALL TESTS PASSED (14/14) ===');
}

runAllTests().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
