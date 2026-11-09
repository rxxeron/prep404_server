export interface QuestionWithSolution {
  id: string;
  options: any[];
  solution_markdown?: string;
  stem_primary?: string;
}

export interface SubmissionEvaluation {
  score: number;
  rawScore: number;
  correctCount: number;
  wrongCount: number;
  unansweredCount: number;
  accuracy: number;
  feedback: Array<{
    questionId: string;
    questionText?: string;
    selectedOption: string | null;
    correctOption: string;
    isCorrect: boolean;
    explanation?: string;
  }>;
  xpGained: number;
  isSuspiciousSpeed: boolean;
  minAllowedTimeSeconds: number;
}

export class ExamScoringService {
  /**
   * Anti-Cheat speed guard: At least 0.5s per question to prevent bot injection
   */
  static isSubmissionSuspiciouslyFast(timeTakenSeconds: number, totalQuestions: number): boolean {
    const minThreshold = Math.max(3, totalQuestions * 0.5);
    return timeTakenSeconds < minThreshold;
  }

  /**
   * Evaluates candidate answers against canonical question options and produces detailed feedback & score
   */
  static evaluateSubmission(params: {
    questions: QuestionWithSolution[];
    answers: Record<string, string>;
    totalMarks: number;
    negativeMarkPerQuestion?: number;
    timeTakenSeconds: number;
  }): SubmissionEvaluation {
    const { questions, answers, totalMarks, negativeMarkPerQuestion = 0.25, timeTakenSeconds } = params;
    const totalQuestions = questions.length || 1;
    const markPerQ = totalMarks / totalQuestions;

    let correctCount = 0;
    let wrongCount = 0;
    let unansweredCount = 0;
    const feedback: SubmissionEvaluation['feedback'] = [];

    for (const q of questions) {
      const rawOpts = Array.isArray(q.options) ? q.options : [];
      let correctKey = 'A';
      rawOpts.forEach((opt: any, idx: number) => {
        if (opt.is_correct) correctKey = opt.key_original || String.fromCharCode(65 + idx);
      });

      const selected = answers[q.id];
      let isCorrect = false;

      if (!selected) {
        unansweredCount++;
      } else if (selected === correctKey) {
        correctCount++;
        isCorrect = true;
      } else {
        wrongCount++;
      }

      feedback.push({
        questionId: q.id,
        questionText: q.stem_primary,
        selectedOption: selected || null,
        correctOption: correctKey,
        isCorrect,
        explanation: q.solution_markdown,
      });
    }

    const rawScore = correctCount * markPerQ - wrongCount * negativeMarkPerQuestion;
    const score = Math.max(0, parseFloat(rawScore.toFixed(2)));
    const xpGained = Math.max(10, correctCount * 15);
    const accuracy = totalQuestions > 0 ? parseFloat(((correctCount / totalQuestions) * 100).toFixed(1)) : 0;
    const isSuspiciousSpeed = this.isSubmissionSuspiciouslyFast(timeTakenSeconds, totalQuestions);

    return {
      score,
      rawScore,
      correctCount,
      wrongCount,
      unansweredCount,
      accuracy,
      feedback,
      xpGained,
      isSuspiciousSpeed,
      minAllowedTimeSeconds: Math.max(3, totalQuestions * 0.5),
    };
  }
}
