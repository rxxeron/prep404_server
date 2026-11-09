const path = require('path');
const { Client } = require(path.resolve(__dirname, '../node_modules/pg'));
require(path.resolve(__dirname, '../node_modules/dotenv')).config({ path: path.resolve(__dirname, '../.env') });
const client = new Client({ connectionString: process.env.DATABASE_URL });

async function verifySnapshots() {
  await client.connect();
  const res = await client.query("SELECT exam_id, slug, title, payload_json FROM exam_snapshots;");
  console.log(`Checking ${res.rows.length} total exam snapshots in DB...`);

  let leakedCount = 0;
  for (const row of res.rows) {
    const jsonStr = JSON.stringify(row.payload_json);
    if (jsonStr.includes('"correctOption"') || jsonStr.includes('"explanation"') || jsonStr.includes('"solution_markdown"') || jsonStr.includes('"is_correct"')) {
      console.warn(`Snapshot ${row.exam_id} (${row.slug}) still has leaks!`);
      leakedCount++;
    }
  }

  if (leakedCount === 0) {
    console.log(`✓ 100% verified: ALL ${res.rows.length} snapshots in the database have zero answer/explanation leaks!`);
  } else {
    console.error(`Found ${leakedCount} leaked snapshots!`);
  }
  await client.end();
}

verifySnapshots().catch(console.error);
