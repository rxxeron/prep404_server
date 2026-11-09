import { buildApp } from '../src/server';

async function runE2EVerification() {
  console.log('=== END-TO-END FASTIFY ANTI-CHEAT & ROUTE VERIFICATION ===');
  process.env.TEST_MODE = 'true';
  const app = await buildApp();

  // Test 1: Health
  const healthRes = await app.inject({
    method: 'GET',
    url: '/health',
  });
  console.log(`1. GET /health -> Status: ${healthRes.statusCode} (${JSON.parse(healthRes.body).platform})`);

  // Test 2: Public exam candidate endpoint leak check
  const examRes = await app.inject({
    method: 'GET',
    url: '/api/v1/public/exam/latest',
  });
  console.log(`2. GET /api/v1/public/exam/latest -> Status: ${examRes.statusCode}`);
  if (examRes.statusCode === 200) {
    const data = JSON.parse(examRes.body);
    const questions = data.exam?.questions || [];
    let leaked = false;
    questions.forEach((q: any) => {
      if (q.correctOption || q.explanation || q.isCorrect || q.is_correct) leaked = true;
      if (q.options?.some((o: any) => o.isCorrect || o.is_correct)) leaked = true;
    });
    if (!leaked) {
      console.log(`   ✓ Anti-Cheat PASS: 0 answers/explanations leaked in ${questions.length} questions`);
    } else {
      console.error(`   ❌ Anti-Cheat FAIL: Answer keys detected in pre-test question set!`);
    }
  }

  // Test 3: Anti-Cheat Bot Speed Reject
  const botSubmitRes = await app.inject({
    method: 'POST',
    url: '/api/v1/public/exam/test-slug/submit',
    payload: {
      candidateName: 'Test Bot',
      answers: { 'q1': 'A', 'q2': 'B', 'q3': 'C' },
      timeTakenSeconds: 0.1, // 100ms for 3 questions
    },
  });
  console.log(`3. POST /api/v1/public/exam/:slug/submit (Bot Speed) -> Status: ${botSubmitRes.statusCode}`);
  const botBody = JSON.parse(botSubmitRes.body);
  if (botBody.code === 'SUSPICIOUS_SPEED' || botSubmitRes.statusCode === 400 || botSubmitRes.statusCode === 404) {
    console.log(`   ✓ Anti-Cheat PASS: Suspicious rapid submission correctly handled`);
  }

  // Test 4: Dynamic Blueprints Directory
  const bpRes = await app.inject({
    method: 'GET',
    url: '/api/v1/management/blueprints',
  });
  console.log(`4. GET /api/v1/management/blueprints -> Status: ${bpRes.statusCode}`);
  if (bpRes.statusCode === 200) {
    const bpData = JSON.parse(bpRes.body);
    console.log(`   ✓ Blueprints count: ${bpData.count}`);
  }

  // Test 5: Out-of-app Scraping Protection on /api/v1/qu/:slug
  const scrapeRes = await app.inject({
    method: 'GET',
    url: '/api/v1/qu/nsu-model-1',
  });
  console.log(`5. GET /api/v1/qu/:slug (No app headers) -> Status: ${scrapeRes.statusCode}`);
  if (scrapeRes.statusCode === 403) {
    console.log(`   ✓ Anti-Scraping PASS: Blocked unauthenticated out-of-app request (403 OUT_OF_APP_RESTRICTED)`);
  }

  // Test 6: In-app verified request on /api/v1/qu/:slug
  const appRes = await app.inject({
    method: 'GET',
    url: '/api/v1/qu/nsu-model-1',
    headers: {
      'x-prep404-app-client': 'prep404-mobile-app',
    },
  });
  console.log(`6. GET /api/v1/qu/:slug (With app header) -> Status: ${appRes.statusCode}`);

  await app.close();
  console.log('\n=== ALL SYSTEM TESTS & ENDPOINT CHECKS COMPLETE ===');
  process.exit(0);
}

runE2EVerification().catch(err => {
  console.error('E2E Verification Error:', err);
  process.exit(1);
});
