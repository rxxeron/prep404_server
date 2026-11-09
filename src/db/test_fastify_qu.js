require('dotenv').config({ path: 'server/.env' });
const fastify = require('fastify');
const { Pool } = require('pg');
const { RedisService } = require('../../dist/redis/redis.service');
const { examRoutes } = require('../../dist/routes/exam.routes');

async function testFastifyRoutes() {
  const app = fastify();
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const redis = new RedisService();

  await app.register(examRoutes, { db, redis });

  console.log('Testing out-of-app request (no app header)...');
  const res1 = await app.inject({
    method: 'GET',
    url: '/api/v1/qu/nsu-admission-special-cliffs-toefl-grammar-mini-test-01'
  });
  console.log('Status code:', res1.statusCode); // Expected: 403
  console.log('Response:', res1.json());

  console.log('\nTesting valid in-app request with X-Prep404-App-Client header...');
  const res2 = await app.inject({
    method: 'GET',
    url: '/api/v1/qu/nsu-admission-special-cliffs-toefl-grammar-mini-test-01',
    headers: {
      'x-prep404-app-client': 'prep404-mobile-app'
    }
  });
  console.log('Status code:', res2.statusCode); // Expected: 200
  const data = res2.json();
  console.log('Title:          ', data.title);
  console.log('Question Count: ', data.questionCount);
  console.log('Cache header:   ', res2.headers['x-cache-status']);

  console.log('\nTesting second request to verify REDIS CACHE HIT...');
  const res3 = await app.inject({
    method: 'GET',
    url: '/api/v1/qu/nsu-admission-special-cliffs-toefl-grammar-mini-test-01',
    headers: {
      'x-prep404-app-client': 'prep404-mobile-app'
    }
  });
  console.log('Status code:', res3.statusCode);
  console.log('Cache header:   ', res3.headers['x-cache-status']); // Expected: HIT

  await db.end();
}

testFastifyRoutes().catch(console.error);
