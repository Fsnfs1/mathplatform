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

  console.log('=== ALL TESTS PASSED (11/11) ===');
}

runAllTests().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
