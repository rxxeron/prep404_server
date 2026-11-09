const path = require('path');
const { Client } = require(path.resolve(__dirname, '../node_modules/pg'));
require(path.resolve(__dirname, '../node_modules/dotenv')).config({ path: path.resolve(__dirname, '../.env') });
const client = new Client({ connectionString: process.env.DATABASE_URL });
async function check() {
  await client.connect();
  const atpCols = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'admission_test_patterns';");
  console.log('admission_test_patterns columns:', atpCols.rows.map(c => c.column_name));
  const count = await client.query("SELECT COUNT(*) FROM admission_test_patterns;");
  console.log('admission_test_patterns count:', count.rows[0].count);
  await client.end();
}
check().catch(console.error);
