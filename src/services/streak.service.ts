import { Pool } from 'pg';

export interface StreakTimelineItem {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  daysCount: number;
  questionsSolved: number;
  examsCompleted: number;
  isActive: boolean;
  usedFreeze: boolean;
}

export interface UserStreakDetails {
  currentStreak: number;
  highestStreak: number;
  lowestStreak: number;
  totalActiveDays: number;
  totalStreakCycles: number;
  streakFreezesAvailable: number;
  streakFreezesUsed: number;
  lastActiveDate: string | null;
  weeklyDaysActive: boolean[]; // 7 elements: Mon (0) to Sun (6)
  timeline: StreakTimelineItem[];
}

export class StreakService {
  constructor(private db: Pool) {}

  /**
   * Record practice or exam activity for a user and calculate streak updates
   */
  async recordActivity(
    userId: string,
    questionsCount: number = 1,
    examsCount: number = 0
  ): Promise<UserStreakDetails> {
    const today = new Date().toISOString().split('T')[0];

    // 1. Upsert daily activity
    await this.db.query(
      `
      INSERT INTO user_daily_activity (user_id, activity_date, questions_solved, exams_completed, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, activity_date)
      DO UPDATE SET
        questions_solved = user_daily_activity.questions_solved + $3,
        exams_completed = user_daily_activity.exams_completed + $4,
        updated_at = NOW()
      `,
      [userId, today, questionsCount, examsCount]
    );

    // 2. Fetch or initialize user streak record
    const streakRes = await this.db.query(
      `SELECT * FROM user_streaks WHERE user_id = $1`,
      [userId]
    );

    let streakRecord = streakRes.rows[0];

    if (!streakRecord) {
      // Initialize new user streak
      await this.db.query(
        `
        INSERT INTO user_streaks (
          user_id, current_streak, highest_streak, lowest_streak,
          total_active_days, total_streak_cycles, streak_freezes_available,
          streak_freezes_used, last_active_date
        ) VALUES ($1, 1, 1, 1, 1, 1, 1, 0, $2)
        ON CONFLICT (user_id) DO NOTHING
        `,
        [userId, today]
      );

      // Create initial active streak timeline
      await this.db.query(
        `
        INSERT INTO user_streak_timeline (
          user_id, start_date, end_date, days_count,
          questions_solved, exams_completed, is_active, used_freeze
        ) VALUES ($1, $2, $2, 1, $3, $4, true, false)
        `,
        [userId, today, questionsCount, examsCount]
      );

      // Sync users table streak_days
      await this.db.query(
        `UPDATE users SET streak_days = 1 WHERE id = $1`,
        [userId]
      );

      return this.getStreakDetails(userId);
    }

    const lastActive = streakRecord.last_active_date
      ? new Date(streakRecord.last_active_date).toISOString().split('T')[0]
      : null;

    let currentStreak = streakRecord.current_streak;
    let highestStreak = streakRecord.highest_streak;
    let lowestStreak = streakRecord.lowest_streak;
    let totalActiveDays = streakRecord.total_active_days;
    let totalStreakCycles = streakRecord.total_streak_cycles;
    let freezesAvailable = streakRecord.streak_freezes_available;
    let freezesUsed = streakRecord.streak_freezes_used;

    if (!lastActive) {
      currentStreak = 1;
      highestStreak = Math.max(highestStreak, 1);
      lowestStreak = lowestStreak > 0 ? lowestStreak : 1;
      totalActiveDays = 1;
      totalStreakCycles = 1;

      await this.db.query(
        `
        INSERT INTO user_streak_timeline (
          user_id, start_date, end_date, days_count,
          questions_solved, exams_completed, is_active, used_freeze
        ) VALUES ($1, $2, $2, 1, $3, $4, true, false)
        `,
        [userId, today, questionsCount, examsCount]
      );
    } else if (lastActive === today) {
      // Already active today; just increment questions/exams in the active timeline
      await this.db.query(
        `
        UPDATE user_streak_timeline
        SET
          questions_solved = questions_solved + $2,
          exams_completed = exams_completed + $3,
          updated_at = NOW()
        WHERE user_id = $1 AND is_active = true
        `,
        [userId, questionsCount, examsCount]
      );
    } else {
      // Calculate day difference
      const lastDate = new Date(lastActive);
      const currDate = new Date(today);
      const diffTime = currDate.getTime() - lastDate.getTime();
      const diffDays = Math.round(diffTime / (1000 * 3600 * 24));

      if (diffDays === 1) {
        // Consecutive day
        currentStreak += 1;
        highestStreak = Math.max(highestStreak, currentStreak);
        totalActiveDays += 1;

        await this.db.query(
          `
          UPDATE user_streak_timeline
          SET
            end_date = $2,
            days_count = days_count + 1,
            questions_solved = questions_solved + $3,
            exams_completed = exams_completed + $4,
            updated_at = NOW()
          WHERE user_id = $1 AND is_active = true
          `,
          [userId, today, questionsCount, examsCount]
        );
      } else if (diffDays === 2 && freezesAvailable > 0) {
        // Protected by Streak Freeze
        freezesAvailable -= 1;
        freezesUsed += 1;
        currentStreak += 1;
        totalActiveDays += 1;

        await this.db.query(
          `
          UPDATE user_streak_timeline
          SET
            end_date = $2,
            days_count = days_count + 1,
            questions_solved = questions_solved + $3,
            exams_completed = exams_completed + $4,
            used_freeze = true,
            updated_at = NOW()
          WHERE user_id = $1 AND is_active = true
          `,
          [userId, today, questionsCount, examsCount]
        );
      } else {
        // Streak broke
        if (currentStreak > 0) {
          lowestStreak = lowestStreak > 0 ? Math.min(lowestStreak, currentStreak) : currentStreak;
        }

        // Close any open active period
        await this.db.query(
          `
          UPDATE user_streak_timeline
          SET is_active = false, updated_at = NOW()
          WHERE user_id = $1 AND is_active = true
          `,
          [userId]
        );

        // Start fresh streak run
        currentStreak = 1;
        highestStreak = Math.max(highestStreak, 1);
        if (lowestStreak === 0) lowestStreak = 1;
        totalActiveDays += 1;
        totalStreakCycles += 1;

        await this.db.query(
          `
          INSERT INTO user_streak_timeline (
            user_id, start_date, end_date, days_count,
            questions_solved, exams_completed, is_active, used_freeze
          ) VALUES ($1, $2, $2, 1, $3, $4, true, false)
          `,
          [userId, today, questionsCount, examsCount]
        );
      }
    }

    // Update user_streaks
    await this.db.query(
      `
      UPDATE user_streaks
      SET
        current_streak = $2,
        highest_streak = $3,
        lowest_streak = $4,
        total_active_days = $5,
        total_streak_cycles = $6,
        streak_freezes_available = $7,
        streak_freezes_used = $8,
        last_active_date = $9,
        updated_at = NOW()
      WHERE user_id = $1
      `,
      [
        userId,
        currentStreak,
        highestStreak,
        lowestStreak,
        totalActiveDays,
        totalStreakCycles,
        freezesAvailable,
        freezesUsed,
        today,
      ]
    );

    // Sync users table streak_days
    await this.db.query(
      `UPDATE users SET streak_days = $2 WHERE id = $1`,
      [userId, currentStreak]
    );

    return this.getStreakDetails(userId);
  }

  /**
   * Fetch full DB-persisted streak details, history timeline, and current week activity
   */
  async getStreakDetails(userId: string): Promise<UserStreakDetails> {
    let streakRes = await this.db.query(
      `SELECT * FROM user_streaks WHERE user_id = $1`,
      [userId]
    );

    if (streakRes.rows.length === 0) {
      // Seed initial streak record from user profile or submissions
      const userRes = await this.db.query(
        `SELECT streak_days FROM users WHERE id = $1`,
        [userId]
      );
      const baseline = (userRes.rows[0]?.streak_days as number) || 0;

      // Count past submissions to seed totalActiveDays
      const pastSubs = await this.db.query(
        `
        SELECT COUNT(DISTINCT DATE(submitted_at)) as active_days,
               COUNT(*) as total_exams,
               COALESCE(SUM(correct_count + wrong_count), 0) as total_q
        FROM exam_submissions
        WHERE user_id = $1
        `,
        [userId]
      );

      const activeDays = Math.max(
        parseInt(pastSubs.rows[0]?.active_days || '0', 10),
        baseline > 0 ? baseline : 0
      );
      const totalQ = parseInt(pastSubs.rows[0]?.total_q || '0', 10);
      const totalExams = parseInt(pastSubs.rows[0]?.total_exams || '0', 10);

      const today = new Date().toISOString().split('T')[0];

      await this.db.query(
        `
        INSERT INTO user_streaks (
          user_id, current_streak, highest_streak, lowest_streak,
          total_active_days, total_streak_cycles, streak_freezes_available,
          streak_freezes_used, last_active_date
        ) VALUES ($1, $2, $2, $3, $4, $5, 1, 0, $6)
        ON CONFLICT (user_id) DO NOTHING
        `,
        [
          userId,
          baseline,
          baseline > 0 ? baseline : 0,
          activeDays,
          baseline > 0 ? 1 : 0,
          today,
        ]
      );

      if (baseline > 0) {
        const start = new Date();
        start.setDate(start.getDate() - (baseline - 1));
        const startStr = start.toISOString().split('T')[0];

        await this.db.query(
          `
          INSERT INTO user_streak_timeline (
            user_id, start_date, end_date, days_count,
            questions_solved, exams_completed, is_active, used_freeze
          ) VALUES ($1, $2, $3, $4, $5, $6, true, false)
          `,
          [userId, startStr, today, baseline, totalQ || baseline * 15, totalExams || baseline]
        );
      }

      streakRes = await this.db.query(
        `SELECT * FROM user_streaks WHERE user_id = $1`,
        [userId]
      );
    }

    const row = streakRes.rows[0] || {
      current_streak: 0,
      highest_streak: 0,
      lowest_streak: 0,
      total_active_days: 0,
      total_streak_cycles: 0,
      streak_freezes_available: 1,
      streak_freezes_used: 0,
      last_active_date: null,
    };

    // Fetch timeline
    const timelineRes = await this.db.query(
      `
      SELECT id, user_id, start_date, end_date, days_count,
             questions_solved, exams_completed, is_active, used_freeze
      FROM user_streak_timeline
      WHERE user_id = $1
      ORDER BY start_date DESC
      LIMIT 50
      `,
      [userId]
    );

    const timeline: StreakTimelineItem[] = timelineRes.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      startDate: new Date(r.start_date).toISOString().split('T')[0],
      endDate: new Date(r.end_date).toISOString().split('T')[0],
      daysCount: r.days_count,
      questionsSolved: r.questions_solved,
      examsCompleted: r.exams_completed,
      isActive: r.is_active,
      usedFreeze: r.used_freeze,
    }));

    // Fetch weekly activity (Mon to Sun of current week)
    const now = new Date();
    const dayOfWeek = (now.getDay() + 6) % 7; // 0 for Mon, 6 for Sun
    const monday = new Date(now);
    monday.setDate(now.getDate() - dayOfWeek);
    const mondayStr = monday.toISOString().split('T')[0];

    const weeklyRes = await this.db.query(
      `
      SELECT activity_date
      FROM user_daily_activity
      WHERE user_id = $1 AND activity_date >= $2
      `,
      [userId, mondayStr]
    );

    const activeSet = new Set<string>(
      weeklyRes.rows.map((r) => new Date(r.activity_date).toISOString().split('T')[0])
    );

    // If current streak > 0, also count today
    const todayStr = now.toISOString().split('T')[0];
    if (row.current_streak > 0) {
      activeSet.add(todayStr);
    }

    const weeklyDaysActive: boolean[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const ds = d.toISOString().split('T')[0];
      weeklyDaysActive.push(activeSet.has(ds));
    }

    return {
      currentStreak: row.current_streak,
      highestStreak: row.highest_streak,
      lowestStreak: row.lowest_streak,
      totalActiveDays: row.total_active_days,
      totalStreakCycles: row.total_streak_cycles,
      streakFreezesAvailable: row.streak_freezes_available,
      streakFreezesUsed: row.streak_freezes_used,
      lastActiveDate: row.last_active_date
        ? new Date(row.last_active_date).toISOString().split('T')[0]
        : null,
      weeklyDaysActive,
      timeline,
    };
  }
}
