const { Client } = require('pg');

const connStr = (process.env.DATABASE_URL || (() => { throw new Error('DATABASE_URL is not set'); })());

async function setupAcademicTables() {
  const client = new Client({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('[Setup] Connected to Supabase PostgreSQL database.');

    // 1. Create academic_batches table
    console.log('[Setup] Creating academic_batches table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.academic_batches (
        id VARCHAR(64) PRIMARY KEY,
        curriculum_type VARCHAR(32) NOT NULL,
        exam_level VARCHAR(32) NOT NULL,
        batch_name VARCHAR(64) NOT NULL,
        passing_year INT NOT NULL,
        linked_prerequisite_year INT,
        is_active BOOLEAN DEFAULT TRUE,
        is_appearing BOOLEAN DEFAULT FALSE,
        is_second_timer BOOLEAN DEFAULT FALSE,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_academic_batches_lookup 
      ON public.academic_batches (exam_level, is_active, linked_prerequisite_year);
    `);

    // 2. Create academic_boards table
    console.log('[Setup] Creating academic_boards table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.academic_boards (
        id VARCHAR(64) PRIMARY KEY,
        board_name VARCHAR(128) NOT NULL,
        short_name VARCHAR(64),
        curriculum_type VARCHAR(32) DEFAULT 'ENGLISH_MEDIUM',
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 3. Enable RLS and public read access
    console.log('[Setup] Configuring RLS and Public Read policies...');
    await client.query(`
      ALTER TABLE public.academic_batches ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.academic_boards ENABLE ROW LEVEL SECURITY;

      DROP POLICY IF EXISTS "Public can view active academic_batches" ON public.academic_batches;
      CREATE POLICY "Public can view active academic_batches" 
      ON public.academic_batches FOR SELECT USING (true);

      DROP POLICY IF EXISTS "Public can view active academic_boards" ON public.academic_boards;
      CREATE POLICY "Public can view active academic_boards" 
      ON public.academic_boards FOR SELECT USING (true);

      GRANT SELECT ON public.academic_batches TO anon, authenticated;
      GRANT SELECT ON public.academic_boards TO anon, authenticated;
    `);

    // 4. Seed initial academic_batches
    console.log('[Setup] Seeding initial academic_batches...');
    const batches = [
      // SSC Passing Years
      { id: 'ssc_2024', cur: 'NCTB', lvl: 'SSC', name: '2024', pass: 2024, link: null, act: true, app: false, sec: false, sort: 1 },
      { id: 'ssc_2023', cur: 'NCTB', lvl: 'SSC', name: '2023', pass: 2023, link: null, act: true, app: false, sec: false, sort: 2 },
      { id: 'ssc_2022', cur: 'NCTB', lvl: 'SSC', name: '2022', pass: 2022, link: null, act: true, app: false, sec: false, sort: 3 },
      { id: 'ssc_2021', cur: 'NCTB', lvl: 'SSC', name: '2021', pass: 2021, link: null, act: true, app: false, sec: false, sort: 4 },
      { id: 'ssc_2020', cur: 'NCTB', lvl: 'SSC', name: '2020', pass: 2020, link: null, act: true, app: false, sec: false, sort: 5 },
      { id: 'ssc_2019', cur: 'NCTB', lvl: 'SSC', name: '2019', pass: 2019, link: null, act: true, app: false, sec: false, sort: 6 },

      // HSC Batches
      { id: 'hsc_26_app', cur: 'NCTB', lvl: 'HSC', name: "HSC '26 (Appearing)", pass: 2026, link: 2024, act: true, app: true, sec: false, sort: 1 },
      { id: 'hsc_25', cur: 'NCTB', lvl: 'HSC', name: "HSC '25", pass: 2025, link: 2023, act: true, app: false, sec: false, sort: 2 },
      { id: 'hsc_25_2nd', cur: 'NCTB', lvl: 'HSC', name: "HSC '25 (2nd Time)", pass: 2025, link: 2024, act: true, app: false, sec: true, sort: 3 },
      { id: 'hsc_24', cur: 'NCTB', lvl: 'HSC', name: "HSC '24", pass: 2024, link: 2022, act: true, app: false, sec: false, sort: 4 },
      { id: 'hsc_24_2nd', cur: 'NCTB', lvl: 'HSC', name: "HSC '24 (2nd Time)", pass: 2024, link: 2023, act: true, app: false, sec: true, sort: 5 },
      { id: 'hsc_23_2nd', cur: 'NCTB', lvl: 'HSC', name: "HSC '23 (2nd Time)", pass: 2023, link: 2022, act: true, app: false, sec: true, sort: 6 },

      // O-Level Passing Years
      { id: 'olevel_2024', cur: 'ENGLISH_MEDIUM', lvl: 'O_LEVEL', name: '2024', pass: 2024, link: null, act: true, app: false, sec: false, sort: 1 },
      { id: 'olevel_2023', cur: 'ENGLISH_MEDIUM', lvl: 'O_LEVEL', name: '2023', pass: 2023, link: null, act: true, app: false, sec: false, sort: 2 },
      { id: 'olevel_2022', cur: 'ENGLISH_MEDIUM', lvl: 'O_LEVEL', name: '2022', pass: 2022, link: null, act: true, app: false, sec: false, sort: 3 },
      { id: 'olevel_2021', cur: 'ENGLISH_MEDIUM', lvl: 'O_LEVEL', name: '2021', pass: 2021, link: null, act: true, app: false, sec: false, sort: 4 },
      { id: 'olevel_2020', cur: 'ENGLISH_MEDIUM', lvl: 'O_LEVEL', name: '2020', pass: 2020, link: null, act: true, app: false, sec: false, sort: 5 },
      { id: 'olevel_2019', cur: 'ENGLISH_MEDIUM', lvl: 'O_LEVEL', name: '2019', pass: 2019, link: null, act: true, app: false, sec: false, sort: 6 },

      // A-Level Batches
      { id: 'alevel_26_app', cur: 'ENGLISH_MEDIUM', lvl: 'A_LEVEL', name: "A-Level '26 (Appearing)", pass: 2026, link: 2024, act: true, app: true, sec: false, sort: 1 },
      { id: 'alevel_25', cur: 'ENGLISH_MEDIUM', lvl: 'A_LEVEL', name: "A-Level '25", pass: 2025, link: 2023, act: true, app: false, sec: false, sort: 2 },
      { id: 'alevel_25_2nd', cur: 'ENGLISH_MEDIUM', lvl: 'A_LEVEL', name: "A-Level '25 (2nd Time)", pass: 2025, link: 2024, act: true, app: false, sec: true, sort: 3 },
      { id: 'alevel_24', cur: 'ENGLISH_MEDIUM', lvl: 'A_LEVEL', name: "A-Level '24", pass: 2024, link: 2022, act: true, app: false, sec: false, sort: 4 },
      { id: 'alevel_24_2nd', cur: 'ENGLISH_MEDIUM', lvl: 'A_LEVEL', name: "A-Level '24 (2nd Time)", pass: 2024, link: 2023, act: true, app: false, sec: true, sort: 5 }
    ];

    for (const b of batches) {
      await client.query(`
        INSERT INTO public.academic_batches 
          (id, curriculum_type, exam_level, batch_name, passing_year, linked_prerequisite_year, is_active, is_appearing, is_second_timer, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          batch_name = EXCLUDED.batch_name,
          passing_year = EXCLUDED.passing_year,
          linked_prerequisite_year = EXCLUDED.linked_prerequisite_year,
          is_active = EXCLUDED.is_active,
          is_appearing = EXCLUDED.is_appearing,
          is_second_timer = EXCLUDED.is_second_timer,
          sort_order = EXCLUDED.sort_order,
          updated_at = NOW();
      `, [b.id, b.cur, b.lvl, b.name, b.pass, b.link, b.act, b.app, b.sec, b.sort]);
    }
    console.log(`[Setup] Successfully inserted/updated ${batches.length} academic batches.`);

    // 5. Seed academic_boards
    console.log('[Setup] Seeding academic_boards...');
    const boards = [
      { id: 'cambridge', name: 'Cambridge International', short: 'CAIE', sort: 1 },
      { id: 'edexcel', name: 'Pearson Edexcel', short: 'Edexcel', sort: 2 },
      { id: 'ib', name: 'International Baccalaureate (IB)', short: 'IB', sort: 3 }
    ];

    for (const brd of boards) {
      await client.query(`
        INSERT INTO public.academic_boards (id, board_name, short_name, sort_order)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET
          board_name = EXCLUDED.board_name,
          short_name = EXCLUDED.short_name,
          sort_order = EXCLUDED.sort_order;
      `, [brd.id, brd.name, brd.short, brd.sort]);
    }
    console.log(`[Setup] Successfully inserted/updated ${boards.length} academic boards.`);

    // 6. Verify table rows
    const batchCount = await client.query('SELECT count(*) FROM public.academic_batches;');
    const boardCount = await client.query('SELECT count(*) FROM public.academic_boards;');
    console.log(`[Setup] Verification: academic_batches has ${batchCount.rows[0].count} rows, academic_boards has ${boardCount.rows[0].count} rows.`);

  } catch (err) {
    console.error('[Setup] Error:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

setupAcademicTables();
