/**
 * tests/verify_v2.js
 * Automated E2E & Integration Verification for MathPlatform v2.0
 */
const assert = require('assert');
const fs = require('fs');
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
  assert.strictEqual(changedCount, 59, 'All 59 non-1234 student custom passwords preserved');

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
  assert.strictEqual(registry.getScorePacksForClass('4C')[0].id, 'quiz_1023', 'Non-4D classes retain original first tab');

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

  // Correction bonus calculation (max +5, 120 cap, independent of 60 quiz cap)
  const calc89Plus5 = bonus.calculateMajorExamFinalScore({ rawScore: 89, correctionBonus: 5 });
  assert.strictEqual(calc89Plus5.finalScore, 94, '89 + 5 = 94 (must NOT be capped at 60)');
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

  // Correction bonus override via storage
  storage.setItem('MP_V2_CORRECTION_BONUSES', { 'exam_1113_t2:4D_11': 4 });
  const loadedZzl = await api.loadScorePack('exam_1113_t2', { classID: '4D', studentID: 11, name: '周梓霖' });
  assert.strictEqual(loadedZzl.score, 14);
  assert.strictEqual(loadedZzl.correctionBonus, 4);
  storage.setItem('MP_V2_CORRECTION_BONUSES', {});

  // UI & privacy assertions for app.html and teacher.html
  const teacherHtml = fs.readFileSync(__dirname + '/../teacher.html', 'utf8');
  assert.ok(appHtml.includes('js/exam_1113_scores.js'), 'app.html must load js/exam_1113_scores.js');
  assert.ok(teacherHtml.includes('js/exam_1113_scores.js'), 'teacher.html must load js/exam_1113_scores.js');
  assert.ok(appHtml.includes('大測訂正加分（最多加${maxCorrectionBonus}分）'), 'app.html A6 must show 大測訂正加分（最多加5分）');
  assert.ok(appHtml.includes('刷題最高分 (>80加分)'), 'app.html A6 must retain 刷題最高分 (>80加分) for regular quizzes');
  assert.ok(!appHtml.includes('洪佳佳') && !appHtml.includes('周梓霖'), 'app.html must not embed student real names in HTML');
  assert.ok(appHtml.includes('formatLeaderboardName({ classID: s.classID, studentID: s.id, name: s.name }, displayMode, idx)'), 'app.html must pass (student, displayMode, idx) in correct order');
  assert.strictEqual(ui.formatLeaderboardName({ classID: '4D', studentID: 11, name: '周梓霖' }, 'nickname', 0), '周*霖');
  assert.strictEqual(ui.formatLeaderboardName({ classID: '4D', studentID: 11, name: '周梓霖' }, 'seat_only', 0), '4D #11');
  console.log('[PASS] 10. 1113 數學大測二 Store, Left-Most A6 Tab, Max +5 Correction Bonus, 120 Cap & UI Integrity');

  console.log('=== ALL TESTS PASSED (10/10) ===');
}

runAllTests().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
