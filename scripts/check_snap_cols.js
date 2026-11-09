const path = require('path');
const { Client } = require(path.resolve(__dirname, '../node_modules/pg'));
require(path.resolve(__dirname, '../node_modules/dotenv')).config({ path: path.resolve(__dirname, '../.env') });
const client = new Client({ connectionString: process.env.DATABASE_URL });

async function checkCols() {
  await client.connect();
  const res = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'exam_snapshots';");
  console.log('exam_snapshots columns:', res.rows.map(r => r.column_name));
  await client.end();
}
checkCols().catch(console.error);
