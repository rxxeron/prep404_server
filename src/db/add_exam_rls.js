const { Pool } = require('pg');
require('dotenv').config({ path: './.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log('Adding RLS policies for exams, exam_questions, exam_submissions, users, etc...');
  
  const queries = [
    `DROP POLICY IF EXISTS "Users are viewable by everyone" ON users;
     DROP POLICY IF EXISTS "Users can insert/update" ON users;
     DROP POLICY IF EXISTS "Exam submissions are viewable by everyone" ON exam_submissions;
     DROP POLICY IF EXISTS "Exam submissions are insertable by everyone" ON exam_submissions;
     DROP POLICY IF EXISTS "Practice progress is viewable and insertable" ON user_practice_progress;`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'exams' AND policyname = 'Exams are viewable by everyone') THEN
        CREATE POLICY "Exams are viewable by everyone" ON exams FOR SELECT USING (true);
      END IF;
    END $$;`,

    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'exam_questions' AND policyname = 'Exam questions are viewable by everyone') THEN
        CREATE POLICY "Exam questions are viewable by everyone" ON exam_questions FOR SELECT USING (true);
      END IF;
    END $$;`,

    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'exam_submissions' AND policyname = 'Exam submissions are insertable by everyone') THEN
        CREATE POLICY "Exam submissions are insertable by everyone" ON exam_submissions FOR INSERT WITH CHECK (auth.uid() = user_id);
      END IF;
    END $$;`,

    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'exam_submissions' AND policyname = 'Exam submissions are viewable by everyone') THEN
        CREATE POLICY "Exam submissions are viewable by everyone" ON exam_submissions FOR SELECT USING (auth.uid() = user_id);
      END IF;
    END $$;`,

    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'users' AND policyname = 'Users are viewable by everyone') THEN
        CREATE POLICY "Users are viewable by everyone" ON users FOR SELECT USING (auth.uid() = id);
      END IF;
    END $$;`,

    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'users' AND policyname = 'Users can insert/update') THEN
        CREATE POLICY "Users can insert/update" ON users FOR ALL USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
      END IF;
    END $$;`,

    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_practice_progress' AND policyname = 'Practice progress is viewable and insertable') THEN
        CREATE POLICY "Practice progress is viewable and insertable" ON user_practice_progress FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
      END IF;
    END $$;`,

    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'leagues' AND policyname = 'Leagues are viewable by everyone') THEN
        CREATE POLICY "Leagues are viewable by everyone" ON leagues FOR SELECT USING (true);
      END IF;
    END $$;`,
  ];

  for (const q of queries) {
    await pool.query(q);
  }
  console.log('✓ All RLS policies successfully applied!');
  await pool.end();
}

run().catch(console.error);
