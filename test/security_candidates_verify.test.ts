import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { sanitizeOptions } from '../src/db/export_offline_cache';
import { sanitizeExamSnapshot } from '../src/routes/public_exam.routes';

console.log('=== RUNNING SECURITY CANDIDATES & REMEDIATION TESTS ===');

// -------------------------------------------------------------
// Test 1: Offline Bundle Cache Sanitization (fp-offline-bundle-solution-key-leakage)
// -------------------------------------------------------------
console.log('1. Testing Offline Bundle Options Sanitization...');
const rawMockOptions = [
  { key_original: 'A', text: 'Velocity is constant', is_correct: true, explanation: 'secret' },
  { key_original: 'B', text: 'Acceleration is zero', is_correct: false, isCorrect: false },
  { key_original: 'C', text: 'Mass is infinite', isCorrect: false }
];

const sanitized = sanitizeOptions(rawMockOptions);
assert.strictEqual(sanitized.length, 3);
for (const opt of sanitized) {
  assert.strictEqual((opt as any).is_correct, undefined, 'is_correct must be stripped');
  assert.strictEqual((opt as any).isCorrect, undefined, 'isCorrect must be stripped');
  assert.ok(opt.id, 'Option id must exist');
  assert.ok(opt.text, 'Option text must exist');
}
assert.strictEqual(sanitized[0].id, 'A');
assert.strictEqual(sanitized[0].text, 'Velocity is constant');
console.log('   ✓ Offline cache sanitizeOptions successfully stripped all answer flags');

// -------------------------------------------------------------
// Test 2: Admin Candidate Exam Portal XSS Hardening (fp-portal-exam-innerhtml-stored-xss)
// -------------------------------------------------------------
console.log('2. Testing Candidate Exam HTML XSS Hardening...');
const htmlPath = path.resolve(__dirname, '../../admin/candidate_exam.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

assert.ok(htmlContent.includes('dompurify'), 'DOMPurify script must be loaded in candidate_exam.html');
assert.ok(htmlContent.includes('DOMPurify.sanitize'), 'DOMPurify.sanitize must be called in renderKaTeX');
assert.ok(htmlContent.includes('escapeHtml'), 'escapeHtml helper must exist for attribute values and fallback');
assert.ok(!htmlContent.includes("onchange=\"selectOption('${q.id}'"), 'Vulnerable inline onchange string interpolation must be removed');
assert.ok(htmlContent.includes('data-qid='), 'Option radio inputs must use safe data-qid attributes');
console.log('   ✓ Candidate Exam portal has DOMPurify sanitization and safe event delegation');

// -------------------------------------------------------------
// Test 3: Realtime Battle Gateway Duel Timer & Auth Invariants (fp-realtime-round-clock-expired-submission-steal)
// -------------------------------------------------------------
console.log('3. Testing RealBattleGateway Round Expiration Invariants...');
const gatewayPath = path.resolve(__dirname, '../src/battle/real_battle.gateway.ts');
const gatewayContent = fs.readFileSync(gatewayPath, 'utf8');

assert.ok(
  gatewayContent.includes('if (room.timeRemainingSeconds <= 0 || !room.roundTimer) return;'),
  'SUBMIT_ANSWER must reject submissions when timeRemainingSeconds <= 0 or roundTimer is cleared'
);
assert.ok(
  gatewayContent.includes('room.player1.hasAnswered = true;\n    room.player2.hasAnswered = true;'),
  'concludeRound must unconditionally mark both players as answered before publishing results'
);
assert.ok(
  gatewayContent.includes('const authTimeout = setTimeout('),
  'handleConnection must register an authentication handshake timeout'
);
assert.ok(
  gatewayContent.includes('clearTimeout(authTimeout)'),
  'authTimeout must be cleared upon authentication or connection close'
);
console.log('   ✓ RealBattleGateway prevents expired round answer steals and enforces auth timeout');

// -------------------------------------------------------------
// Test 4: Question Snapshot Allowlist Sanitization (sanitize-exam-snapshot-blacklist-omission-and-temporal-bypass)
// -------------------------------------------------------------
console.log('4. Testing sanitizeExamSnapshot Explicit Allowlist...');
const leakySnapshot = {
  examId: 'test-exam-123',
  title: 'Physics Model Test',
  secretExamAnswerKey: 'ALL_A',
  correct_option: 'A',
  solution: 'This should never leak',
  solutionMarkdown: 'Detailed solution should never leak',
  questions: [
    {
      id: 'q1',
      order: 1,
      questionText: 'What is momentum?',
      hasMath: false,
      correctOption: 'A',
      correct_option: 'A',
      explanation: 'p = mv',
      solution_markdown: 'p = mv explanation',
      solution: 'secret',
      options: [
        { id: 'A', text: 'Mass * Velocity', is_correct: true, isCorrect: true, secretNotes: 'yes' },
        { id: 'B', text: 'Mass * Acceleration', is_correct: false, isCorrect: false }
      ]
    }
  ]
};

const cleanSnapshot = sanitizeExamSnapshot(leakySnapshot) as any;
assert.strictEqual(cleanSnapshot.secretExamAnswerKey, undefined);
assert.strictEqual(cleanSnapshot.correct_option, undefined);
assert.strictEqual(cleanSnapshot.solution, undefined);
assert.strictEqual(cleanSnapshot.solutionMarkdown, undefined);
assert.strictEqual(cleanSnapshot.questions.length, 1);

const cleanQ = cleanSnapshot.questions[0];
assert.strictEqual(cleanQ.correctOption, undefined);
assert.strictEqual(cleanQ.correct_option, undefined);
assert.strictEqual(cleanQ.explanation, undefined);
assert.strictEqual(cleanQ.solution_markdown, undefined);
assert.strictEqual(cleanQ.solution, undefined);
assert.strictEqual(cleanQ.questionText, 'What is momentum?');
assert.strictEqual(cleanQ.options.length, 2);

const cleanOptA = cleanQ.options[0];
assert.strictEqual(cleanOptA.is_correct, undefined);
assert.strictEqual(cleanOptA.isCorrect, undefined);
assert.strictEqual(cleanOptA.secretNotes, undefined);
assert.strictEqual(cleanOptA.id, 'A');
assert.strictEqual(cleanOptA.text, 'Mass * Velocity');
console.log('   ✓ sanitizeExamSnapshot explicit allowlist verified with zero secret/answer leakage');

// -------------------------------------------------------------
// Test 5: Idempotency Key Scoping & Fail Closed (idempotency-key-unscoped-user-dos)
// -------------------------------------------------------------
console.log('5. Testing Idempotency Key Scoping Invariants...');
// Session and submission handlers live in exam_session.routes.ts since the exam routes were split.
const examRoutesPath = path.resolve(__dirname, '../src/routes/exam_session.routes.ts');
const examRoutesContent = fs.readFileSync(examRoutesPath, 'utf8');
// The idempotency hooks live in a shared service used by both exam plugins.
const idempotencyContent = fs.readFileSync(path.resolve(__dirname, '../src/services/exam_idempotency.service.ts'), 'utf8');

assert.ok(
  idempotencyContent.includes('const callerScope = callerId || (typeof (req.body as any)?.sessionId === \'string\' && (req.body as any).sessionId ? (req.body as any).sessionId : req.ip);'),
  'preHandler must scope idempotency storageKey by caller identity'
);
assert.ok(
  idempotencyContent.includes('`${pathname}:${callerScope}:${rawKey}`'),
  'storageKey hash must include callerScope'
);
assert.ok(
  idempotencyContent.includes('code: \'IDEMPOTENCY_UNAVAILABLE\''),
  'Idempotency claim must fail closed with 503 when Redis connectivity fails'
);
console.log('   ✓ Idempotency keys are user/session-scoped and fail closed on Redis unavailability');

// -------------------------------------------------------------
// Test 6: Server Authoritative Timestamps & Speed Anti-Cheat (client-controlled-time-taken-ranking-manipulation & submit-session-speed-and-overtime-guard-bypass)
// -------------------------------------------------------------
console.log('6. Testing Server Authoritative Session Timestamps & Anti-Cheat...');
assert.ok(
  examRoutesContent.includes('clock_timestamp() - started_at')
    && examRoutesContent.includes('authoritativeTimeTaken = Number(sessionRes.rows[0].elapsed_seconds)'),
  'Authenticated submission routes must require an unused registered session and derive elapsed time from its server start'
);
assert.ok(
  examRoutesContent.includes('ExamScoringService.isSubmissionSuspiciouslyFast(authoritativeTimeTaken, totalQuestions)'),
  'submit-session must pass elapsed seconds and question count in the scoring service parameter order'
);
assert.ok(
  examRoutesContent.includes('if (authoritativeTimeTaken > maxAllowedSeconds)'),
  'submit-session must enforce overtime limit'
);
console.log('   ✓ Authoritative timestamps, speed detection, and overtime guards are enforced');

// -------------------------------------------------------------
// Test 7: Concurrent Submission Unique Index (missing-idempotency-key-concurrent-submission-race)
// -------------------------------------------------------------
console.log('7. Testing Concurrent Ranked Submission Unique Constraint...');
const schemaPath = path.resolve(__dirname, '../src/db/schema.sql');
const schemaContent = fs.readFileSync(schemaPath, 'utf8');

assert.ok(
  schemaContent.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_submissions_user_ranked\n    ON exam_submissions (exam_id, user_id)\n    WHERE is_practice = false;'),
  'Database schema must enforce partial unique index on (exam_id, user_id) WHERE is_practice = false'
);
assert.ok(
  examRoutesContent.includes('err?.code === \'23505\' && !isPracticeMode'),
  'Concurrent submission race conditions must be caught and downgraded to practice attempt'
);
console.log('   ✓ Database partial unique index and race-condition fallback are verified');

console.log('\n=== ALL SECURITY CANDIDATE TESTS PASSED SUCCESSFULLY! ===\n');
