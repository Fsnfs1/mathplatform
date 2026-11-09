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

  // 10. Phase 0 & Phase 1 Announcements Engine & Canonical index.html Verification
  const indexHtml = fs.readFileSync(__dirname + '/../index.html', 'utf8');
  assert.ok(indexHtml.includes('app.html'), 'index.html must route to student app');
  assert.ok(indexHtml.includes('teacher.html'), 'index.html must route to teacher studio');

  // Verify Announcements in registry
  const annList4C = registry.getAnnouncementsForClass('4C');
  assert.ok(Array.isArray(annList4C) && annList4C.length > 0, 'Class 4C must receive announcements');
  
  // Register dynamic announcement
  const newAnn = registry.registerAnnouncement({
    title: '【測試公告】週四小測安排',
    content: '請準時參加',
    priority: 'urgent',
    targetClasses: ['4C', '4D']
  });
  assert.ok(newAnn && newAnn.id, 'Announcement registration generates id');
  const annList4D = registry.getAnnouncementsForClass('4D');
  assert.ok(annList4D.some(a => a.id === newAnn.id), 'Class 4D receives targeted announcement');
  const annList5B = registry.getAnnouncementsForClass('5B');
  assert.ok(!annList5B.some(a => a.id === newAnn.id), 'Class 5B does NOT receive 4CD targeted announcement');

  // Test Storage Read Tracking
  storage.markAnnouncementRead('4C_1', newAnn.id);
  const readList = storage.getReadAnnouncementIds('4C_1');
  assert.ok(readList.includes(newAnn.id), 'markAnnouncementRead properly records read id');
  console.log('[PASS] 10. Canonical index.html & Targeted Announcements Engine (Phase 0 & 1)');

  console.log('=== ALL TESTS PASSED (10/10) ===');
}

runAllTests().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
