import { z } from 'zod';

export const QuestionOptionSchema = z.object({
  id: z.string().describe('Option unique identifier (e.g. A, B, C, D)'),
  text: z.string().describe('Option textual or latex content'),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

export const QuestionSchema = z.object({
  id: z.string().uuid().describe('Universal question identifier'),
  questionText: z.string().describe('Primary question stem in Markdown/LaTeX'),
  hasMath: z.boolean().default(false).describe('Whether question contains math symbols or equations'),
  options: z.array(QuestionOptionSchema).min(2).max(6).describe('List of selectable options'),
  difficultyRating: z.number().min(0.5).max(5.0).default(1.0).describe('Calibrated difficulty rating'),
});
export type Question = z.infer<typeof QuestionSchema>;

export const AdmissionSectionSchema = z.object({
  name: z.string().describe('Faculty section name (e.g. Higher Mathematics)'),
  marks: z.number().int().positive().describe('Marks allocated to this section'),
  weight: z.number().min(0).max(100).describe('Contribution percentage towards overall summit'),
  topics: z.array(z.string()).default([]).describe('Covered syllabus chapters and topics'),
});
export type AdmissionSection = z.infer<typeof AdmissionSectionSchema>;

export const AdmissionPatternSchema = z.object({
  id: z.string().uuid().describe('Pattern identifier'),
  universityId: z.string().uuid().describe('Associated university UUID'),
  universityCode: z.string().describe('University short code (e.g. BRACU)'),
  slug: z.string().describe('Track slug (e.g. eng, bba, arch)'),
  patternName: z.string().describe('Official admission test title'),
  totalMarks: z.number().positive().describe('Total aggregate marks'),
  durationMinutes: z.number().int().positive().describe('Duration in minutes'),
  hasNegativeMarking: z.boolean().default(true).describe('Whether penalty applies to wrong answers'),
  negativeMarkingPenalty: z.number().default(0.25).describe('Penalty per wrong answer'),
  sections: z.array(AdmissionSectionSchema).describe('Section blueprints'),
});
export type AdmissionPattern = z.infer<typeof AdmissionPatternSchema>;

export const ExamSubmissionRequestSchema = z.object({
  examId: z.string().uuid().describe('Exam ID being submitted'),
  sessionId: z.string().uuid().optional().describe('Candidate session identifier'),
  answers: z.record(z.string()).describe('Map of questionId to selectedOptionId'),
  timeSpentSeconds: z.number().int().min(0).describe('Total time spent on exam'),
});
export type ExamSubmissionRequest = z.infer<typeof ExamSubmissionRequestSchema>;

export const ExamScoringResponseSchema = z.object({
  success: z.boolean(),
  submissionId: z.string().uuid().describe('Submission receipt UUID'),
  score: z.number().describe('Calculated total score with penalties applied'),
  correctCount: z.number().int().min(0).describe('Count of correctly answered questions'),
  wrongCount: z.number().int().min(0).describe('Count of incorrect answers'),
  unansweredCount: z.number().int().min(0).describe('Count of skipped questions'),
  accuracyPercent: z.number().min(0).max(100).describe('Accuracy percentage'),
  rank: z.number().int().optional().describe('Provisional merit rank'),
  percentile: z.number().min(0).max(100).optional().describe('National percentile standing'),
});
export type ExamScoringResponse = z.infer<typeof ExamScoringResponseSchema>;

export const UserProfileSyncSchema = z.object({
  id: z.string().describe('User ID matching Supabase Auth UID'),
  fullName: z.string().min(1).describe('Student full legal name'),
  email: z.string().email().describe('Primary email address'),
  phone: z.string().optional().describe('Contact phone number'),
  academicBatch: z.string().describe('HSC/A-Level batch (e.g. HSC 25)'),
  targetUniversities: z.array(z.string()).describe('Selected target university codes'),
  studyHorizonDays: z.number().int().positive().default(30).describe('Selected preparation timeline'),
});
export type UserProfileSync = z.infer<typeof UserProfileSyncSchema>;
