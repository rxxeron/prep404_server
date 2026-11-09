const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const logos = {
  NSU: "https://thumb.wikimedia.org/wikipedia/en/thumb/e/e0/North_South_University_Monogram.svg/250px-North_South_University_Monogram.svg.png",
  BRACU: "https://thumb.wikimedia.org/wikipedia/en/thumb/4/40/BRAC_University_monogram.svg/250px-BRAC_University_monogram.svg.png",
  EWU: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/16/East-west-university-LogoSVG.svg/250px-East-west-university-LogoSVG.svg.png",
  AUST: "https://thumb.wikimedia.org/wikipedia/en/thumb/a/ac/Ahsanullah_University_of_Science_and_Technology_Logo.svg/250px-Ahsanullah_University_of_Science_and_Technology_Logo.svg.png",
  AIUB: "https://thumb.wikimedia.org/wikipedia/en/thumb/8/8c/American_International_University-Bangladesh_Monogram.svg/250px-American_International_University-Bangladesh_Monogram.svg.png",
  UIU: "https://thumb.wikimedia.org/wikipedia/en/thumb/6/6b/United_International_University_Monogram.svg/250px-United_International_University_Monogram.svg.png",
  UAP: "https://thumb.wikimedia.org/wikipedia/en/thumb/d/d7/University_of_Asia_Pacific_%28Bangladesh%29_logo.png/250px-University_of_Asia_Pacific_%28Bangladesh%29_logo.png",
  IUB: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/ba/%E0%A6%87%E0%A6%A8%E0%A7%8D%E0%A6%A1%E0%A6%BF%E0%A6%AA%E0%A7%87%E0%A6%A8%E0%A7%8D%E0%A6%A1%E0%A7%87%E0%A6%A8%E0%A7%8D%E0%A6%9F_%E0%A6%AC%E0%A6%BF%E0%A6%B6%E0%A7%8D%E0%A6%AC%E0%A6%AC%E0%A6%BF%E0%A6%A6%E0%A7%8D%E0%A6%AF%E0%A6%BE%E0%A6%B2%E0%A6%AF%E0%A6%BC%2C_%E0%A6%AC%E0%A6%BE%E0%A6%82%E0%A6%B2%E0%A6%BE%E0%A6%A6%E0%A7%87%E0%A6%B6_%E0%A6%B2%E0%A7%8B%E0%A6%97%E0%A7%8B.svg/250px-%E0%A6%87%E0%A6%A8%E0%A7%8D%E0%A6%A1%E0%A6%BF%E0%A6%AA%E0%A7%87%E0%A6%A8%E0%A7%8D%E0%A6%A1%E0%A7%87%E0%A6%A8%E0%A7%8D%E0%A6%9F_%E0%A6%AC%E0%A6%BF%E0%A6%B6%E0%A7%8D%E0%A6%AC%E0%A6%AC%E0%A6%BF%E0%A6%A6%E0%A7%8D%E0%A6%AF%E0%A6%BE%E0%A6%B2%E0%A6%AF%E0%A6%BC%2C_%E0%A6%AC%E0%A6%BE%E0%A6%82%E0%A6%B2%E0%A6%BE%E0%A6%A6%E0%A7%87%E0%A6%B6_%E0%A6%B2%E0%A7%8B%E0%A6%97%E0%A7%8B.svg.png"
};

async function addLogos() {
  const client = await pool.connect();
  try {
    console.log('[Logos Migration] Connecting...');
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE public.universities 
      ADD COLUMN IF NOT EXISTS logo_url TEXT;
    `);

    for (const [code, url] of Object.entries(logos)) {
      await client.query(`
        UPDATE public.universities 
        SET logo_url = $1
        WHERE code = $2;
      `, [url, code]);
    }

    await client.query('COMMIT');
    console.log('[Logos Migration] Successfully saved logos for all universities in database!');

    const res = await client.query('SELECT code, logo_url FROM public.universities ORDER BY code;');
    res.rows.forEach(r => console.log(`  ${r.code}: ${r.logo_url}`));
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

addLogos().catch(console.error);
