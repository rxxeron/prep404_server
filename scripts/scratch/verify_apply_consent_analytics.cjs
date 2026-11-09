const fs = require('fs'); const path = require('path'); const dotenv = require('dotenv'); const { Client } = require('pg');
dotenv.config({ path: path.join(__dirname, '.env') });
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await db.connect(); await db.query('BEGIN');
    await db.query(fs.readFileSync(path.join(__dirname, 'src/db/migrations/20261030_consent_learner_analytics.sql'), 'utf8'));
    const guard = await db.query(`INSERT INTO public.learner_analytics_events (user_id,event_name)
      SELECT user_id,$2 FROM public.learner_analytics_consent
      WHERE user_id=$1::uuid AND enabled=true FOR SHARE ON CONFLICT DO NOTHING`, ['00000000-0000-0000-0000-000000000000','app_open']);
    const indexes = await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public'
      AND indexname IN ('learner_analytics_events_daily_open_idx','learner_analytics_events_onboarding_once_idx') ORDER BY indexname`);
    if (guard.rowCount !== 0 || indexes.rowCount !== 2) throw new Error('Analytics guard or index verification failed');
    await db.query('COMMIT');
    console.log(JSON.stringify({ optedOutGuardRows: guard.rowCount, dailyAndOnboardingIndexes: indexes.rows.map((row) => row.indexname) }));
  } catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { await db.end(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
