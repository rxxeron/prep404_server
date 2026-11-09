const supabaseUrl = 'https://hrgiscymbpqatlzrefrt.supabase.co';
const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || (() => { throw new Error('SUPABASE_ANON_KEY is not set'); })());

async function queryTable(tableName, select = '*') {
  const res = await fetch(`${supabaseUrl}/rest/v1/${tableName}?select=${select}`, {
    headers: {
      'apikey': supabaseAnonKey,
      'Authorization': `Bearer ${supabaseAnonKey}`
    }
  });
  if (!res.ok) {
    const txt = await res.text();
    return { error: `${res.status} ${txt}` };
  }
  const data = await res.json();
  return { data, count: data.length };
}

async function test() {
  for (const table of ['universities', 'admission_test_patterns', 'university_blueprints', 'admission_cycles', 'programs']) {
    const res = await queryTable(table);
    if (res.error) {
      console.log(`${table}: ERROR -> ${res.error}`);
    } else {
      console.log(`${table}: SUCCESS -> ${res.count} rows`);
    }
  }
}

test();
