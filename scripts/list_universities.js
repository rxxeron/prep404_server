const path = require('path');
const { Client } = require(path.resolve(__dirname, '../node_modules/pg'));
require(path.resolve(__dirname, '../node_modules/dotenv')).config({ path: path.resolve(__dirname, '../.env') });
const client = new Client({ connectionString: process.env.DATABASE_URL });
async function check() {
  await client.connect();
  const res = await client.query("SELECT id, slug, code, short_name FROM universities;");
  console.log('Universities in DB:', res.rows);
  await client.end();
}
check().catch(console.error);
