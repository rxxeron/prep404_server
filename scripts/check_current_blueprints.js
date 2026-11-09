const path = require('path');
const { Client } = require(path.resolve(__dirname, '../node_modules/pg'));
require(path.resolve(__dirname, '../node_modules/dotenv')).config({ path: path.resolve(__dirname, '../.env') });
const client = new Client({ connectionString: process.env.DATABASE_URL });
async function check() {
  await client.connect();
  const res = await client.query("SELECT * FROM university_blueprints;");
  console.log(JSON.stringify(res.rows, null, 2));
  await client.end();
}
check().catch(console.error);
