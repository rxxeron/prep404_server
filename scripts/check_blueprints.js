const path = require('path');
const { Client } = require(path.resolve(__dirname, '../node_modules/pg'));
require(path.resolve(__dirname, '../node_modules/dotenv')).config({ path: path.resolve(__dirname, '../.env') });
const client = new Client({ connectionString: process.env.DATABASE_URL });
async function check() {
  await client.connect();
  const countRes = await client.query("SELECT COUNT(*) FROM university_blueprints;");
  console.log('university_blueprints count:', countRes.rows[0].count);
  const sample = await client.query("SELECT * FROM university_blueprints LIMIT 2;");
  console.log('Sample blueprint:', sample.rows);
  const uCount = await client.query("SELECT COUNT(*) FROM universities;");
  console.log('universities count:', uCount.rows[0].count);
  await client.end();
}
check().catch(console.error);
