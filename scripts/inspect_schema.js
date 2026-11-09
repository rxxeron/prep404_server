const path = require('path');
const { Client } = require(path.resolve(__dirname, '../node_modules/pg'));
require(path.resolve(__dirname, '../node_modules/dotenv')).config({ path: path.resolve(__dirname, '../.env') });
const client = new Client({ connectionString: process.env.DATABASE_URL });
async function check() {
  await client.connect();
  const ubCols = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'university_blueprints';");
  console.log('university_blueprints columns:', ubCols.rows.map(c => c.column_name));
  const uCols = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'universities';");
  console.log('universities columns:', uCols.rows.map(c => c.column_name));
  const sampleU = await client.query("SELECT * FROM universities LIMIT 3;");
  console.log('Sample universities:', sampleU.rows);
  await client.end();
}
check().catch(console.error);
