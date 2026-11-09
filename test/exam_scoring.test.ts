import assert from 'assert';
import { ExamScoringService } from '../src/services/exam_scoring.service';

console.log('Running ExamScoringService Anti-Cheat and Evaluation Tests...');

// 1. Anti-Cheat: Speed detection
assert.strictEqual(
  ExamScoringService.isSubmissionSuspiciouslyFast(1, 20),
  true,
  '1s for 20 questions must be flagged as suspicious speed'
);
assert.strictEqual(
  ExamScoringService.isSubmissionSuspiciouslyFast(30, 20),
  false,
  '30s for 20 questions is above minimum threshold'
);

// 2. Evaluation & Negative Marking
const mockQuestions = [
  {
    id: 'q1',
    options: [
      { key_original: 'A', text: 'Option A', is_correct: true },
      { key_original: 'B', text: 'Option B', is_correct: false },
    ],
    stem_primary: 'Question 1',
    solution_markdown: 'Explanation 1',
  },
  {
    id: 'q2',
    options: [
      { key_original: 'A', text: 'Option A', is_correct: false },
      { key_original: 'B', text: 'Option B', is_correct: true },
    ],
    stem_primary: 'Question 2',
    solution_markdown: 'Explanation 2',
  },
];

const evalResult = ExamScoringService.evaluateSubmission({
  questions: mockQuestions,
  answers: { q1: 'A', q2: 'A' }, // 1 correct (q1), 1 wrong (q2)
  totalMarks: 10,
  negativeMarkPerQuestion: 0.5,
  timeTakenSeconds: 45,
});

assert.strictEqual(evalResult.correctCount, 1);
assert.strictEqual(evalResult.wrongCount, 1);
assert.strictEqual(evalResult.unansweredCount, 0);
// 1 correct * 5 marks - 1 wrong * 0.5 = 4.5
assert.strictEqual(evalResult.score, 4.5);
assert.strictEqual(evalResult.isSuspiciousSpeed, false);
assert.strictEqual(evalResult.feedback.length, 2);

console.log('✓ All ExamScoringService unit tests passed successfully!');
