require('dotenv').config({ path: '.env' });
process.env.TEST_MODE = 'true';
const { buildApp, db } = require('./dist/server');
(async () => {
  const app = await buildApp();
  try {
    const token = app.jwt.sign({ userId: 'verification', email: 'verification@local', role: 'super_admin' });
    const response = await app.inject({ method: 'GET', url: '/api/v1/management/coverage', headers: { authorization: `Bearer ${token}` } });
    const data = JSON.parse(response.payload);
    process.stdout.write(`Coverage HTTP ${response.statusCode}; topics=${data.totalTopics}; zero=${data.zeroCoverage}; quality=${JSON.stringify(data.qualitySignals)}\n`);
    const shapes = await db.query(`SELECT jsonb_typeof(options) AS type, CASE WHEN jsonb_typeof(options)='array' THEN jsonb_array_length(options)::text ELSE 'n/a' END AS length, count(*)::int AS count FROM public.questions WHERE is_active=true AND review_status='approved' GROUP BY 1,2 ORDER BY 1,2`);
    process.stdout.write(`Option structure counts: ${JSON.stringify(shapes.rows)}\n`);
    if (response.statusCode !== 200 || !data.qualitySignals) process.exitCode = 1;
  } finally { await app.close(); await db.end(); }
})().catch((error) => { process.stdout.write(`Coverage verification failed: ${error.code || error.message}\n`); process.exitCode = 1; });
